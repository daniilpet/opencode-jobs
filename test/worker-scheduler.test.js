import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';

function fixture(initial) {
  let saved = initial;
  const sent = new Map();
  const prepared = [];
  const stopped = [];
  const pending = new Set();
  let observation = { status: 'running' };
  const scheduler = new Scheduler({
    load: async () => saved,
    save: async (state) => { saved = structuredClone(state); },
    prepareWorker: async (job) => { prepared.push(structuredClone(job)); return `ses_worker_${job.id}`; },
    observeWorker: async () => observation,
    stopWorker: async (job) => { stopped.push(job.workerID); },
    deliver: async (entry) => { sent.set(entry.id, structuredClone(entry)); pending.add(entry.id); },
    isPending: async (sessionID, id) => pending.has(id),
    wasAdmitted: async (sessionID, id) => sent.has(id),
    cancelDelivery: async (sessionID, id) => pending.delete(id),
  });
  return { scheduler, sent, prepared, stopped, pending, saved: () => saved, finish: () => { observation = { status: 'succeeded', text: 'RESULT' }; pending.clear(); } };
}

test('schedule получает runtime deadline только при наступлении назначенного времени', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_parent', { kind: 'schedule', due: 100000000, prompt: 'work', timeout: 1000 }, 0);
  await f.scheduler.tick(5000);
  assert.equal(f.prepared.length, 0);
  await f.scheduler.tick(100000000);
  assert.equal(f.prepared[0].expiresAt, 100001000);
  assert.equal(f.saved().jobs[0].workerID, `ses_worker_${job.id}`);
  assert.equal([...f.sent.values()][0].sessionID, `ses_worker_${job.id}`);
});

test('результат worker возвращается родителю один раз после подтверждённого завершения', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_parent', { kind: 'schedule', due: 10, prompt: 'work' }, 0);
  await f.scheduler.tick(10);
  f.finish();
  await f.scheduler.tick(20);
  await f.scheduler.tick(30);
  const results = [...f.sent.values()].filter((entry) => entry.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionID, 'ses_parent');
  assert.match(results[0].text, /RESULT/);
  assert.equal(f.stopped.length, 1);
});

test('выполняющаяся итерация объединяет тики даже после потребления inbox', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_parent', { kind: 'loop', interval: 10000, prompt: 'work' }, 0);
  await f.scheduler.tick(10000);
  f.pending.clear();
  await f.scheduler.tick(20000);
  assert.equal(f.prepared.length, 1);
  assert.equal(f.sent.size, 1);
  assert.equal(f.saved().jobs[0].coalesced, 1);
});

test('истечение срока останавливает последнюю уже исполняющуюся итерацию цикла', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_parent', { kind: 'loop', interval: 10000, prompt: 'work', maxRuns: 1, timeout: 20000 }, 0);
  await f.scheduler.tick(10000);
  f.pending.clear();
  await f.scheduler.tick(20000);
  assert.equal(f.stopped.length, 1);
  assert.equal(f.saved().jobs[0].status, 'expired');
  assert.equal([...f.sent.values()].filter((entry) => entry.type === 'prompt').length, 1);
});

test('неопределённый ответ создания worker не вызывает повторный fork или prompt', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_parent', { kind: 'schedule', due: 10, prompt: 'NEVER_REPLAY' }, 0);
  let attempts = 0;
  f.scheduler.io.prepareWorker = async () => { attempts++; throw new Error('lost fork response'); };
  await f.scheduler.tick(10);
  const restored = fixture(f.saved());
  await restored.scheduler.load(11);
  await restored.scheduler.tick(12);
  assert.equal(attempts, 1);
  assert.equal(restored.prepared.length, 0);
  assert.ok([...f.sent.values(), ...restored.sent.values()].every((entry) => entry.type !== 'prompt'));
  assert.equal(restored.saved().jobs[0].status, 'failed');
});

test('рестарт сохраняет worker и runtime deadline разового запроса', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_parent', { kind: 'schedule', due: 10, prompt: 'work', timeout: 1000 }, 0);
  await f.scheduler.tick(10);
  const restored = fixture(f.saved());
  await restored.scheduler.load(100);
  await restored.scheduler.tick(1010);
  assert.equal(restored.prepared.length, 0);
  assert.equal(restored.saved().jobs[0].expiresAt, 1010);
  assert.equal(restored.stopped.length, 1);
});

test('legacy prompt родителю требует отдельного разбора до любой новой отправки', async () => {
  const original = { version: 1, lastTick: 0, jobs: [{ id: 'job_old', sessionID: 'ses_parent', kind: 'schedule', status: 'completed', messages: ['msg_old'] }], outbox: [{ id: 'msg_old', jobID: 'job_old', sessionID: 'ses_parent', type: 'prompt', due: 100, text: 'NEVER_OWNER' }] };
  const f = fixture(original);
  await assert.rejects(f.scheduler.load(100), /job_old/);
  assert.deepEqual(f.saved(), original);
  assert.equal(f.sent.size, 0);
  assert.equal(f.prepared.length, 0);
});

test('подтверждённый результат переживает неопределённый ответ остановки и restart', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_parent', { kind: 'schedule', due: 10, prompt: 'work', timeout: 1000 }, 0);
  await f.scheduler.tick(10);
  f.finish();
  f.scheduler.io.stopWorker = async () => { throw new Error('lost stop response'); };
  await f.scheduler.tick(20);
  const restored = fixture(f.saved());
  restored.scheduler.io.observeWorker = async () => ({ status: 'interrupted' });
  await restored.scheduler.load(2000);
  await restored.scheduler.tick(2000);
  const results = [...restored.sent.values()].filter((entry) => entry.type === 'result');
  assert.equal(results.length, 1);
  assert.match(results[0].text, /RESULT/);
  assert.equal(restored.saved().jobs[0].executionStatus, 'succeeded');
});

test('истечение срока внутри fork не отправляет prompt и сообщает родителю', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_parent', { kind: 'schedule', due: 10, prompt: 'NEVER_LATE', timeout: 1000 }, 0);
  f.scheduler.io.prepareWorker = async () => { f.scheduler.io.now = () => 2000; return 'ses_worker'; };
  await f.scheduler.tick(10);
  await f.scheduler.tick(2000);
  const sent = [...f.sent.values()];
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'failure');
  assert.equal(sent[0].sessionID, 'ses_parent');
  assert.equal(f.saved().jobs[0].status, 'expired');
});

test('уведомление нового пропущенного schedule не блокирует восстановление', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_parent', { kind: 'schedule', due: 10, prompt: 'NEVER_LATE' }, 0);
  await f.scheduler.tick(6000);
  const restored = fixture(f.saved());
  await restored.scheduler.load(6001);
  await restored.scheduler.tick(6002);
  assert.equal([...f.sent.values()][0].type, 'failure');
  assert.equal(restored.saved().jobs[0].status, 'missed');
  assert.equal(restored.prepared.length, 0);
});

test('уведомление об отказе fork не блокирует восстановление и не повторяет fork', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_parent', { kind: 'schedule', due: 10, prompt: 'NEVER_REPLAY' }, 0);
  f.scheduler.io.prepareWorker = async () => { throw new Error('lost fork response'); };
  await f.scheduler.tick(10);
  await f.scheduler.tick(11);
  const restored = fixture(f.saved());
  await restored.scheduler.load(12);
  await restored.scheduler.tick(13);
  assert.equal([...f.sent.values()][0].type, 'failure');
  assert.equal(restored.saved().jobs[0].status, 'failed');
  assert.equal(restored.prepared.length, 0);
});

test('старый будущий schedule без доставок безопасно сохраняет новый failure после пропуска', async () => {
  const f = fixture({ version: 1, lastTick: 0, jobs: [{ id: 'job_old_future', sessionID: 'ses_parent', kind: 'schedule', status: 'active', due: 100, prompt: 'NEVER_LATE', sequence: 0 }], outbox: [] });
  await f.scheduler.load(0);
  await f.scheduler.tick(6000);
  const restored = fixture(f.saved());
  await restored.scheduler.load(6001);
  assert.equal([...f.sent.values()][0].type, 'failure');
  assert.equal(restored.saved().jobs[0].status, 'missed');
  assert.equal(restored.prepared.length, 0);
});
