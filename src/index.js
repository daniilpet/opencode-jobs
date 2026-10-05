import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Jobs } from './contract.js';
import { Scheduler } from './scheduler.js';
import { Monitor } from './monitor.js';
import { parse } from './parser.js';
import { call, request } from './bridge.js';
import { anchorDirectory } from './paths.js';
import { sanitize } from './sanitize.js';

const names = ['background', 'monitor', 'loop', 'schedule', 'jobs', 'cancel'];
const descriptions = {
  background: 'Запустить shell-команду в фоне с проверкой штатных разрешений.',
  monitor: 'Отслеживать совпадения регулярного выражения в выводе shell-команды.',
  loop: 'Периодически передавать запрос в эту сессию; минимум 10 секунд.',
  schedule: 'Передать запрос в эту сессию в назначенное время.',
  jobs: 'Показать задания текущей сессии и состояние планировщика.',
  cancel: 'Отменить задание текущей сессии.',
};
const unwrap = (value) => value?.data ?? value;
const samePath = (left, right) => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

export default {
  id: 'opencode.jobs',
  async setup(ctx) {
    await mkdir(anchorDirectory(), { recursive: true, mode: 0o700 });
    const isAnchor = samePath(ctx.location.directory, anchorDirectory());
    let scheduler;
    let ticks = Promise.resolve();
    const controller = new AbortController();
    const lifetime = controller.signal;
    const ownerKey = Symbol.for('opencode.jobs.anchor');
    const owner = { stop: () => { controller.abort(); scheduler?.close(); }, done: () => Promise.all([ticks.catch(() => {}), scheduler?.serial]) };
    const active = () => {
      lifetime.throwIfAborted();
      if (isAnchor && globalThis[ownerKey] !== owner) throw new Error('Экземпляр планировщика остановлен.');
    };
    const shellRequest = async (job, suffix = '', options = {}) => unwrap(await request(`/api/shell/${job.shellID}${suffix}`, { directory: job.directory, signal: AbortSignal.any([lifetime, AbortSignal.timeout(5000)]), ...options }));
    const inbox = async (sessionID) => unwrap(await request(`/api/session/${sessionID}/inbox`, { signal: AbortSignal.any([lifetime, AbortSignal.timeout(5000)]) }));
    const pending = async (sessionID, id) => {
      try { return (await inbox(sessionID)).some((item) => item.id === id); } catch (error) {
        if (!String(error.message).includes('HTTP 404')) throw error;
        return false;
      }
    };

    if (isAnchor) {
      const previous = globalThis[ownerKey];
      globalThis[ownerKey] = owner;
      previous?.stop();
      await previous?.done();
      scheduler = new Scheduler({
        assertActive: active,
        now: Date.now,
        load: () => ctx.storage.get('state'),
        save: (state) => ctx.storage.set('state', state),
        recoverShell: async (job) => {
          try { await shellRequest(job); return true; } catch (error) {
            if (!String(error.message).includes('HTTP 404')) throw error;
            return false;
          }
        },
        isPending: pending,
        wasAdmitted: async (sessionID, id) => {
          if (await pending(sessionID, id)) return true;
          try { await request(`/api/session/${sessionID}/message/${id}`, { signal: AbortSignal.any([lifetime, AbortSignal.timeout(5000)]) }); return true; } catch (error) {
            if (!String(error.message).includes('HTTP 404')) throw error;
            return false;
          }
        },
        cancelDelivery: async (sessionID, inboxID) => {
          try { await request(`/api/session/${sessionID}/inbox/${inboxID}`, { method: 'DELETE', signal: AbortSignal.any([lifetime, AbortSignal.timeout(5000)]) }); } catch (error) {
            if (!String(error.message).includes('HTTP 404')) throw error;
          }
        },
        deliver: (entry) => {
          const input = { sessionID: entry.sessionID, id: entry.id, text: entry.text, delivery: 'queue', resume: true, metadata: { opencodeJobs: { id: entry.jobID, type: entry.type, due: entry.due, coalesced: entry.coalesced } } };
          return request(`/api/session/${entry.sessionID}/${entry.type === 'prompt' ? 'prompt' : 'synthetic'}`, { method: 'POST', body: entry.type === 'prompt' ? input : { ...input, description: 'OpenCode jobs' }, signal: AbortSignal.any([lifetime, AbortSignal.timeout(5000)]) });
        },
      });
      await scheduler.load(Date.now());
    }

    const poll = async () => {
      for (const job of await scheduler.all()) {
        if (job.status !== 'active' || !job.shellID) continue;
        try {
          const info = await shellRequest(job);
          const ended = info.status !== 'running';
          let cursor = job.cursor ?? 0;
          const page = unwrap(await request(`/api/shell/${job.shellID}/output?cursor=${cursor}&limit=16384`, { directory: job.directory }));
          cursor = page.cursor;
          const preview = sanitize(page.output).split('\n').filter(Boolean).slice(-3);
          let text;
          let monitorState;
          if (job.kind === 'monitor') {
            const monitor = new Monitor(job, job.monitorState);
            text = await monitor.ingest(page.output, Date.now(), ended && cursor >= page.size);
            monitorState = monitor.snapshot();
          }
          await scheduler.consume(job.sessionID, job.id, { cursor, preview, ...(monitorState ? { monitorState } : {}), ...(ended && cursor >= page.size ? { status: info.exit === 0 ? 'completed' : 'failed', exit: info.exit ?? -1, ended: Date.now() } : {}) }, text, Date.now());
        } catch (error) {
          active();
          if (String(error.message).includes('HTTP 404') || /выражени|Worker/.test(error.message)) await scheduler.report(job.sessionID, job.id, sanitize(error.message));
          else await scheduler.update(job.sessionID, job.id, { observationError: sanitize(error.message) });
        }
      }
    };

    const handlers = {
      tick: async () => {
        const result = ticks.then(async () => {
          const status = await scheduler.tick(Date.now());
          await poll();
          return status;
        });
        ticks = result.catch(() => {});
        return result;
      },
      create: async (input) => {
        const session = unwrap(await ctx.session.get({ sessionID: input.sessionID }));
        const config = parse(input.name, input.raw);
        if (!['background', 'monitor', 'loop', 'schedule'].includes(config.kind)) throw new Error('Эта команда не создаёт задания.');
        const job = await scheduler.add(input.sessionID, config, Date.now(), session.location.directory);
        return { job };
      },
      attach: async (input) => {
        if (!/^sh_/.test(input.shellID)) throw new Error('Некорректный shell ID.');
        const job = (await scheduler.list(input.sessionID)).find((item) => item.id === input.id);
        if (!job) throw new Error('Задание не найдено.');
        const info = await request(`/api/shell/${input.shellID}`, { directory: job.directory });
        if (unwrap(info).metadata.sessionID !== input.sessionID) throw new Error('Shell принадлежит другой сессии.');
        const attached = await scheduler.update(input.sessionID, input.id, { shellID: input.shellID });
        if (attached.status === 'cancelled' || attached.status === 'interrupted') await shellRequest(attached, '', { method: 'DELETE' });
        return { job: attached };
      },
      fail: async (input) => {
        await scheduler.report(input.sessionID, input.id, sanitize(input.reason ?? 'Запуск команды не завершён.'));
        return { ok: true };
      },
      list: async (input) => {
        await ctx.session.get({ sessionID: input.sessionID });
        return { jobs: await scheduler.list(input.sessionID), lastTick: scheduler.state.lastTick, healthy: Date.now() - scheduler.state.lastTick < 5000, pending: scheduler.state.outbox.length };
      },
      cancel: async (input) => {
        const job = await scheduler.cancel(input.sessionID, input.id);
        if (job.shellID) await shellRequest(job, '', { method: 'DELETE' });
        return { job };
      },
    };

    await ctx.rpc.register(Jobs, Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (input, context) => {
      active();
      context.signal.throwIfAborted();
      const result = await (isAnchor ? handler(input, context) : call(name, input, AbortSignal.any([lifetime, context.signal])));
      active();
      return result;
    }])));

    await ctx.tool.transform((editor) => {
      for (const name of names) editor.add({
        name: `opencode_jobs_${name}`,
        description: `${descriptions[name]} Задания локальны этому узлу. Сроки сохраняются при перезапуске. При сбое исходный запрос не повторяется автоматически; уведомление требует решения модели.`,
        input: { type: 'object', properties: { raw: { type: 'string', description: 'Исходные аргументы команды; для monitor: --regex <pattern> -- <shell-команда>; schedule: in 5m <запрос>; loop: 5m <запрос>.' } }, ...(name === 'jobs' ? {} : { required: ['raw'] }), additionalProperties: false },
        options: { codemode: false, ...(['background', 'monitor'].includes(name) ? { permission: 'shell' } : {}) },
        async execute(input, context) {
          const config = parse(name, input.raw ?? '');
          if (name === 'jobs') return { content: JSON.stringify(await call('list', { sessionID: context.sessionID }, context.signal)) };
          if (name === 'cancel') return { content: JSON.stringify(await call('cancel', { sessionID: context.sessionID, id: config.id }, context.signal)) };
          const { job } = await call('create', { sessionID: context.sessionID, name, raw: input.raw }, context.signal);
          if (['background', 'monitor'].includes(name)) {
            let startedShell;
            try {
              const native = (await ctx.tool.list()).find((tool) => tool.id === 'shell');
              if (!native) throw new Error('Штатный инструмент shell недоступен; обход разрешений запрещён.');
              const result = await native.execute({ command: config.command, background: true }, {
                ...context,
                progress: async (metadata) => {
                  if (metadata.shellID) {
                    startedShell = metadata.shellID;
                    await call('attach', { sessionID: context.sessionID, id: job.id, shellID: startedShell });
                  }
                  await context.progress(metadata);
                },
              });
              const shellID = result.metadata?.shellID ?? result.output?.shellID;
              if (!shellID) throw new Error('Shell не вернул идентификатор фонового процесса.');
              await call('attach', { sessionID: context.sessionID, id: job.id, shellID }, context.signal);
            } catch (error) {
              if (startedShell) return { content: `Команда уже запущена: ${startedShell}, задание ${job.id}. Регистрация/наблюдение завершились ошибкой: ${sanitize(error.message)}. НЕ повторяйте запуск. Сначала проверьте /jobs и процесс.`, metadata: { jobID: job.id, shellID: startedShell } };
              await call('fail', { sessionID: context.sessionID, id: job.id, reason: error.message }).catch(() => {});
              throw error;
            }
          }
          return { content: `Задание ${job.id} (${name}) создано. Результат придёт в эту сессию автоматически. Не опрашивайте его завершение.`, metadata: { jobID: job.id } };
        },
      });
    });

    await ctx.command.transform((editor) => {
      for (const name of names) editor.add({
        name,
        description: descriptions[name],
        execute: ({ sessionID, prompt, delivery }) => ctx.session.prompt({ ...prompt, sessionID, delivery, text: `Вызови инструмент opencode_jobs_${name}. Передай raw точно как аргументы ниже; для jobs raw пустой. Верни результат, не выполняй задачу повторно другими инструментами.\n\n${prompt.text}` }),
      });
    });
    return () => owner.stop();
  },
};
