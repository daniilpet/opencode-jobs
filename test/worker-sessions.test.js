import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerSessions } from '../src/worker-sessions.js';

const job = { id: 'job_owned', sessionID: 'ses_parent', workerID: 'ses_worker', runMessage: 'msg_run', runStartedAt: 200, expiresAt: 2000 };
const ownership = { jobID: job.id, ownerSessionID: job.sessionID, expiresAt: job.expiresAt, terminal: false };
const user = { id: job.runMessage, type: 'user', text: 'Current task', time: { created: 200 } };
const answer = { id: 'msg_answer', type: 'assistant', content: [{ type: 'text', text: 'Current result' }], time: { created: 210, completed: 290 }, finish: 'stop' };
const idle = { id: 'msg_idle', type: 'idle', time: { created: 300 }, outcome: 'succeeded' };

async function fixture(t) {
  const state = {
    session: { id: job.workerID, fork: { sessionID: job.sessionID }, metadata: { retained: 'value', opencodeJobsWorker: { ...ownership } }, permissions: [{ action: 'edit', resource: '*', effect: 'deny' }], time: { created: 100, idle: 300 }, outcome: 'succeeded' },
    inbox: [], active: {}, messages: [user, answer, idle], calls: [], pages: [],
  };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const body = raw ? JSON.parse(raw) : undefined;
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (path === '/api/info') return send({ version: '2.0.22', pid: process.pid });
    state.calls.push({ method: req.method, path, query: url.searchParams.toString(), body });
    if (path === '/api/session/ses_parent/fork') return send({ data: state.session });
    if (path === '/api/session/active') return send({ data: state.active });
    if (path === '/api/session/ses_worker/message/msg_run') return state.delivered === false ? send({}, 404) : send({ data: user });
    if (path === '/api/session/ses_worker/message') return send(state.pages.shift());
    if (path === '/api/session/ses_worker/inbox') return send({ data: state.inbox });
    if (req.method === 'DELETE' && path.startsWith('/api/session/ses_worker/inbox/')) {
      if (state.cancelFailure) return send({}, 500);
      state.inbox = state.inbox.filter((item) => !path.endsWith(`/${item.id}`));
      return send(undefined, 204);
    }
    send({ unexpected: path }, 500);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'jobs-worker-test-'));
  const registration = join(root, 'service.json');
  await writeFile(registration, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, password: 'synthetic-worker-password', pid: process.pid, version: '2.0.22' }));
  const previous = process.env.OPENCODE_JOBS_SERVICE_FILE;
  process.env.OPENCODE_JOBS_SERVICE_FILE = registration;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_JOBS_SERVICE_FILE;
    else process.env.OPENCODE_JOBS_SERVICE_FILE = previous;
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const ctx = { session: {
    get: async () => structuredClone(state.session),
    update: async (input) => {
      state.calls.push({ method: 'update', input });
      if (state.updateFailure) throw new Error('metadata write failed');
      if (input.metadata) state.session.metadata = structuredClone(input.metadata);
      if (input.permissions) state.session.permissions = structuredClone(input.permissions);
    },
    context: async () => structuredClone(state.messages),
    interrupt: async (input) => { state.calls.push({ method: 'interrupt', input }); },
    wait: async (input, options) => {
      state.calls.push({ method: 'wait', input });
      assert.ok(options.signal instanceof AbortSignal);
      if (state.waitFailure) throw new Error('wait timeout');
      if (!state.stillActive) state.active = {};
    },
  } };
  return { state, workers: createWorkerSessions(ctx), ctx };
}

test('prepare возвращает ID только после durable metadata и сохранения базовых permissions', async (t) => {
  const { state, workers } = await fixture(t);
  delete state.session.metadata.opencodeJobsWorker;
  assert.equal(await workers.prepare(job), job.workerID);
  assert.deepEqual(state.session.metadata, { retained: 'value', opencodeJobsWorker: ownership });
  assert.deepEqual(state.session.permissions, [
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'subagent', resource: '*', effect: 'deny' },
    { action: 'opencode_jobs_schedule', resource: '*', effect: 'deny' },
    { action: 'opencode_jobs_loop', resource: '*', effect: 'deny' },
  ]);
  assert.deepEqual(state.calls.map((call) => call.method), ['POST', 'update']);
});

test('ошибка конфигурации не выдаёт worker ID и не dispatch исходного prompt', async (t) => {
  const { state, workers } = await fixture(t);
  state.updateFailure = true;
  await assert.rejects(workers.prepare(job), /metadata write failed/);
  assert.equal(state.calls.filter((call) => call.path?.endsWith('/fork')).length, 1);
  assert.equal(state.calls.some((call) => call.path?.endsWith('/prompt')), false);
});

test('prepare отклоняет fork родительской сессии, не меняя её', async (t) => {
  const { state, workers } = await fixture(t);
  state.session.id = job.sessionID;
  await assert.rejects(workers.prepare(job));
  assert.equal(state.calls.some((call) => call.method === 'update'), false);
});

test('pending own input не завершается по старому результату', async (t) => {
  const { state, workers } = await fixture(t);
  state.inbox = [{ id: job.runMessage }];
  assert.deepEqual(await workers.observe(job), { status: 'pending' });
});

test('отсутствие input в inbox не доказывает доставку', async (t) => {
  const { state, workers } = await fixture(t);
  state.delivered = false;
  assert.deepEqual(await workers.observe(job), { status: 'pending' });
});

test('active worker не считается завершённым при уже записанном assistant', async (t) => {
  const { state, workers } = await fixture(t);
  state.active = { [job.workerID]: { type: 'running' } };
  assert.deepEqual(await workers.observe(job), { status: 'running' });
});

test('idle предыдущей итерации не завершает новую', async (t) => {
  const { state, workers } = await fixture(t);
  state.session.time.idle = job.runStartedAt - 1;
  assert.deepEqual(await workers.observe(job), { status: 'running' });
});

test('result исключает copied parent, reasoning и tool output, очищает и ограничивает текст', async (t) => {
  const { state, workers } = await fixture(t);
  state.messages = [
    { ...answer, id: 'msg_parent', content: [{ type: 'text', text: 'Parent answer' }] }, user,
    { ...answer, content: [{ type: 'reasoning', text: 'Private reasoning' }, { type: 'tool', text: 'Tool output' }, { type: 'text', text: `\u001b[31mtoken=synthetic-secret\n${'a'.repeat(9000)}` }] }, idle,
  ];
  const result = await workers.observe(job);
  assert.equal(result.status, 'succeeded');
  assert.ok(result.text.length <= 8000);
  assert.doesNotMatch(result.text, /Parent|Private|Tool|synthetic-secret|\u001b/);
});

test('compaction скрывшая runMessage использует полную native history с cursor', async (t) => {
  const { state, workers } = await fixture(t);
  state.messages = [answer, idle];
  state.pages = [{ data: [idle, answer], cursor: { next: 'opaque-cursor' } }, { data: [user], cursor: {} }];
  assert.deepEqual(await workers.observe(job), { status: 'succeeded', text: 'Current result' });
  assert.ok(state.calls.some((call) => call.query?.includes('cursor=opaque-cursor')));
});

test('несогласованная idle outcome не считается успехом', async (t) => {
  const { state, workers } = await fixture(t);
  state.messages = [user, answer, { ...idle, outcome: 'failed' }];
  await assert.rejects(workers.observe(job));
});

test('failed outcome не возвращает прежний успешный ответ', async (t) => {
  const { state, workers } = await fixture(t);
  state.session.outcome = 'failed';
  state.messages = [answer, user, { ...idle, outcome: 'failed' }];
  assert.deepEqual(await workers.observe(job), { status: 'failed' });
});

test('interrupt outcome сохраняется даже при частичном assistant', async (t) => {
  const { state, workers } = await fixture(t);
  state.session.outcome = 'interrupted';
  state.messages = [user, { ...answer, time: { created: 210 } }, { ...idle, outcome: 'interrupted' }];
  assert.deepEqual(await workers.observe(job), { status: 'interrupted' });
});

test('следующий чужой user input не присваивается текущему run', async (t) => {
  const { state, workers } = await fixture(t);
  state.messages = [user, { ...user, id: 'msg_other' }, answer, idle];
  await assert.rejects(workers.observe(job));
});

test('stop сохраняет terminal перед interrupt, очищает весь inbox и ждёт idle', async (t) => {
  const { state, workers } = await fixture(t);
  state.inbox = [{ id: 'msg_pending1' }, { id: 'msg_pending2' }];
  state.active = { [job.workerID]: { type: 'running' } };
  await workers.stop(job);
  assert.deepEqual(state.session.metadata, { retained: 'value', opencodeJobsWorker: { ...ownership, terminal: true } });
  assert.deepEqual(state.inbox, []);
  assert.equal(state.calls[0].method, 'update');
  assert.deepEqual(state.calls.find((call) => call.method === 'interrupt').input, { sessionID: job.workerID, resume: false });
  assert.equal(state.calls.some((call) => call.method === 'DELETE' && !call.path.includes('/inbox/')), false);
});

test('stop чужой сессии не меняет metadata и не прерывает её', async (t) => {
  const { state, workers } = await fixture(t);
  state.session.metadata.opencodeJobsWorker.ownerSessionID = 'ses_other';
  await assert.rejects(workers.stop(job));
  assert.deepEqual(state.calls, []);
});

test('ошибка durable terminal не допускает interrupt', async (t) => {
  const { state, workers } = await fixture(t);
  state.updateFailure = true;
  await assert.rejects(workers.stop(job), /metadata write failed/);
  assert.equal(state.calls.some((call) => call.method === 'interrupt'), false);
});

test('timeout ожидания stop остаётся ошибкой cleanup', async (t) => {
  const { state, workers } = await fixture(t);
  state.waitFailure = true;
  await assert.rejects(workers.stop(job), /wait timeout/);
  assert.equal(state.session.metadata.opencodeJobsWorker.terminal, true);
});

test('wait без фактического idle не подтверждает stop', async (t) => {
  const { state, workers } = await fixture(t);
  state.active = { [job.workerID]: { type: 'running' } };
  state.stillActive = true;
  await assert.rejects(workers.stop(job));
});

test('ошибка cancel inbox не мешает interrupt, но stop не объявляется успешным', async (t) => {
  const { state, workers } = await fixture(t);
  state.inbox = [{ id: 'msg_pending1' }];
  state.cancelFailure = true;
  await assert.rejects(workers.stop(job));
  assert.equal(state.calls.some((call) => call.method === 'interrupt'), true);
});
