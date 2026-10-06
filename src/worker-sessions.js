import { request } from './bridge.js';
import { sanitize } from './sanitize.js';

const unwrap = (value) => value?.data ?? value;
const options = () => ({ signal: AbortSignal.timeout(10000) });
const sessionPath = (id) => `/api/session/${encodeURIComponent(id)}`;
const denied = ['subagent', 'opencode_jobs_schedule', 'opencode_jobs_loop'];

function owned(session, job) {
  const metadata = session.metadata?.opencodeJobsWorker;
  if (!job.workerID || job.workerID === job.sessionID || session.id !== job.workerID
    || metadata?.jobID !== job.id || metadata.ownerSessionID !== job.sessionID) {
    throw new Error('Рабочая сессия не принадлежит заданию.');
  }
  return metadata;
}

// OpenCode 2.0.22: fork не копирует inbox/time_suspended и не вызывает wake.
// Незавершённые assistant/shell/compaction исключаются projectFork. Оборванный
// prepare может оставить неисполняемый fork; повтор создания запрещает scheduler.
// Допуск: metadata durable + permissions durable -> ID; любой отказ -> exception.
// Наблюдение: pending/нет delivered -> pending; active/старая idle -> running;
// delivered + inactive + новая совпадающая idle -> результат только своего turn.
// Stop: чужой owner -> отказ; свой -> durable terminal -> interrupt -> inbox -> idle.
export function createWorkerSessions(ctx) {
  const get = async (sessionID) => unwrap(await ctx.session.get({ sessionID }, options()));
  const inbox = async (sessionID) => unwrap(await request(`${sessionPath(sessionID)}/inbox`, options()));
  const active = async (sessionID) => Object.hasOwn(unwrap(await request('/api/session/active', options())), sessionID);

  const history = async (job) => {
    const context = unwrap(await ctx.session.context({ sessionID: job.workerID }, options()));
    const index = context.findIndex((message) => message.id === job.runMessage);
    if (index !== -1) return context.slice(index);
    // Context начинается с последней compaction. Полная история остаётся в message API.
    const result = [];
    const seen = new Set();
    const timeout = options();
    let cursor;
    do {
      const query = new URLSearchParams({ order: 'desc', limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const page = await request(`${sessionPath(job.workerID)}/message?${query}`, timeout);
      for (const message of page.data) {
        result.push(message);
        if (message.id === job.runMessage) return result.reverse();
      }
      cursor = page.cursor.next;
      if (cursor && seen.has(cursor)) throw new Error('Повтор курсора истории рабочей сессии.');
      seen.add(cursor);
    } while (cursor);
    throw new Error('Доставленный запрос отсутствует в истории рабочей сессии.');
  };

  const stop = async (job) => {
    const session = await get(job.workerID);
    const metadata = owned(session, job);
    await ctx.session.update({ sessionID: job.workerID, metadata: { ...session.metadata, opencodeJobsWorker: { ...metadata, terminal: true } } }, options());
    await ctx.session.interrupt({ sessionID: job.workerID, resume: false }, options());
    let cleanupError;
    try {
      for (const item of await inbox(job.workerID)) {
        await request(`${sessionPath(job.workerID)}/inbox/${encodeURIComponent(item.id)}`, { method: 'DELETE', ...options() });
      }
    } catch (error) {
      cleanupError = error;
    }
    // Interrupt только инициирует остановку; timeout wait не является успехом.
    await ctx.session.wait({ sessionID: job.workerID }, options());
    if (await active(job.workerID)) throw new Error('Рабочая сессия ещё выполняется.');
    if (cleanupError) throw cleanupError;
    if ((await inbox(job.workerID)).length) throw new Error('В рабочей сессии остались ожидающие сообщения.');
  };

  return {
    async prepare(job) {
      if (!Number.isSafeInteger(job.expiresAt) || job.expiresAt <= 0) throw new Error('Не задан конечный срок рабочей сессии.');
      // Promise plugin ctx 2.0.22 не содержит fork; native client и HTTP его содержат.
      const fork = unwrap(await (ctx.session.fork
        ? ctx.session.fork({ sessionID: job.sessionID }, options())
        : request(`${sessionPath(job.sessionID)}/fork`, { method: 'POST', body: {}, ...options() })));
      if (!fork?.id || fork.id === job.sessionID || fork.fork?.sessionID !== job.sessionID) throw new Error('Не подтверждено происхождение рабочей сессии.');
      const metadata = { ...fork.metadata, opencodeJobsWorker: { jobID: job.id, ownerSessionID: job.sessionID, expiresAt: job.expiresAt, terminal: false } };
      // background/monitor используют permission shell: запрет по их имени не
      // работает. Их и background shell блокирует worker-guards на native hooks.
      const permissions = [...(fork.permissions ?? []), ...denied.map((action) => ({ action, resource: '*', effect: 'deny' }))];
      await ctx.session.update({ sessionID: fork.id, metadata, permissions }, options());
      const configured = await get(fork.id);
      const worker = owned(configured, { ...job, workerID: fork.id });
      if (worker.terminal !== false || worker.expiresAt !== job.expiresAt
        || JSON.stringify(configured.permissions) !== JSON.stringify(permissions)) throw new Error('Настройка рабочей сессии не подтверждена.');
      return fork.id;
    },

    async observe(job) {
      owned(await get(job.workerID), job);
      if (!job.runMessage) return { status: 'pending' };
      if (!Number.isSafeInteger(job.runStartedAt)) throw new Error('Не задано время запуска запроса.');
      if ((await inbox(job.workerID)).some((item) => item.id === job.runMessage)) return { status: 'pending' };
      let delivered;
      try {
        delivered = unwrap(await request(`${sessionPath(job.workerID)}/message/${encodeURIComponent(job.runMessage)}`, options()));
      } catch (error) {
        if (error.message === 'OpenCode: HTTP 404.') return { status: 'pending' };
        throw error;
      }
      if (delivered.id !== job.runMessage || delivered.type !== 'user') throw new Error('Не подтверждена доставка запроса рабочей сессии.');
      if (await active(job.workerID)) return { status: 'running' };
      const session = await get(job.workerID);
      owned(session, job);
      if (!Number.isFinite(session.time.idle) || session.time.idle < job.runStartedAt) return { status: 'running' };
      const messages = await history(job);
      const end = messages.findIndex((message) => message.type === 'idle' && message.time.created === session.time.idle);
      if (end < 0 || messages[end].outcome !== session.outcome) throw new Error('Не подтверждён результат рабочей сессии.');
      const turn = messages.slice(1, end);
      if (turn.some((message) => message.type === 'user')) throw new Error('История рабочей сессии содержит другой запрос.');
      if (await active(job.workerID)) return { status: 'running' };
      const confirmed = await get(job.workerID);
      if (confirmed.time.idle !== session.time.idle || confirmed.outcome !== session.outcome) return { status: 'running' };
      if (session.outcome === 'interrupted') return { status: 'interrupted' };
      const assistant = turn.findLast((message) => message.type === 'assistant');
      if (session.outcome === 'failed') {
        const text = assistant?.error?.message;
        return { status: 'failed', ...(text ? { text: sanitize(text).slice(0, 8000) } : {}) };
      }
      if (session.outcome !== 'succeeded' || !assistant || assistant.error
        || !Number.isFinite(assistant.time.completed) || assistant.time.completed > session.time.idle
        || assistant.time.created < job.runStartedAt) throw new Error('Нет завершённого ответа на запрос рабочей сессии.');
      const text = assistant.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
      return { status: 'succeeded', text: sanitize(text).slice(0, 8000) };
    },

    stop,
  };
}
