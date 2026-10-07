import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';

function fixture(initial) {
  const messages = [];
  const cancelled = [];
  let snapshot = initial;
  let reject = false;
  const pending = new Set();
  const scheduler = new Scheduler({
    load: async () => snapshot,
    save: async (value) => { snapshot = structuredClone(value); },
    prepareWorker: async (job) => `ses_worker_${job.id}`,
    observeWorker: async () => ({ status: 'running' }),
    stopWorker: async () => {},
    deliver: async (value) => {
      if (reject) throw new Error('transport unavailable');
      if (!messages.some((item) => item.id === value.id)) messages.push(value);
    },
    isPending: async (sessionID, id) => pending.has(id),
    wasAdmitted: async (sessionID, id) => messages.some((item) => item.id === id),
    cancelDelivery: async (sessionID, id) => { cancelled.push(id); },
  });
  return { scheduler, messages, pending, cancelled, saved: () => snapshot, reject: (value) => { reject = value; } };
}

test('разовый запрос доставляется в отдельную сессию ровно один раз', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'schedule', due: 2000, prompt: 'проверь' }, 0);
  await f.scheduler.tick(2000);
  await f.scheduler.tick(3000);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].sessionID, `ses_worker_${job.id}`);
  assert.equal((await f.scheduler.list('ses_one'))[0].id, job.id);
});

test('до срока запрос не доставляется', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'schedule', due: 2000, prompt: 'проверь' }, 0);
  await f.scheduler.tick(1000);
  assert.equal(f.messages.length, 0);
});

test('срок в будущем сохраняется после рестарта', async () => {
  const first = fixture();
  await first.scheduler.load(0);
  await first.scheduler.add('ses_one', { kind: 'schedule', due: 3000, prompt: 'проверь' }, 0);
  const second = fixture(first.saved());
  await second.scheduler.load(1000);
  await second.scheduler.tick(3000);
  assert.equal(second.messages[0].text, 'проверь');
});

test('пропущенный при остановке срок сообщает о сбое без исполнения запроса', async () => {
  const first = fixture();
  await first.scheduler.load(0);
  await first.scheduler.add('ses_one', { kind: 'schedule', due: 2000, prompt: 'НЕ ВЫПОЛНЯТЬ' }, 0);
  const second = fixture(first.saved());
  await second.scheduler.load(4000);
  await second.scheduler.tick(4000);
  assert.equal(second.messages[0].type, 'failure');
  assert.match(second.messages[0].text, /пропущен/i);
  assert.doesNotMatch(second.messages[0].text, /НЕ ВЫПОЛНЯТЬ/);
});

test('долгая пауза живого процесса также отмечает пропуск', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'schedule', due: 2000, prompt: 'НЕ ВЫПОЛНЯТЬ' }, 0);
  await f.scheduler.tick(20000);
  assert.equal(f.messages[0].type, 'failure');
});

test('отмена исключает будущий запуск', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'schedule', due: 2000, prompt: 'проверь' }, 0);
  await f.scheduler.cancel('ses_one', job.id);
  await f.scheduler.tick(2000);
  assert.equal(f.messages.length, 0);
});

test('чужая сессия не видит и не отменяет задание', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'schedule', due: 2000, prompt: 'проверь' }, 0);
  assert.deepEqual(await f.scheduler.list('ses_two'), []);
  await assert.rejects(f.scheduler.cancel('ses_two', job.id), /другой сессии/);
});

test('повтор после ошибки транспорта сохраняет идентификатор сообщения', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'schedule', due: 2000, prompt: 'проверь' }, 0);
  f.reject(true);
  await f.scheduler.tick(2000);
  const id = f.saved().outbox[0].id;
  f.reject(false);
  await f.scheduler.tick(3000);
  assert.equal(f.messages[0].id, id);
});

test('цикл объединяет тики пока предыдущее сообщение ещё в очереди', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'loop', interval: 10000, prompt: 'проверь' }, 0);
  await f.scheduler.tick(10000);
  f.pending.add(f.messages[0].id);
  await f.scheduler.tick(20000);
  await f.scheduler.tick(30000);
  assert.equal(f.messages.length, 1);
  assert.equal((await f.scheduler.list('ses_one'))[0].coalesced, 2);
});

test('отмена удаляет ещё не доставленное сообщение цикла из очереди', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'loop', interval: 10000, prompt: 'проверь' }, 0);
  await f.scheduler.tick(10000);
  f.pending.add(f.messages[0].id);
  await f.scheduler.cancel('ses_one', job.id);
  assert.deepEqual(f.cancelled, [f.messages[0].id]);
});

test('при восстановлении прерванная shell-команда не повторяется', async () => {
  const first = fixture();
  await first.scheduler.load(0);
  await first.scheduler.add('ses_one', { kind: 'background', command: 'NO_REPLAY' }, 0);
  const second = fixture(first.saved());
  await second.scheduler.load(2000);
  await second.scheduler.tick(2000);
  assert.equal((await second.scheduler.list('ses_one'))[0].status, 'interrupted');
  assert.equal(second.messages[0].type, 'failure');
  assert.doesNotMatch(second.messages[0].text, /NO_REPLAY/);
});

test('повреждённое хранилище не подменяется пустым', async () => {
  const f = fixture({ version: 99, jobs: [] });
  await assert.rejects(f.scheduler.load(0), /версия|хранилищ/i);
});

test('ошибка сохранения не допускает доставку запроса', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'schedule', due: 2000, prompt: 'НЕ ВЫПОЛНЯТЬ' }, 0);
  f.scheduler.io.save = async () => { throw new Error('disk full'); };
  await assert.rejects(f.scheduler.tick(2000), /disk full/);
  assert.equal(f.messages.length, 0);
});

test('отказавший в срок запрос не запускается после длительного сбоя доставки', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'schedule', due: 2000, prompt: 'NEVER_LATE' }, 0);
  f.reject(true);
  await f.scheduler.tick(2000);
  f.reject(false);
  await f.scheduler.tick(60000);
  assert.equal(f.messages[0].type, 'failure');
  assert.doesNotMatch(f.messages[0].text, /NEVER_LATE/);
});

test('неизвестный ACK сверяется с сервером без второго выполнения или ложного missed', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'schedule', due: 2000, prompt: 'ONCE' }, 0);
  const deliver = f.scheduler.io.deliver;
  f.scheduler.io.deliver = async (entry) => { await deliver(entry); throw new Error('lost ACK'); };
  await f.scheduler.tick(2000);
  f.scheduler.io.deliver = deliver;
  await f.scheduler.tick(60000);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].text, 'ONCE');
});

test('отмена удаляет все принятые сообщения монитора', async () => {
  const f = fixture();
  const deliver = f.scheduler.io.deliver;
  f.scheduler.io.deliver = async (entry) => { await deliver(entry); f.pending.add(entry.id); };
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'monitor', command: 'echo', pattern: 'x' }, 0);
  await f.scheduler.output('ses_one', job.id, 'one', 0);
  await f.scheduler.tick(0);
  f.pending.add(f.messages[0].id);
  await f.scheduler.output('ses_one', job.id, 'two', 1000);
  await f.scheduler.tick(1000);
  f.pending.add(f.messages[1].id);
  await f.scheduler.cancel('ses_one', job.id);
  assert.equal(f.cancelled.length, 2);
});

test('история и поздняя отмена сохраняют завершённые задания с ожидающими сообщениями', async () => {
  const f = fixture();
  const deliver = f.scheduler.io.deliver;
  f.scheduler.io.deliver = async (entry) => { await deliver(entry); f.pending.add(entry.id); };
  await f.scheduler.load(0);
  const first = await f.scheduler.add('ses_one', { kind: 'monitor', command: 'first' }, 0);
  await f.scheduler.consume('ses_one', first.id, { status: 'completed' }, 'first', 1);
  await f.scheduler.tick(1);
  f.pending.add(f.messages[0].id);
  for (let i = 1; i < 51; i++) {
    const job = await f.scheduler.add('ses_one', { kind: 'monitor', command: 'next' }, i);
    await f.scheduler.consume('ses_one', job.id, { status: 'completed' }, 'next', i + 1);
    await f.scheduler.tick(i + 1);
    f.pending.add(f.messages.at(-1).id);
  }
  const before = structuredClone(f.saved());
  const result = await f.scheduler.cancel('ses_one', first.id);
  assert.deepEqual(result, before.jobs.find((job) => job.id === first.id));
  assert.deepEqual(f.saved(), before);
  assert.deepEqual(f.cancelled, []);
});

test('заполненная очередь опустошается до создания новых событий', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'loop', interval: 10000, prompt: 'next' }, 0);
  f.scheduler.state.outbox = Array.from({ length: 100 }, (_, index) => ({ id: `msg_test_${index}`, jobID: job.id, sessionID: 'ses_one', type: 'failure', text: 'previous', created: 0 }));
  await f.scheduler.tick(60000);
  assert.ok(f.messages.length >= 100);
});

test('закрытый экземпляр после задержанной доставки не пишет поверх нового', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'schedule', due: 1, prompt: 'once' }, 0);
  let release;
  let entered;
  const ready = new Promise((done) => { entered = done; });
  f.scheduler.io.deliver = async () => { entered(); await new Promise((done) => { release = done; }); };
  const ticking = f.scheduler.tick(1);
  await ready;
  f.scheduler.close();
  const snapshot = f.saved();
  release();
  await assert.rejects(ticking, /остановлен/);
  assert.deepEqual(f.saved(), snapshot);
});

test('ошибка очереди одной сессии не блокирует срок другой', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const first = await f.scheduler.add('ses_one', { kind: 'schedule', due: 1, prompt: 'first' }, 0);
  await f.scheduler.tick(1);
  const second = await f.scheduler.add('ses_two', { kind: 'schedule', due: 2, prompt: 'second' }, 1);
  await f.scheduler.update('ses_one', first.id, { messages: ['msg_pending'] });
  f.scheduler.io.isPending = async (sessionID) => { if (sessionID === 'ses_one') throw new Error('HTTP 404'); return false; };
  await f.scheduler.tick(2);
  assert.equal(f.messages.at(-1).sessionID, `ses_worker_${second.id}`);
});

test('задержка записи проверяется свежими часами перед admission', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  await f.scheduler.add('ses_one', { kind: 'schedule', due: 1000, prompt: 'NEVER_LATE' }, 0);
  f.scheduler.io.now = () => 10000;
  await f.scheduler.tick(1000);
  await f.scheduler.tick(10000);
  assert.equal(f.messages[0].type, 'failure');
});

test('поздняя фиксация monitor page не перезаписывает cancelled', async () => {
  const f = fixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'monitor', command: 'echo', pattern: 'x' }, 0);
  await f.scheduler.cancel('ses_one', job.id);
  await f.scheduler.consume('ses_one', job.id, { cursor: 4, status: 'completed' }, 'late output', 1);
  assert.equal((await f.scheduler.list('ses_one'))[0].status, 'cancelled');
  assert.equal(f.messages.length, 0);
});

test('начальная загрузка входит в ожидание закрытия writer', async () => {
  const f = fixture();
  let release;
  let entered;
  const ready = new Promise((done) => { entered = done; });
  f.scheduler.io.save = async () => { entered(); await new Promise((done) => { release = done; }); };
  const loading = f.scheduler.load(0);
  await ready;
  let closed = false;
  const closing = f.scheduler.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await assert.rejects(loading, /остановлен/);
  await closing;
  assert.equal(closed, true);
});
