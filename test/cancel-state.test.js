import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';
import { hasJobActivity } from '../src/job-activity.js';

function fixture(initial) {
  let saved = initial;
  const sent = new Map();
  const pending = new Set();
  const stopped = [];
  const cancelled = [];
  const scheduler = new Scheduler({
    load: async () => saved,
    save: async (state) => { saved = structuredClone(state); },
    now: () => 100,
    prepareWorker: async (job) => `ses_worker_${job.id}`,
    observeWorker: async () => ({ status: 'running' }),
    stopWorker: async (job) => { stopped.push(job.workerID); },
    stopShell: async (job) => { stopped.push(job.shellID); },
    deliver: async (entry) => { sent.set(entry.id, structuredClone(entry)); pending.add(entry.id); },
    isPending: async (sessionID, id) => pending.has(id),
    wasAdmitted: async (sessionID, id) => sent.has(id),
    cancelDelivery: async (sessionID, id) => { cancelled.push({ sessionID, id }); pending.delete(id); },
  });
  return { scheduler, sent, pending, stopped, cancelled, saved: () => saved };
}

for (const config of [
  { kind: 'schedule', due: 100, prompt: 'work' },
  { kind: 'loop', interval: 10000, maxRuns: 1, prompt: 'work' },
]) {
  test(`${config.kind}: completed с runMessage останавливает только своего worker`, async () => {
    const f = fixture();
    await f.scheduler.load(0);
    const job = await f.scheduler.add('ses_owner', config, 0);
    const other = await f.scheduler.add('ses_other', config, 0);
    await f.scheduler.tick(config.due ?? config.interval);
    const before = await f.scheduler.list('ses_owner');
    const otherBefore = await f.scheduler.list('ses_other');
    assert.equal(before[0].status, 'completed');
    assert.ok(before[0].runMessage);

    const result = await f.scheduler.cancel('ses_owner', job.id);

    assert.equal(result.status, 'cancelled');
    assert.equal(result.runMessage, undefined);
    assert.equal(result.stopPending, undefined);
    assert.deepEqual(f.stopped, [`ses_worker_${job.id}`]);
    assert.deepEqual(f.cancelled, [{ sessionID: `ses_worker_${job.id}`, id: before[0].runMessage }]);
    assert.deepEqual(await f.scheduler.list('ses_other'), otherBefore);
    assert.ok(f.pending.has(otherBefore[0].runMessage));
    assert.equal(otherBefore[0].id, other.id);
  });
}

test('завершение shell в очереди перед cancel сохраняет точный результат и уведомление', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_owner', { kind: 'background', command: 'fixture' }, 0);
  await f.scheduler.attach('ses_owner', job.id, 'sh_owned', 1);

  const completion = f.scheduler.consume('ses_owner', job.id, { status: 'completed', ended: 20, exitCode: 0, cursor: 4 }, 'RESULT', 20);
  const cancellation = f.scheduler.cancel('ses_owner', job.id);
  await completion;
  const before = structuredClone(f.saved());
  const result = await cancellation;

  assert.deepEqual(result, before.jobs[0]);
  assert.deepEqual(f.saved(), before);
  assert.deepEqual(f.stopped, []);
  assert.deepEqual(f.cancelled, []);
});

test('завершённый worker сохраняет результат и ожидающее уведомление при позднем cancel', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_owner', { kind: 'schedule', due: 100, prompt: 'work' }, 0);
  await f.scheduler.tick(100);
  f.pending.clear();
  f.scheduler.io.observeWorker = async () => ({ status: 'succeeded', text: 'RESULT' });
  await f.scheduler.tick(200);
  const before = structuredClone(f.saved());
  assert.equal(before.jobs[0].runMessage, undefined);
  assert.equal(before.jobs[0].executionStatus, 'succeeded');

  const result = await f.scheduler.cancel('ses_owner', job.id);

  assert.deepEqual(result, before.jobs[0]);
  assert.deepEqual(f.saved(), before);
  assert.deepEqual(f.stopped, [`ses_worker_${job.id}`]);
  assert.deepEqual(f.cancelled, []);
  assert.equal([...f.sent.values()].filter((entry) => entry.type === 'result').length, 1);
});

for (const status of ['failed', 'expired', 'interrupted', 'cancelled']) {
  test(`повтор остановки сохраняет исход ${status} и отложенное уведомление`, async () => {
    const f = fixture();
    await f.scheduler.load(0);
    const job = await f.scheduler.add('ses_owner', { kind: 'background', command: 'fixture' }, 0);
    await f.scheduler.attach('ses_owner', job.id, 'sh_owned', 1);
    f.scheduler.io.stopShell = async () => { throw new Error('stop unavailable'); };
    await f.scheduler.report('ses_owner', job.id, 'ORIGINAL_REASON', 20, status);
    const before = structuredClone(f.saved().jobs[0]);
    assert.equal(before.stopPending, true);
    f.scheduler.io.stopShell = async (item) => { f.stopped.push(item.shellID); };

    const result = await f.scheduler.cancel('ses_owner', job.id);

    assert.equal(result.status, before.status);
    assert.equal(result.error, before.error);
    assert.equal(result.ended, before.ended);
    assert.deepEqual(result.deferredFailure, before.deferredFailure);
    assert.equal(result.stopPending, undefined);
    assert.equal(result.cleanupError, undefined);
    assert.deepEqual(f.stopped, ['sh_owned']);
  });
}

test('неподтверждённый повтор остановки сохраняет исходную причину и stopPending', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_owner', { kind: 'monitor', command: 'fixture' }, 0);
  await f.scheduler.attach('ses_owner', job.id, 'sh_owned', 1);
  f.scheduler.io.stopShell = async () => { throw new Error('stop unavailable'); };
  await f.scheduler.report('ses_owner', job.id, 'ORIGINAL_REASON', 20);
  const before = structuredClone(f.saved());

  const result = await f.scheduler.cancel('ses_owner', job.id);

  assert.deepEqual(result, before.jobs[0]);
  assert.deepEqual(f.saved(), before);
});

async function storedResult(config) {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_owner', config, 0);
  const due = config.due ?? config.interval;
  await f.scheduler.tick(due);
  f.pending.clear();
  f.scheduler.io.observeWorker = async () => ({ status: 'succeeded', text: 'STORED_RESULT' });
  const save = f.scheduler.io.save;
  f.scheduler.io.save = async (state) => {
    if (state.outbox.some((entry) => entry.type === 'result')) throw new Error('result delivery save unavailable');
    await save(state);
  };
  await assert.rejects(f.scheduler.tick(due + 1), /result delivery save unavailable/);
  f.scheduler.io.save = save;
  f.scheduler.io.stopLaunch = async () => { f.stopped.push('launch'); };
  return { ...f, job, due };
}

for (const [status, config] of [
  ['completed', { kind: 'schedule', due: 100, prompt: 'work' }],
  ['active', { kind: 'loop', interval: 10000, prompt: 'work' }],
]) {
  test(`${config.kind}: сохранённый success запрещает cancel до финализации без потери результата`, async () => {
    const f = await storedResult(config);
    const before = structuredClone(f.saved());
    const stoppedBefore = [...f.stopped];
    const sentBefore = structuredClone(f.sent);
    assert.equal(before.jobs[0].status, status);
    assert.deepEqual(before.jobs[0].workerResult, { status: 'succeeded', text: 'STORED_RESULT' });
    assert.ok(before.jobs[0].runMessage);
    assert.equal(hasJobActivity(before.jobs[0]), true);

    await assert.rejects(f.scheduler.cancel('ses_owner', f.job.id), /Результат задания уже получен; ожидается завершение обработки/);

    assert.deepEqual(f.saved(), before);
    assert.deepEqual(f.scheduler.state, before);
    assert.deepEqual(f.stopped, stoppedBefore);
    assert.deepEqual(f.cancelled, []);
    assert.deepEqual(f.sent, sentBefore);
  });
}

test('после независимой финализации результата активный цикл снова можно остановить', async () => {
  const f = await storedResult({ kind: 'loop', interval: 10000, prompt: 'work' });
  await assert.rejects(f.scheduler.cancel('ses_owner', f.job.id), /Результат задания уже получен/);
  await f.scheduler.tick(f.due + 2);
  const finalized = await f.scheduler.list('ses_owner');
  assert.equal(finalized[0].status, 'active');
  assert.equal(finalized[0].workerResult, undefined);
  assert.equal(finalized[0].runMessage, undefined);
  assert.match([...f.sent.values()].find((entry) => entry.type === 'result').text, /STORED_RESULT/);

  const result = await f.scheduler.cancel('ses_owner', f.job.id);

  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopPending, undefined);
  assert.deepEqual(f.stopped, ['launch', `ses_worker_${f.job.id}`]);
});

async function loopResult(queued = false) {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_owner', { kind: 'loop', interval: 10000, prompt: 'work' }, 0);
  await f.scheduler.tick(10000);
  f.pending.clear();
  f.scheduler.io.observeWorker = async () => ({ status: 'succeeded', text: 'ITERATION_RESULT' });
  const deliver = f.scheduler.io.deliver;
  f.scheduler.io.deliver = async (entry) => {
    if (queued && entry.type === 'result') throw new Error('delivery unavailable');
    await deliver(entry);
  };
  await f.scheduler.tick(10001);
  const resultID = f.saved().jobs[0].lastMessage;
  return { ...f, job, resultID, deliver };
}

test('отмена цикла сохраняет result в outbox и прекращает будущие итерации', async () => {
  const f = await loopResult(true);
  const before = structuredClone(f.saved().outbox);
  assert.equal(before[0].type, 'result');

  const cancelled = await f.scheduler.cancel('ses_owner', f.job.id);

  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(f.saved().outbox, before);
  assert.deepEqual(cancelled.messages, [f.resultID]);
  f.scheduler.io.deliver = f.deliver;
  await f.scheduler.tick(20000);
  await f.scheduler.tick(30000);
  assert.deepEqual(f.sent.get(f.resultID), before[0]);
  assert.equal([...f.sent.values()].filter((entry) => entry.type === 'prompt').length, 1);
  assert.deepEqual(f.stopped, [`ses_worker_${f.job.id}`]);
  assert.deepEqual(f.cancelled, []);
});

test('отмена цикла сохраняет принятый result в родительском inbox', async () => {
  const f = await loopResult();
  const result = structuredClone(f.sent.get(f.resultID));
  assert.equal(result.type, 'result');
  assert.equal(f.pending.has(f.resultID), true);

  const cancelled = await f.scheduler.cancel('ses_owner', f.job.id);

  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.messages, [f.resultID]);
  assert.equal(f.pending.has(f.resultID), true);
  assert.deepEqual(f.sent.get(f.resultID), result);
  assert.deepEqual(f.cancelled, []);
  await f.scheduler.tick(20000);
  assert.equal([...f.sent.values()].filter((entry) => entry.type === 'prompt').length, 1);
});

test('повтор stopPending и тик сохраняют queued result до подтверждения остановки', async () => {
  const f = await loopResult(true);
  f.scheduler.io.stopWorker = async () => { throw new Error('stop unavailable'); };
  await f.scheduler.cancel('ses_owner', f.job.id);
  const before = structuredClone(f.saved());
  assert.equal(before.jobs[0].stopPending, true);
  assert.equal(before.outbox.length, 1);
  f.scheduler.io.now = () => 20000;

  await f.scheduler.tick(20000);
  const retry = await f.scheduler.cancel('ses_owner', f.job.id);

  assert.equal(retry.stopPending, true);
  assert.equal(retry.ended, before.jobs[0].ended);
  assert.deepEqual(f.saved().outbox, before.outbox);
  assert.deepEqual(retry.messages, [f.resultID]);
  f.scheduler.io.stopWorker = async (job) => { f.stopped.push(job.workerID); };
  f.scheduler.io.deliver = f.deliver;
  await f.scheduler.cancel('ses_owner', f.job.id);
  await f.scheduler.tick(30000);
  assert.deepEqual(f.sent.get(f.resultID), before.outbox[0]);
  assert.equal([...f.sent.values()].filter((entry) => entry.type === 'prompt').length, 1);
});

test('восстановленный cleanup сохраняет parent result и отменяет только текущий worker prompt', async () => {
  const f = fixture({ version: 1, lastTick: 0, outbox: [], jobs: [{
    id: 'job_restore', kind: 'loop', sessionID: 'ses_owner', status: 'cancelled',
    executionMode: 'worker', workerID: 'ses_worker', stopPending: true,
    error: 'Задание отменено.', ended: 100,
    messages: ['msg_result', 'msg_prompt'], messageSessions: { msg_prompt: 'ses_worker' },
    runMessage: 'msg_prompt', lastMessage: 'msg_prompt',
  }] });
  f.pending.add('msg_result');
  f.pending.add('msg_prompt');

  await f.scheduler.load(200);

  assert.deepEqual(f.saved().jobs[0].messages, ['msg_result']);
  assert.equal(f.saved().jobs[0].stopPending, undefined);
  assert.equal(f.saved().jobs[0].runMessage, undefined);
  assert.equal(f.pending.has('msg_result'), true);
  assert.equal(f.pending.has('msg_prompt'), false);
  assert.deepEqual(f.cancelled, [{ sessionID: 'ses_worker', id: 'msg_prompt' }]);
  assert.deepEqual(f.stopped, ['ses_worker']);
});

test('истечение срока цикла по-прежнему снимает принятый parent result', async () => {
  const f = await loopResult();
  const expiresAt = f.saved().jobs[0].expiresAt;

  await f.scheduler.tick(expiresAt);

  assert.equal(f.saved().jobs[0].status, 'expired');
  assert.equal(f.pending.has(f.resultID), false);
  assert.deepEqual(f.cancelled, [{ sessionID: 'ses_owner', id: f.resultID }]);
});

test('legacy сообщения без подтверждённого worker по-прежнему требуют отдельного разбора', async () => {
  const f = fixture({ version: 1, lastTick: 0, outbox: [], jobs: [{
    id: 'job_legacy', kind: 'loop', sessionID: 'ses_owner', status: 'cancelled',
    stopPending: true, messages: ['msg_unknown'],
  }] });
  f.pending.add('msg_unknown');
  const before = structuredClone(f.saved());

  await assert.rejects(f.scheduler.load(200), /отдельный разбор/);

  assert.deepEqual(f.saved(), before);
  assert.deepEqual(f.cancelled, []);
});
