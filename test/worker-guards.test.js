import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { installWorkerGuards } from '../src/worker-guards.js';

async function fixture(t, limits = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const hooks = new Map();
  const sessions = new Map([
    ['ses_parent', { id: 'ses_parent', metadata: { unrelated: 'preserve' } }],
    ['ses_worker', { id: 'ses_worker', metadata: { unrelated: 'preserve', opencodeJobsWorker: { jobID: 'job_one', ownerSessionID: 'ses_parent', expiresAt: 10000, terminal: false, ...limits } } }],
  ]);
  const interrupted = [];
  const waited = [];
  const updated = [];
  const hook = (name, callback) => { hooks.set(name, callback); return Promise.resolve({ dispose: async () => hooks.delete(name) }); };
  const ctx = {
    session: {
      hook,
      get: async ({ sessionID }) => structuredClone(sessions.get(sessionID)),
      update: async ({ sessionID, metadata }) => { updated.push(sessionID); sessions.get(sessionID).metadata = structuredClone(metadata); },
      interrupt: async (input) => { interrupted.push(input); return { interrupted: true }; },
      wait: async ({ sessionID }) => { waited.push(sessionID); },
    },
    tool: { hook },
  };
  const cleanup = await installWorkerGuards(ctx);
  return { ctx, sessions, hooks, cleanup, interrupted, waited, updated };
}

test('обычная сессия сохраняет tools, инструкции и shell input', async (t) => {
  const f = await fixture(t);
  const event = { sessionID: 'ses_parent', tools: { subagent: {}, opencode_jobs_loop: {}, shell: {} }, system: [{ type: 'text', text: 'original' }] };
  const before = structuredClone(event);
  await f.hooks.get('context')(event);
  const shell = { sessionID: 'ses_parent', tool: 'shell', input: { background: true, timeout: 0 } };
  await f.hooks.get('execute.before')(shell);
  await f.cleanup();
  assert.deepEqual(event, before);
  assert.deepEqual(shell.input, { background: true, timeout: 0 });
  assert.deepEqual(f.interrupted, []);
});

test('worker скрывает только вложенные запуски, сохраняя инструкции и остальные tools', async (t) => {
  const f = await fixture(t);
  const event = { sessionID: 'ses_worker', tools: { subagent: {}, opencode_jobs_background: {}, opencode_jobs_monitor: {}, opencode_jobs_schedule: {}, opencode_jobs_loop: {}, shell: {}, read: {}, opencode_jobs_jobs: {}, opencode_jobs_cancel: {} }, system: [{ type: 'text', text: 'original' }] };
  await f.hooks.get('context')(event);
  assert.deepEqual(Object.keys(event.tools), ['shell', 'read', 'opencode_jobs_jobs', 'opencode_jobs_cancel']);
  assert.deepEqual(event.system, [{ type: 'text', text: 'original' }]);
  await f.cleanup();
});

for (const tool of ['subagent', 'opencode_jobs_background', 'opencode_jobs_monitor', 'opencode_jobs_schedule', 'opencode_jobs_loop']) {
  test(`worker запрещает прямой вызов ${tool} независимо от каталога`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.hooks.get('execute.before')({ sessionID: 'ses_worker', tool, input: {} }), /запрещ/i);
    await f.cleanup();
  });
}

test('worker запрещает background shell', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.hooks.get('execute.before')({ sessionID: 'ses_worker', tool: 'shell', input: { background: true } }), /фон|background/i);
  await f.cleanup();
});

for (const [timeout, expected] of [[undefined, 9000], [0, 9000], [2000, 2000], [20000, 9000]]) {
  test(`foreground shell ограничивает timeout=${timeout} остатком срока`, async (t) => {
    const f = await fixture(t);
    const event = { sessionID: 'ses_worker', tool: 'shell', input: { command: 'unchanged', timeout, background: false } };
    await f.hooks.get('execute.before')(event);
    assert.equal(event.input.timeout, expected);
    assert.equal(event.input.command, 'unchanged');
    assert.equal(event.input.background, false);
    await f.cleanup();
  });
}

test('foreground shell сохраняет native default 120 секунд при большом остатке', async (t) => {
  const f = await fixture(t, { expiresAt: 200000 });
  const event = { sessionID: 'ses_worker', tool: 'shell', input: { command: 'unchanged' } };
  await f.hooks.get('execute.before')(event);
  assert.equal(event.input.timeout, 120000);
  await f.cleanup();
});

for (const limits of [{ expiresAt: 1000 }, { terminal: true }, { expiresAt: NaN }, { terminal: 'false' }, { ownerSessionID: 'ses_worker' }]) {
  test(`durable gate отклоняет недопустимое состояние ${JSON.stringify(limits)}`, async (t) => {
    const f = await fixture(t, limits);
    await assert.rejects(f.hooks.get('model.request')({ sessionID: 'ses_worker', kind: 'compaction' }));
    await f.cleanup();
  });
}

test('ошибка чтения metadata не допускает model dispatch', async (t) => {
  const f = await fixture(t);
  f.ctx.session.get = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.hooks.get('context')({ sessionID: 'ses_worker', tools: {} }), /storage unavailable/);
  await f.cleanup();
  assert.deepEqual(f.interrupted, []);
});

test('таймер без pump фиксирует terminal, сохраняет metadata и останавливает только worker', async (t) => {
  const f = await fixture(t);
  await f.hooks.get('context')({ sessionID: 'ses_worker', tools: {} });
  t.mock.timers.tick(9000);
  await setImmediate();
  assert.deepEqual(f.interrupted, [{ sessionID: 'ses_worker', resume: false }]);
  assert.deepEqual(f.waited, ['ses_worker']);
  assert.deepEqual(f.sessions.get('ses_worker').metadata, { unrelated: 'preserve', opencodeJobsWorker: { jobID: 'job_one', ownerSessionID: 'ses_parent', expiresAt: 10000, terminal: true } });
  assert.deepEqual(f.sessions.get('ses_parent').metadata, { unrelated: 'preserve' });
  await f.cleanup();
});

test('повторный hook не сдвигает deadline', async (t) => {
  const f = await fixture(t);
  await f.hooks.get('context')({ sessionID: 'ses_worker', tools: {} });
  t.mock.timers.tick(8000);
  await f.hooks.get('model.request')({ sessionID: 'ses_worker', kind: 'primary' });
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(f.interrupted.length, 1);
  await f.cleanup();
});

test('cleanup ждёт завершения собственной отмены и закрывает дальнейшие worker gates', async (t) => {
  const f = await fixture(t);
  await f.hooks.get('context')({ sessionID: 'ses_worker', tools: {} });
  const gate = f.hooks.get('context');
  let settle;
  f.ctx.session.wait = () => new Promise((resolve) => { settle = resolve; });
  let cleaned = false;
  const cleanup = f.cleanup().then(() => { cleaned = true; });
  await setImmediate();
  assert.equal(cleaned, false);
  await assert.rejects(gate({ sessionID: 'ses_worker', tools: {} }), /останов|закрыт/i);
  settle();
  await cleanup;
  assert.equal(cleaned, true);
  assert.deepEqual(f.interrupted, [{ sessionID: 'ses_worker', resume: false }]);
});

test('ошибка timer interrupt наблюдаема, повтор ограничен, cleanup сообщает окончательный отказ', async (t) => {
  const f = await fixture(t);
  const logged = t.mock.method(console, 'error', () => {});
  let attempts = 0;
  f.ctx.session.interrupt = async () => { attempts++; throw new Error('interrupt unavailable'); };
  await f.hooks.get('context')({ sessionID: 'ses_worker', tools: {} });
  t.mock.timers.tick(9000); await setImmediate();
  t.mock.timers.tick(1000); await setImmediate();
  t.mock.timers.tick(1000); await setImmediate();
  t.mock.timers.tick(100000); await setImmediate();
  assert.equal(attempts, 3);
  assert.ok(logged.mock.callCount() > 0);
  await assert.rejects(f.cleanup(), /останов|interrupt/i);
  assert.equal(attempts, 6);
});

test('сбой записи terminal не препятствует остановке worker', async (t) => {
  const f = await fixture(t);
  t.mock.method(console, 'error', () => {});
  f.ctx.session.update = async () => { throw new Error('write unavailable'); };
  await f.hooks.get('context')({ sessionID: 'ses_worker', tools: {} });
  t.mock.timers.tick(9000); await setImmediate();
  assert.deepEqual(f.interrupted, [{ sessionID: 'ses_worker', resume: false }]);
  assert.deepEqual(f.waited, ['ses_worker']);
  await assert.rejects(f.cleanup());
});

test('каждый model request kind проверяет durable terminal после первого dispatch', async (t) => {
  const f = await fixture(t);
  await f.hooks.get('context')({ sessionID: 'ses_worker', tools: {} });
  f.sessions.get('ses_worker').metadata.opencodeJobsWorker.terminal = true;
  for (const kind of ['primary', 'compaction', 'title', 'generate']) {
    await assert.rejects(f.hooks.get('model.request')({ sessionID: 'ses_worker', kind }), /заверш/);
  }
  await assert.rejects(f.hooks.get('execute.before')({ sessionID: 'ses_worker', tool: 'read', input: {} }), /заверш/);
  await f.cleanup();
});

test('cleanup во время чтения metadata не допускает позднее вооружение таймера', async (t) => {
  const f = await fixture(t);
  let resolve;
  f.ctx.session.get = () => new Promise((done) => { resolve = done; });
  const gate = f.hooks.get('context')({ sessionID: 'ses_worker', tools: {} });
  await f.cleanup();
  resolve(structuredClone(f.sessions.get('ses_worker')));
  await assert.rejects(gate, /останов/);
  t.mock.timers.tick(100000);
  await setImmediate();
  assert.deepEqual(f.interrupted, []);
});

test('после временного отказа interrupt таймер повторяет отмену без pump', async (t) => {
  const f = await fixture(t);
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  const interrupt = f.ctx.session.interrupt;
  f.ctx.session.interrupt = async (input) => {
    if (++calls === 1) throw new Error('temporary failure');
    return interrupt(input);
  };
  await f.hooks.get('context')({ sessionID: 'ses_worker', tools: {} });
  t.mock.timers.tick(9000); await setImmediate();
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(calls, 2);
  assert.deepEqual(f.waited, ['ses_worker']);
  await f.cleanup();
});

test('ошибка чтения metadata в таймере не мешает отменить ранее установленного worker', async (t) => {
  const f = await fixture(t);
  t.mock.method(console, 'error', () => {});
  await f.hooks.get('context')({ sessionID: 'ses_worker', tools: {} });
  const get = f.ctx.session.get;
  f.ctx.session.get = async () => { throw new Error('storage unavailable'); };
  t.mock.timers.tick(9000); await setImmediate();
  assert.deepEqual(f.interrupted, [{ sessionID: 'ses_worker', resume: false }]);
  f.ctx.session.get = get;
  await f.cleanup();
  assert.equal(f.sessions.get('ses_worker').metadata.opencodeJobsWorker.terminal, true);
});

test('ошибочные shell timeout не заменяются молча значением по умолчанию', async (t) => {
  const f = await fixture(t);
  for (const timeout of [-1, NaN, Infinity, '1000', null]) {
    await assert.rejects(f.hooks.get('execute.before')({ sessionID: 'ses_worker', tool: 'shell', input: { timeout } }), /timeout/);
  }
  await f.cleanup();
});

test('отдалённый deadline не вызывает переполнение native setTimeout или ранний interrupt', async (t) => {
  const f = await fixture(t, { expiresAt: 2147485000 });
  await f.hooks.get('context')({ sessionID: 'ses_worker', tools: {} });
  t.mock.timers.tick(2147483647); await setImmediate();
  assert.equal(f.interrupted.length, 0);
  t.mock.timers.tick(353); await setImmediate();
  assert.equal(f.interrupted.length, 1);
  await f.cleanup();
});
