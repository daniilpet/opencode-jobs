import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor, matchLines } from '../src/monitor.js';
import { sanitize } from '../src/sanitize.js';

test('монитор возвращает совпадение с контекстом после debounce', async () => {
  const monitor = new Monitor({ id: 'job_test', pattern: 'ERROR', before: 1, after: 1, debounce: 1000 });
  assert.equal(await monitor.ingest('before\nERROR\nafter\n', 0), undefined);
  assert.match(await monitor.ingest('', 1000), /before\nERROR\nafter/);
});

test('вывод без совпадений не создаёт доставку', async () => {
  const monitor = new Monitor({ id: 'job_test', pattern: 'ERROR', before: 1, after: 1, debounce: 1000 });
  assert.equal(await monitor.ingest('hello\n', 0, true), undefined);
});

test('последняя строка без перевода сохраняется при завершении', async () => {
  const monitor = new Monitor({ id: 'job_test', pattern: 'ERROR', before: 0, after: 0, debounce: 1000 });
  assert.match(await monitor.ingest('ERROR', 0, true), /ERROR/);
});

test('очистка удаляет управляющие последовательности и похожие на секреты значения', () => {
  assert.equal(sanitize('\x1b[31mERROR\x1b[0m\x00 token=example-secret'), 'ERROR token=[REDACTED]');
});

test('патологическая регулярка ограничивается отдельным worker', async () => {
  await assert.rejects(matchLines('(a+)+$', ['a'.repeat(10000) + '!'], 500), /лимит времени/);
});

test('после debounce строки after не создают отдельное ложное совпадение', async () => {
  const monitor = new Monitor({ id: 'job_test', pattern: 'ERROR', before: 0, after: 2, debounce: 1000 });
  await monitor.ingest('ERROR\n', 0);
  await monitor.ingest('', 1000);
  assert.equal(await monitor.ingest('after-one\n', 2000), undefined);
});

test('сохранённый монитор восстанавливает незавершённое совпадение и контекст', async () => {
  const job = { id: 'job_test', pattern: 'ERROR', before: 1, after: 1, debounce: 1000 };
  const first = new Monitor(job);
  await first.ingest('before\nERROR\nafter\n', 0);
  const second = new Monitor(job, first.snapshot());
  assert.match(await second.ingest('', 1000), /before\nERROR\nafter/);
});
