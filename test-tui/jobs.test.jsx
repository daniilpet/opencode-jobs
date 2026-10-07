/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from 'bun:test';
import { createSignal, Show, onCleanup } from 'solid-js';
import { testRender } from '@opentui/solid';
import { OpenCode } from '@opencode/client/promise';
import plugin from '../src/tui.jsx';

const renderers = [];
afterEach(() => { for (const renderer of renderers.splice(0)) renderer.destroy(); });

async function screen(jobs = [{ id: 'job_monitor', kind: 'monitor', status: 'active', command: 'watch-build', created: 1000 }], client) {
  const slots = new Map();
  const layers = [];
  const [dialog, setDialog] = createSignal();
  const [sessionID, setSessionID] = createSignal('ses_one');
  const calls = { cancel: [], output: [], navigate: [], list: [] };
  const remote = { jobs, healthy: true, error: false };
  const context = {
    theme: { text: { base: '#ffffff', muted: '#aaaaaa' }, error: '#ff0000' },
    location: { directory: '/fixture' },
    data: { location: { default: () => ({ directory: '/fixture' }) } },
    client: client ?? {
      rpc: () => ({
        list: async (input, options) => { calls.list.push({ input, options }); if (remote.list) return remote.list(input); if (remote.error) throw new Error('offline'); return { jobs: structuredClone(remote.jobs), healthy: remote.healthy }; },
        cancel: async (input) => { calls.cancel.push(input); if (remote.cancel) return remote.cancel(input); const job = remote.jobs.find((item) => item.id === input.id); job.status = 'cancelled'; delete job.runMessage; return { job }; },
      }),
      shell: { output: async (input, options) => { calls.output.push(input); if (remote.output) return remote.output(input, options); return { data: { output: input.cursor === Number.MAX_SAFE_INTEGER ? '' : 'BUILD_OUTPUT_MARKER\n', cursor: 20, size: 20 } }; } },
    },
    keymap: { layer: (factory) => { layers.push(factory); onCleanup(() => layers.splice(layers.indexOf(factory), 1)); } },
    ui: {
      slot: ({ append, render }) => slots.set(append, render),
      dialog: { show: (render) => setDialog(() => render), set: () => {}, clear: () => setDialog(undefined) },
      router: { current: () => ({ type: 'session', sessionID: sessionID() }), navigate: (route) => calls.navigate.push(route) },
    },
  };
  plugin.setup(context);
  const view = await testRender(() => <box flexDirection="column">
    {slots.get('app')?.({})}
    {slots.get('prompt.footer.status')({ get sessionID() { return sessionID(); } })}
    <Show when={dialog()}>{(render) => render()()}</Show>
  </box>, { width: 100, height: 35 });
  renderers.push(view.renderer);
  const click = async (text) => {
    await view.waitForFrame((frame) => frame.includes(text));
    const rows = view.captureCharFrame().split('\n');
    const y = rows.findIndex((row) => row.includes(text));
    await view.mockMouse.click(rows[y].indexOf(text) + 1, y);
    await view.flush();
  };
  const command = (id) => layers.flatMap((factory) => factory().commands ?? []).find((item) => item.id === id);
  return { ...view, click, command, calls, remote, context, setSessionID };
}

test('нижний индикатор открывает список мониторов без запроса к модели', async () => {
  const view = await screen();
  await view.click('Задания:');
  expect(view.captureCharFrame()).toContain('watch-build');
  expect(view.captureCharFrame()).toContain('Монитор');
});

test('локальная команда открывает пустой список и историю', async () => {
  const view = await screen([]);
  view.command('opencode.jobs.open').run();
  await view.waitForFrame((frame) => frame.includes('Активных заданий нет.'));
  expect(view.command('opencode.jobs.open').slash.name).toBe('joblist');
  await view.click('переключить [h]');
  expect(view.captureCharFrame()).toContain('История пуста.');
});

test('исполняемый worker остаётся в списке после завершения планирования', async () => {
  const view = await screen([{ id: 'job_worker', kind: 'schedule', status: 'completed', runMessage: 'msg_run', executionStatus: 'running', workerID: 'ses_worker', prompt: 'review-build', created: 1000 }]);
  await view.click('Задания:');
  await view.click('review-build');
  expect(view.captureCharFrame()).toContain('Выполняется');
  await view.click('Рабочая сессия [o]');
  expect(view.calls.navigate).toEqual([{ type: 'session', sessionID: 'ses_worker' }]);
});

test('выбранная команда показывает захваченный вывод по собственному shell ID', async () => {
  const view = await screen([{ id: 'job_shell', kind: 'background', status: 'active', shellID: 'sh_one', directory: '/original', command: 'build-one', created: 1000 }]);
  await view.click('Задания:');
  await view.click('build-one');
  await view.waitForFrame((frame) => frame.includes('BUILD_OUTPUT_MARKER'));
  expect(view.calls.output.at(-1)).toEqual({ id: 'sh_one', location: { directory: '/original' }, cursor: 0, limit: 32768 });
});

test('обновление заданий не прерывает медленное чтение того же shell', async () => {
  const view = await screen([{ id: 'job_shell', kind: 'background', status: 'active', shellID: 'sh_one', command: 'slow-build', created: 1000 }]);
  let finish;
  let signal;
  view.remote.output = (input, options) => {
    if (input.cursor === Number.MAX_SAFE_INTEGER) return { data: { output: '', cursor: 20, size: 20 } };
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  };
  await view.click('Задания:');
  await view.click('slow-build');
  const firstSignal = signal;
  expect(firstSignal).toBeDefined();
  await view.command('opencode.jobs.refresh').run();
  await view.flush();
  expect(firstSignal.aborted).toBe(false);
  expect(view.calls.output).toHaveLength(2);
  finish({ data: { output: 'SLOW_OUTPUT_MARKER', cursor: 20, size: 20 } });
  await view.waitForFrame((frame) => frame.includes('SLOW_OUTPUT_MARKER'));
  await view.command('opencode.jobs.refresh').run();
  await view.flush();
  expect(view.captureCharFrame()).toContain('SLOW_OUTPUT_MARKER');
  await view.click('Закрыть [esc]');
  expect(firstSignal.aborted).toBe(true);
});

test('остановка затрагивает только выбранную задачу и доступна без pump', async () => {
  const view = await screen([
    { id: 'job_one', kind: 'monitor', status: 'active', command: 'watch-one', created: 2000 },
    { id: 'job_two', kind: 'monitor', status: 'active', command: 'watch-two', created: 1000 },
  ]);
  view.remote.healthy = false;
  await view.click('Задания:');
  await view.click('watch-one');
  await view.click('Остановить [ctrl+x]');
  await view.waitForFrame((frame) => frame.includes('Отменено'));
  expect(view.calls.cancel).toEqual([{ sessionID: 'ses_one', id: 'job_one' }]);
  expect(view.remote.jobs[1].status).toBe('active');
  expect(view.captureCharFrame()).toContain('Планировщик недоступен');
});

test('двойное нажатие не повторяет незавершённую отмену', async () => {
  const view = await screen();
  let finish;
  view.remote.cancel = () => new Promise((resolve) => { finish = resolve; });
  await view.click('Задания:');
  const stop = view.command('opencode.jobs.stop');
  const request = stop.run();
  await stop.run();
  expect(view.calls.cancel).toHaveLength(1);
  finish({ job: view.remote.jobs[0] });
  await request;
});

test('неподтверждённая отмена показывает ошибку и не меняет состояние на отменено', async () => {
  const view = await screen();
  view.remote.cancel = async () => { throw new Error('transport failed'); };
  await view.click('Задания:');
  await view.command('opencode.jobs.stop').run();
  await view.waitForFrame((frame) => frame.includes('Остановка не подтверждена'));
  expect(view.remote.jobs[0].status).toBe('active');
});

test('завершённая задача доступна в истории без действия остановки', async () => {
  const view = await screen([{ id: 'job_done', kind: 'background', status: 'completed', command: 'finished-build', created: 1000 }]);
  view.command('opencode.jobs.open').run();
  await view.waitForFrame((frame) => frame.includes('Активных заданий нет.'));
  await view.click('переключить [h]');
  await view.click('finished-build');
  expect(view.captureCharFrame()).toContain('Завершено');
  expect(view.captureCharFrame()).not.toContain('Остановить [ctrl+x]');
});

test('удалённый host процесс показывает сохранённый краткий вывод вместо вечной загрузки', async () => {
  const view = await screen([{ id: 'job_done', kind: 'monitor', status: 'cancelled', shellID: 'sh_removed', command: 'old-build', preview: ['SAVED_PREVIEW'], created: 1000 }]);
  view.remote.output = async () => { throw new Error('Shell not found'); };
  view.command('opencode.jobs.open').run();
  await view.waitForFrame((frame) => frame.includes('Активных заданий нет.'));
  await view.click('переключить [h]');
  await view.click('old-build');
  await view.waitForFrame((frame) => frame.includes('Не удалось прочитать вывод'));
  expect(view.captureCharFrame()).toContain('SAVED_PREVIEW');
  expect(view.captureCharFrame()).not.toContain('Загрузка вывода');
});

test('сбой чтения помечает сохранённые сведения устаревшими и блокирует остановку', async () => {
  const view = await screen();
  await view.click('Задания:');
  view.remote.error = true;
  await view.command('opencode.jobs.refresh').run();
  await view.flush();
  expect(view.captureCharFrame()).toContain('Сведения могут быть устаревшими');
  expect(view.captureCharFrame()).toContain('watch-build');
  expect(view.captureCharFrame()).not.toContain('Остановить [ctrl+x]');
});

test('401 SDK сохраняет предупреждение авторизации, данные и запрет остановки', async () => {
  const view = await screen();
  await view.click('Задания:');
  view.context.client = OpenCode.make({ baseUrl: 'http://127.0.0.1', fetch: async () => Response.json({ _tag: 'UnauthorizedError', message: 'token=FIXTURE_SECRET' }, { status: 401 }) });
  await view.command('opencode.jobs.refresh').run();
  await view.waitForFrame((frame) => frame.includes('Сервер отклонил авторизацию'));
  expect(view.captureCharFrame()).toContain('Сервер отклонил авторизацию');
  expect(view.captureCharFrame()).toContain('новом клиенте OpenCode');
  expect(view.captureCharFrame()).toContain('Сведения могут быть устаревшими');
  expect(view.captureCharFrame()).toContain('watch-build');
  expect(view.captureCharFrame()).not.toContain('Остановить [ctrl+x]');
  expect(view.captureCharFrame()).not.toContain('FIXTURE_SECRET');
});

test('первая ошибка авторизации не скрывается за загрузкой', async () => {
  const client = OpenCode.make({ baseUrl: 'http://127.0.0.1', fetch: async () => Response.json({ _tag: 'UnauthorizedError' }, { status: 401 }) });
  const view = await screen([], client);
  await view.waitForFrame((frame) => frame.includes('Задания: ошибка авторизации'));
  view.command('opencode.jobs.open').run();
  await view.waitForFrame((frame) => frame.includes('Сервер отклонил авторизацию'));
  expect(view.captureCharFrame()).toContain('Не удалось загрузить задания');
  expect(view.captureCharFrame()).not.toContain('Загрузка заданий');
});

test('ошибка транспорта SDK остаётся предупреждением потери связи', async () => {
  const view = await screen();
  await view.click('Задания:');
  view.context.client = OpenCode.make({ baseUrl: 'http://127.0.0.1', fetch: async () => { throw new TypeError('fetch failed token=FIXTURE_SECRET'); } });
  await view.command('opencode.jobs.refresh').run();
  await view.waitForFrame((frame) => frame.includes('Проверьте состояние службы OpenCode'));
  expect(view.captureCharFrame()).toContain('Связь с сервером потеряна');
  expect(view.captureCharFrame()).not.toContain('Сервер отклонил авторизацию');
  expect(view.captureCharFrame()).not.toContain('FIXTURE_SECRET');
});

test('прочий отказ сервера не объявляется потерей связи или авторизации', async () => {
  const view = await screen();
  await view.click('Задания:');
  view.context.client = OpenCode.make({ baseUrl: 'http://127.0.0.1', fetch: async () => new Response('token=FIXTURE_SECRET', { status: 502 }) });
  await view.command('opencode.jobs.refresh').run();
  await view.waitForFrame((frame) => frame.includes('Не удалось выполнить запрос'));
  expect(view.captureCharFrame()).not.toContain('Связь с сервером потеряна');
  expect(view.captureCharFrame()).not.toContain('Сервер отклонил авторизацию');
  expect(view.captureCharFrame()).not.toContain('FIXTURE_SECRET');
});

test('успешное чтение снимает предупреждение авторизации и возвращает остановку', async () => {
  const view = await screen();
  await view.click('Задания:');
  const original = view.context.client;
  view.context.client = OpenCode.make({ baseUrl: 'http://127.0.0.1', fetch: async () => Response.json({ _tag: 'UnauthorizedError' }, { status: 401 }) });
  await view.command('opencode.jobs.refresh').run();
  await view.waitForFrame((frame) => frame.includes('Сервер отклонил авторизацию'));
  view.context.client = original;
  await view.command('opencode.jobs.refresh').run();
  await view.waitForFrame((frame) => frame.includes('Остановить [ctrl+x]'));
  expect(view.captureCharFrame()).not.toContain('Сервер отклонил авторизацию');
  expect(view.captureCharFrame()).not.toContain('Сведения могут быть устаревшими');
});

test('401 чтения вывода показывает причину и сохранённый текст', async () => {
  const view = await screen([{ id: 'job_shell', kind: 'background', status: 'active', shellID: 'sh_one', command: 'auth-output', preview: ['SAVED_PREVIEW'], created: 1000 }]);
  const client = OpenCode.make({ baseUrl: 'http://127.0.0.1', fetch: async () => Response.json({ _tag: 'UnauthorizedError' }, { status: 401 }) });
  view.remote.output = (input, options) => client.shell.output(input, options);
  await view.click('Задания:');
  await view.click('auth-output');
  await view.waitForFrame((frame) => frame.includes('Сервер отклонил авторизацию'));
  expect(view.captureCharFrame()).toContain('SAVED_PREVIEW');
});

test('401 при остановке показывает причину без ложного подтверждения отмены', async () => {
  const view = await screen();
  await view.click('Задания:');
  view.context.client = OpenCode.make({ baseUrl: 'http://127.0.0.1', fetch: async () => Response.json({ _tag: 'UnauthorizedError' }, { status: 401 }) });
  await view.command('opencode.jobs.stop').run();
  await view.waitForFrame((frame) => frame.includes('Остановка не подтверждена. Сервер отклонил авторизацию'));
  expect(view.remote.jobs[0].status).toBe('active');
});

test('в узком окне предупреждение авторизации вывода не накладывается на соседний текст', async () => {
  const view = await screen([{ id: 'job_12345678-1234-1234-1234-123456789012', kind: 'monitor', status: 'active', shellID: 'sh_one', command: 'watch-build', preview: ['SAVED_PREVIEW'], created: 1000, expiresAt: Date.now() + 60000 }]);
  const client = OpenCode.make({ baseUrl: 'http://127.0.0.1', fetch: async () => Response.json({ _tag: 'UnauthorizedError' }, { status: 401 }) });
  view.remote.output = (input, options) => client.shell.output(input, options);
  view.resize(60, 35);
  await view.click('Задания:');
  await view.click('watch-build');
  await view.waitForFrame((frame) => frame.includes('OpenCode'));
  expect(view.captureCharFrame()).toContain('Сервер отклонил авторизацию');
  expect(view.captureCharFrame()).toContain('Не удалось прочитать вывод.');
  expect(view.captureCharFrame()).toContain('К списку [backspace]');
  expect(view.captureCharFrame()).toContain('Остановить [ctrl+x]');
  expect(view.captureCharFrame()).toContain('Обновить [r]');
});

test('при смене сессии открытое окно закрывается и его запрос отменяется', async () => {
  const view = await screen();
  await view.click('Задания:');
  const signal = view.calls.list.at(-1).options.signal;
  view.setSessionID('ses_two');
  await view.flush();
  expect(signal.aborted).toBe(true);
  expect(view.captureCharFrame()).not.toContain('Задания и мониторы');
});

test('управляющие последовательности и известные секреты не отображаются в названии', async () => {
  const view = await screen([{ id: 'job_secret', kind: 'monitor', status: 'active', command: '\u001b[31mwatch token=FIXTURE_SECRET', created: 1000 }]);
  await view.click('Задания:');
  expect(view.captureCharFrame()).toContain('token=[REDACTED]');
  expect(view.captureCharFrame()).not.toContain('FIXTURE_SECRET');
});

test('подтверждённый результат в процессе завершения нельзя затереть остановкой', async () => {
  const view = await screen([{ id: 'job_result', kind: 'schedule', status: 'completed', runMessage: 'msg_one', workerResult: { status: 'succeeded', text: 'done' }, prompt: 'finish-result', created: 1000 }]);
  await view.click('Задания:');
  await view.click('finish-result');
  expect(view.captureCharFrame()).toContain('Завершается');
  expect(view.captureCharFrame()).not.toContain('Остановить [ctrl+x]');
});

test('в узком терминале сведения и кнопка остановки остаются видимыми', async () => {
  const view = await screen([{ id: 'job_12345678-1234-1234-1234-123456789012', kind: 'monitor', status: 'active', shellID: 'sh_one', command: 'watch-build', created: 1000, expiresAt: Date.now() + 60000 }]);
  await view.click('Задания:');
  await view.click('watch-build');
  view.resize(60, 24);
  await view.flush();
  expect(view.captureCharFrame()).toContain('Монитор');
  expect(view.captureCharFrame()).toContain('Остановить [ctrl+x]');
});
