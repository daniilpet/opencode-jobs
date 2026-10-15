import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../src/index.js';

// Сессии: корень без parentID, дочерние с parentID и заголовком.
// create из дочерней -> задание корню (sessionID=root) + createdBy/createdByTitle.
// list/cancel/attach/fail разрешают корень любой сессии цепочки, посторонние изолированы.
// Shell-владение проверяется по сырой сессии запустившего, поиск задания - по корню.
async function fixture(t, sessions) {
  const root = await mkdtemp(join(tmpdir(), 'jobs-attribution-'));
  const previousState = process.env.OPENCODE_JOBS_STATE;
  process.env.OPENCODE_JOBS_STATE = root;
  const shell = { metadata: { sessionID: 'ses_child' }, status: 'running', time: { started: Date.now() } };
  const capture = { output: 'CHILD_RESULT token=FIXTURE_COMPLETION_SECRET' };
  const sent = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/api/info') return send({ version: '2.0.22', pid: process.pid });
    if (url.pathname === '/api/shell/sh_child') return send({ data: shell });
    if (url.pathname === '/api/shell/sh_child/output') return send({ data: { output: capture.output.slice(Number(url.searchParams.get('cursor'))), cursor: capture.output.length, size: capture.output.length } });
    if (/\/api\/session\/[^/]+\/inbox$/.test(url.pathname)) return send({ data: [] });
    if (/\/api\/session\/[^/]+\/synthetic$/.test(url.pathname)) {
      let body = '';
      for await (const part of req) body += part;
      sent.push({ path: url.pathname, input: JSON.parse(body) });
      return send({ data: {} });
    }
    send({ unexpected: url.pathname }, 500);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const registration = join(root, 'service.json');
  await writeFile(registration, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, password: 'synthetic-attribution-password', pid: process.pid, version: '2.0.22' }));
  const previousService = process.env.OPENCODE_JOBS_SERVICE_FILE;
  process.env.OPENCODE_JOBS_SERVICE_FILE = registration;
  const store = new Map();
  const registered = {};
  const noop = () => ({ dispose: async () => {} });
  const known = new Map(Object.entries(sessions));
  const ctx = {
    location: { directory: join(root, 'anchor') },
    storage: { get: async (key) => store.get(key), set: async (key, value) => { store.set(key, structuredClone(value)); } },
    rpc: { register: (contract, handlers) => { Object.assign(registered, handlers); return noop(); } },
    tool: { transform: (fn) => { fn({ add: () => {} }); return noop(); }, hook: noop },
    command: { transform: (fn) => { fn({ add: () => {} }); return noop(); } },
    session: {
      hook: noop,
      get: async ({ sessionID }) => structuredClone(known.get(sessionID)),
      update: async () => {}, interrupt: async () => {}, wait: async () => {},
    },
  };
  const cleanup = await plugin.setup(ctx);
  const call = (name, input) => registered[name](input, { signal: AbortSignal.timeout(10000) });
  t.after(() => {
    if (previousState === undefined) delete process.env.OPENCODE_JOBS_STATE;
    else process.env.OPENCODE_JOBS_STATE = previousState;
    if (previousService === undefined) delete process.env.OPENCODE_JOBS_SERVICE_FILE;
    else process.env.OPENCODE_JOBS_SERVICE_FILE = previousService;
    server.closeAllConnections();
    return Promise.all([new Promise((resolve) => server.close(resolve)), cleanup()]);
  });
  return { call, known, shell, sent, capture };
}

const directory = { directory: 'C:/synthetic/project' };
const plain = (id, extra = {}) => ({ id, title: `Сессия ${id}`, location: directory, ...extra });

test('создание из дочерней сессии атрибутирует задание корню и сохраняет создателя', async (t) => {
  const f = await fixture(t, {
    'ses_root': plain('ses_root'),
    'ses_child': plain('ses_child', { parentID: 'ses_root', title: 'Ревью\nкод' }),
  });
  const { job } = await f.call('create', { sessionID: 'ses_child', name: 'background', raw: 'echo hi' });
  assert.equal(job.sessionID, 'ses_root');
  assert.equal(job.createdBy, 'ses_child');
  assert.equal(job.createdByTitle, 'Ревью код');
});

test('создание из внука атрибутируется корню цепочки', async (t) => {
  const f = await fixture(t, {
    'ses_root': plain('ses_root'),
    'ses_child': plain('ses_child', { parentID: 'ses_root' }),
    'ses_grand': plain('ses_grand', { parentID: 'ses_child' }),
  });
  const { job } = await f.call('create', { sessionID: 'ses_grand', name: 'background', raw: 'echo hi' });
  assert.equal(job.sessionID, 'ses_root');
  assert.equal(job.createdBy, 'ses_grand');
});

test('создание в корне не записывает создателя', async (t) => {
  const f = await fixture(t, { 'ses_root': plain('ses_root') });
  const { job } = await f.call('create', { sessionID: 'ses_root', name: 'background', raw: 'echo hi' });
  assert.equal(job.sessionID, 'ses_root');
  assert.equal('createdBy' in job, false);
  assert.equal('createdByTitle' in job, false);
});

test('list из дочерней видит задания корня, посторонняя сессия изолирована', async (t) => {
  const f = await fixture(t, {
    'ses_root': plain('ses_root'),
    'ses_child': plain('ses_child', { parentID: 'ses_root' }),
    'ses_other': plain('ses_other'),
  });
  const { job } = await f.call('create', { sessionID: 'ses_child', name: 'background', raw: 'echo hi' });
  const fromChild = await f.call('list', { sessionID: 'ses_child' });
  const fromRoot = await f.call('list', { sessionID: 'ses_root' });
  const fromOther = await f.call('list', { sessionID: 'ses_other' });
  assert.deepEqual(fromChild.jobs.map((item) => item.id), [job.id]);
  assert.deepEqual(fromRoot.jobs.map((item) => item.id), [job.id]);
  assert.deepEqual(fromOther.jobs, []);
});

test('cancel из дочерней останавливает задание корня, посторонней сессии отказано', async (t) => {
  const f = await fixture(t, {
    'ses_root': plain('ses_root'),
    'ses_child': plain('ses_child', { parentID: 'ses_root' }),
    'ses_other': plain('ses_other'),
  });
  const { job } = await f.call('create', { sessionID: 'ses_child', name: 'monitor', raw: '--regex x -- echo hi' });
  await assert.rejects(f.call('cancel', { sessionID: 'ses_other', id: job.id }), /принадлежит другой сессии/i);
  const cancelled = await f.call('cancel', { sessionID: 'ses_child', id: job.id });
  assert.equal(cancelled.job.sessionID, 'ses_root');
  assert.equal(cancelled.job.status, 'cancelled');
});

test('attach из дочерней связывает shell владельца с заданием корня', async (t) => {
  const f = await fixture(t, {
    'ses_root': plain('ses_root'),
    'ses_child': plain('ses_child', { parentID: 'ses_root' }),
  });
  const { job } = await f.call('create', { sessionID: 'ses_child', name: 'background', raw: 'echo hi' });
  const attached = await f.call('attach', { sessionID: 'ses_child', id: job.id, shellID: 'sh_child' });
  assert.equal(attached.job.sessionID, 'ses_root');
  assert.equal(attached.job.shellID, 'sh_child');
  await assert.rejects(f.call('attach', { sessionID: 'ses_root', id: job.id, shellID: 'sh_child' }), /Shell принадлежит другой сессии/i);
});

test('недоступный родитель цепочки предотвращает создание и чтение без предположений', async (t) => {
  const f = await fixture(t, {
    'ses_root': plain('ses_root'),
    'ses_child': plain('ses_child', { parentID: 'ses_root' }),
  });
  f.known.delete('ses_root');
  await assert.rejects(f.call('create', { sessionID: 'ses_child', name: 'background', raw: 'echo hi' }));
  await assert.rejects(f.call('list', { sessionID: 'ses_child' }));
});

test('цикл в цепочке родительских сессий отклоняется без предположений', async (t) => {
  const f = await fixture(t, {
    'ses_loop_a': plain('ses_loop_a', { parentID: 'ses_loop_b' }),
    'ses_loop_b': plain('ses_loop_b', { parentID: 'ses_loop_a' }),
  });
  await assert.rejects(f.call('create', { sessionID: 'ses_loop_a', name: 'background', raw: 'echo hi' }), /слишком глубока|Недоступна/i);
  await assert.rejects(f.call('list', { sessionID: 'ses_loop_b' }), /слишком глубока|Недоступна/i);
});

test('fail из дочерней сессии завершает задание корня', async (t) => {
  const f = await fixture(t, {
    'ses_root': plain('ses_root'),
    'ses_child': plain('ses_child', { parentID: 'ses_root' }),
  });
  const { job } = await f.call('create', { sessionID: 'ses_child', name: 'background', raw: 'echo hi' });
  await f.call('fail', { sessionID: 'ses_child', id: job.id, reason: 'Запуск не состоялся.' });
  const { jobs } = await f.call('list', { sessionID: 'ses_root' });
  assert.equal(jobs[0].status, 'failed');
});

test('worker-сессия не создаёт задания независимо от атрибуции', async (t) => {
  const f = await fixture(t, {
    'ses_root': plain('ses_root'),
    'ses_worker_child': plain('ses_worker_child', { parentID: 'ses_root', metadata: { opencodeJobsWorker: { jobID: 'job_one', ownerSessionID: 'ses_root', expiresAt: Date.now() + 60000, terminal: false } } }),
  });
  await assert.rejects(f.call('create', { sessionID: 'ses_worker_child', name: 'background', raw: 'echo hi' }), /вложенные задания/i);
  const fromRoot = await f.call('list', { sessionID: 'ses_root' });
  assert.deepEqual(fromRoot.jobs, []);
});

test('завершение фоновой команды субагента будит корень без пользовательского запроса', async (t) => {
  const f = await fixture(t, {
    'ses_root': plain('ses_root'),
    'ses_child': plain('ses_child', { parentID: 'ses_root' }),
  });
  const { job } = await f.call('create', { sessionID: 'ses_child', name: 'background', raw: 'synthetic command' });
  await f.call('attach', { sessionID: 'ses_child', id: job.id, shellID: 'sh_child' });
  await f.call('tick', {});
  assert.equal(f.sent.length, 0);
  f.shell.status = 'exited';
  f.shell.exit = 0;

  await f.call('tick', {});
  await f.call('tick', {});

  assert.equal((await f.call('list', { sessionID: 'ses_root' })).jobs[0].status, 'completed');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].path, '/api/session/ses_root/synthetic');
  assert.equal(f.sent[0].input.resume, true);
  assert.equal(f.sent[0].input.metadata.opencodeJobs.id, job.id);
  assert.match(f.sent[0].input.text, /CHILD_RESULT/);
  assert.doesNotMatch(f.sent[0].input.text, /FIXTURE_COMPLETION_SECRET/);
});

test('ошибочный exit субагента доставляется корню как failed без повторного исполнения', async (t) => {
  const f = await fixture(t, { 'ses_root': plain('ses_root'), 'ses_child': plain('ses_child', { parentID: 'ses_root' }) });
  const { job } = await f.call('create', { sessionID: 'ses_child', name: 'background', raw: 'synthetic failure' });
  await f.call('attach', { sessionID: 'ses_child', id: job.id, shellID: 'sh_child' });
  f.shell.status = 'exited';
  f.shell.exit = 7;

  await f.call('tick', {});
  await f.call('tick', {});

  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].input.sessionID, 'ses_root');
  assert.match(f.sent[0].input.text, /Статус: failed, код выхода: 7/);
  assert.equal((await f.call('list', { sessionID: 'ses_root' })).jobs[0].status, 'failed');
});

test('завершение background в корне не дублирует штатное уведомление shell', async (t) => {
  const f = await fixture(t, { 'ses_root': plain('ses_root') });
  f.shell.metadata.sessionID = 'ses_root';
  const { job } = await f.call('create', { sessionID: 'ses_root', name: 'background', raw: 'synthetic root command' });
  await f.call('attach', { sessionID: 'ses_root', id: job.id, shellID: 'sh_child' });
  f.shell.status = 'exited';
  f.shell.exit = 0;

  await f.call('tick', {});
  await f.call('tick', {});

  assert.equal((await f.call('list', { sessionID: 'ses_root' })).jobs[0].status, 'completed');
  assert.equal(f.sent.length, 0);
});

test('завершение background не раскрывает продолжение токена между страницами вывода', async (t) => {
  const f = await fixture(t, { 'ses_root': plain('ses_root'), 'ses_child': plain('ses_child', { parentID: 'ses_root' }) });
  const { job } = await f.call('create', { sessionID: 'ses_child', name: 'background', raw: 'synthetic redaction' });
  await f.call('attach', { sessionID: 'ses_child', id: job.id, shellID: 'sh_child' });
  f.capture.output = 'sk-abcdefghijklmnopqrst';
  await f.call('tick', {});
  f.capture.output += 'uvwxyz0123456789\nSAFE_RESULT';
  f.shell.status = 'exited';
  f.shell.exit = 0;

  await f.call('tick', {});
  await f.call('tick', {});

  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].input.text, /SAFE_RESULT/);
  assert.doesNotMatch(f.sent[0].input.text, /abcdefghijklmnopqrst|uvwxyz0123456789/);
});
