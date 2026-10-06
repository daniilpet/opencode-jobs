import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';

function fixture(initial) {
  let snapshot = initial;
  const admitted = new Map();
  const pending = new Set();
  const cancelled = [];
  const stopped = [];
  const scheduler = new Scheduler({
    load: async () => snapshot,
    save: async (state) => { snapshot = structuredClone(state); },
    deliver: async (entry) => { admitted.set(entry.id, structuredClone(entry)); pending.add(entry.id); },
    isPending: async (sessionID, id) => pending.has(id),
    wasAdmitted: async (sessionID, id) => admitted.has(id),
    cancelDelivery: async (sessionID, id) => { cancelled.push(id); pending.delete(id); },
    stopShell: async (job) => { stopped.push(job.shellID); },
    recoverShell: async () => true,
    prepareWorker: async (job) => `ses_worker_${job.id}`,
    observeWorker: async () => ({ status: 'running' }),
    stopWorker: async () => {},
  });
  return { scheduler, admitted, pending, cancelled, stopped, saved: () => snapshot };
}

test('истечение срока останавливает собственный shell и фиксирует причину', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'background', command: 'fixture', timeout: 1000 }, 0);
  await f.scheduler.update('ses_one', job.id, { shellID: 'sh_owned' });
  await f.scheduler.tick(1000);
  assert.deepEqual(f.stopped, ['sh_owned']);
  assert.equal(f.saved().jobs[0].status, 'expired');
  assert.equal(f.admitted.size, 0);
});

test('срок монитора не продлевается рестартом и снимает ожидающие сообщения', async () => {
  const first = fixture();
  await first.scheduler.load(0);
  const job = await first.scheduler.add('ses_one', { kind: 'monitor', command: 'fixture', timeout: 1000 }, 0);
  await first.scheduler.update('ses_one', job.id, { shellID: 'sh_owned' });
  await first.scheduler.output('ses_one', job.id, 'output', 100);
  const second = fixture(first.saved());
  await second.scheduler.load(1000);
  await second.scheduler.tick(1000);
  assert.equal(second.saved().jobs[0].expiresAt, 1000);
  assert.equal(second.saved().jobs[0].status, 'expired');
  assert.deepEqual(second.stopped, ['sh_owned']);
  assert.equal(second.admitted.size, 0);
});

test('цикл прекращает отправки после сохранённого числа срабатываний', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'loop', interval: 10000, prompt: 'bounded', maxRuns: 1 }, 0);
  await f.scheduler.tick(10000);
  f.pending.clear();
  const resumed = fixture(f.saved());
  await resumed.scheduler.load(15000);
  await resumed.scheduler.tick(20000);
  assert.equal(f.admitted.size, 1);
  assert.equal(resumed.admitted.size, 0);
  assert.equal(resumed.saved().jobs[0].runs, 1);
  assert.equal(resumed.saved().jobs[0].status, 'completed');
});

test('срок цикла отменяет принятое но ещё ожидающее срабатывание', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'loop', interval: 10000, prompt: 'bounded', timeout: 20000 }, 0);
  await f.scheduler.tick(10000);
  const id = [...f.pending][0];
  await f.scheduler.tick(20000);
  assert.deepEqual(f.cancelled, [id]);
  assert.equal(f.saved().jobs[0].status, 'expired');
  assert.equal([...f.admitted.values()].filter((entry) => entry.type === 'prompt').length, 1);
  assert.equal([...f.admitted.values()].filter((entry) => entry.type === 'failure').length, 1);
});

test('потерянный ответ admission не расходует дополнительное срабатывание', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'loop', interval: 10000, prompt: 'bounded', maxRuns: 1 }, 0);
  const deliver = f.scheduler.io.deliver;
  f.scheduler.io.deliver = async (entry) => { await deliver(entry); throw new Error('lost ACK'); };
  await f.scheduler.tick(10000);
  f.scheduler.io.deliver = deliver;
  await f.scheduler.tick(16000);
  assert.equal(f.admitted.size, 1);
  assert.equal(f.saved().jobs[0].runs, 1);
  assert.equal(f.saved().jobs[0].status, 'completed');
});

test('старое активное бессрочное задание блокирует обновление без побочных действий', async () => {
  const original = { version: 1, jobs: [{ id: 'job_legacy', kind: 'background', status: 'active', created: 0, shellID: 'sh_old' }], outbox: [], lastTick: 0 };
  const f = fixture(original);
  await assert.rejects(f.scheduler.load(1000), /обновлен|лимит/i);
  assert.deepEqual(f.saved(), original);
  assert.deepEqual(f.stopped, []);
  assert.equal(f.admitted.size, 0);
});

test('сто принятых уведомлений останавливают монитор без сто первого', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'monitor', command: 'fixture' }, 0);
  await f.scheduler.update('ses_one', job.id, { shellID: 'sh_owned' });
  for (let i = 0; i < 101; i++) {
    await f.scheduler.output('ses_one', job.id, 'event', i);
    await f.scheduler.tick(i);
  }
  assert.equal(f.admitted.size, 100);
  assert.equal(f.saved().jobs[0].status, 'failed');
  assert.deepEqual(f.stopped, ['sh_owned']);
  assert.equal(f.pending.size, 0);
});

test('пропуски тиков также ограничены общим числом ожидающих уведомлений', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'loop', interval: 10000, prompt: 'NEVER_LATE' }, 0);
  for (let i = 1; i <= 110; i++) await f.scheduler.tick(i * 20000);
  assert.equal(f.admitted.size, 100);
  assert.equal(f.saved().jobs[0].status, 'failed');
  assert.ok([...f.admitted.values()].every((entry) => entry.type === 'failure'));
});

test('ошибка остановки переживает рестарт и повторяет только остановку процесса', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'background', command: 'NEVER_REPLAY', timeout: 1000 }, 0);
  await f.scheduler.update('ses_one', job.id, { shellID: 'sh_owned' });
  f.scheduler.io.stopShell = async () => { throw new Error('transport unavailable'); };
  await f.scheduler.tick(1000);
  assert.equal(f.saved().jobs[0].stopPending, true);
  const resumed = fixture(f.saved());
  await resumed.scheduler.load(2000);
  assert.deepEqual(resumed.stopped, ['sh_owned']);
  assert.equal(resumed.saved().jobs[0].stopPending, undefined);
  assert.equal(resumed.admitted.size, 0);
});

test('поздний вывод после срока не возрождает задание и не уведомляет модель', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'monitor', command: 'fixture', timeout: 1000 }, 0);
  await f.scheduler.tick(1000);
  await f.scheduler.consume('ses_one', job.id, { status: 'completed', cursor: 1 }, 'late event', 1001);
  await f.scheduler.report('ses_one', job.id, 'late error', 1002);
  assert.equal(f.saved().jobs[0].status, 'expired');
  assert.equal(f.admitted.size, 0);
  assert.deepEqual(f.saved().outbox, []);
});

test('один ожидающий ID в outbox и messages учитывается один раз', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'monitor', command: 'fixture' }, 0);
  for (let i = 0; i < 100; i++) await f.scheduler.output('ses_one', job.id, 'event', i);
  assert.equal(f.scheduler.outstanding(), 100);
  assert.equal(f.saved().outbox.length, 100);
  assert.equal(f.saved().jobs[0].status, 'active');
});

test('задержка сохранения за предел срока не допускает позднюю отправку', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'loop', interval: 10000, prompt: 'NEVER_LATE', timeout: 20000 }, 0);
  f.scheduler.io.now = () => 20000;
  await f.scheduler.tick(10000);
  assert.equal(f.admitted.size, 0);
  assert.equal(f.saved().jobs[0].status, 'expired');
});

test('отказ обновления предшествует восстановлению любых других заданий', async () => {
  const first = fixture();
  await first.scheduler.load(0);
  await first.scheduler.add('ses_one', { kind: 'background', command: 'fixture', timeout: 1000 }, 0);
  const original = structuredClone(first.saved());
  original.jobs.push({ id: 'job_legacy', kind: 'loop', status: 'active', created: 0, due: 10, interval: 10 });
  const next = fixture(original);
  await assert.rejects(next.scheduler.load(2000), /обновлен|лимит/i);
  assert.deepEqual(next.saved(), original);
  assert.deepEqual(next.stopped, []);
});

test('процесс зарегистрированный после истечения срока немедленно останавливается', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'background', command: 'fixture', timeout: 1000 }, 0);
  await f.scheduler.tick(1000);
  await f.scheduler.attach('ses_one', job.id, 'sh_late', 1001);
  assert.deepEqual(f.stopped, ['sh_late']);
  assert.equal(f.saved().jobs[0].status, 'expired');
  assert.equal(f.saved().jobs[0].shellID, 'sh_late');
});

test('ошибка наблюдения останавливает принадлежащий монитору процесс', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'monitor', command: 'fixture' }, 0);
  await f.scheduler.attach('ses_one', job.id, 'sh_owned', 1);
  await f.scheduler.report('ses_one', job.id, 'Worker stopped', 100);
  assert.deepEqual(f.stopped, ['sh_owned']);
  assert.equal(f.saved().jobs[0].status, 'failed');
});

test('старый terminal backlog свыше лимита не создаёт дополнительных admission', async () => {
  const messages = Array.from({ length: 102 }, (_, i) => `msg_old_${i}`);
  const f = fixture({ version: 1, jobs: [{ id: 'job_old', kind: 'monitor', status: 'completed', sessionID: 'ses_one', messages }], outbox: [{ id: messages[101], jobID: 'job_old', sessionID: 'ses_one', text: 'queued', type: 'output', created: 0 }], lastTick: 0 });
  messages.slice(0, 101).forEach((id) => f.pending.add(id));
  await f.scheduler.load(1000);
  await f.scheduler.tick(1000);
  assert.equal(f.admitted.size, 0);
  assert.equal(f.pending.size, 0);
  assert.equal(f.saved().jobs[0].status, 'failed');
});

test('первый тик цикла должен предшествовать окончанию срока', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await assert.rejects(f.scheduler.add('ses_one', { kind: 'loop', interval: 10000, timeout: 10000, prompt: 'never' }, 0), /Интервал/);
  assert.deepEqual(f.saved().jobs, []);
});

test('ожидание разрешения отделено от однократно установленного срока исполнения', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'background', command: 'fixture', timeout: 1000 }, 0);
  await f.scheduler.attach('ses_one', job.id, 'sh_owned', 600, 500);
  await f.scheduler.attach('ses_one', job.id, 'sh_owned', 700, 500);
  assert.equal(f.saved().jobs[0].launchExpiresAt, 1000);
  assert.equal(f.saved().jobs[0].expiresAt, 1500);
  const resumed = fixture(f.saved());
  await resumed.scheduler.load(1000);
  assert.equal(resumed.saved().jobs[0].expiresAt, 1500);
  await resumed.scheduler.tick(1500);
  assert.deepEqual(resumed.stopped, ['sh_owned']);
});

test('ошибка монитора сохраняет владельца уведомления при заполненной истории', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const monitor = await f.scheduler.add('ses_one', { kind: 'monitor', command: 'fixture' }, 0);
  await f.scheduler.attach('ses_one', monitor.id, 'sh_owned', 1);
  for (let i = 0; i < 50; i++) {
    const job = await f.scheduler.add('ses_one', { kind: 'monitor', command: 'fixture' }, i);
    await f.scheduler.consume('ses_one', job.id, { status: 'completed' }, 'fixture', 10 + i);
    await f.scheduler.tick(10 + i);
  }
  await f.scheduler.report('ses_one', monitor.id, 'Worker failure', 100);
  await f.scheduler.tick(101);
  assert.ok(f.saved().jobs.some((job) => job.id === monitor.id));
  assert.ok([...f.admitted.values()].some((entry) => entry.jobID === monitor.id && entry.type === 'failure'));
});

test('attach проверяет часы после ожидания очереди сериализации', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'background', command: 'fixture', timeout: 1000 }, 0);
  f.scheduler.io.now = () => 1500;
  await f.scheduler.attach('ses_one', job.id, 'sh_owned', 200, 100);
  assert.equal(f.saved().jobs[0].expiresAt, 1100);
  assert.equal(f.saved().jobs[0].status, 'expired');
  assert.deepEqual(f.stopped, ['sh_owned']);
});

test('замена anchor отменяет ещё живое ожидание запуска без shell ID', async () => {
  const first = fixture();
  await first.scheduler.load(0);
  await first.scheduler.add('ses_one', { kind: 'background', command: 'fixture' }, 0);
  const restored = fixture(first.saved());
  let aborted = false;
  restored.scheduler.io.stopLaunch = async () => { aborted = true; };
  await restored.scheduler.load(100);
  assert.equal(aborted, true);
  assert.equal(restored.saved().jobs[0].status, 'interrupted');
});

test('повторный attach сохраняет ожидающее уведомление об ошибке', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'monitor', command: 'fixture' }, 0);
  await f.scheduler.attach('ses_one', job.id, 'sh_owned', 1);
  f.scheduler.io.stopLaunch = async () => { throw new Error('waiting for abort'); };
  await f.scheduler.report('ses_one', job.id, 'Worker failure', 2);
  await f.scheduler.attach('ses_one', job.id, 'sh_owned', 3);
  f.scheduler.io.stopLaunch = async () => {};
  await f.scheduler.tick(4);
  assert.ok([...f.admitted.values()].some((entry) => entry.jobID === job.id && entry.type === 'failure'));
});
