import test from 'node:test';
import assert from 'node:assert/strict';
import { duration, parse } from '../src/parser.js';

test('длительность принимает секунды, минуты и часы', () => {
  assert.equal(duration('2m'), 120000);
  assert.equal(duration('1h30m'), 5400000);
});

test('неизвестная или нулевая длительность отклоняется', () => {
  assert.throws(() => duration('tomorrow'), /длительност/i);
  assert.throws(() => duration('0s'), /длительност/i);
});

test('фоновая команда сохраняется без преобразований оболочки', () => {
  assert.deepEqual(parse('background', 'Write-Output "x y"'), { kind: 'background', command: 'Write-Output "x y"' });
});

test('монитор отделяет свои параметры от команды', () => {
  assert.deepEqual(parse('monitor', '--regex "error|failed" --before 2 --after 1 --debounce 3 -- Write-Output "error"'), {
    kind: 'monitor', pattern: 'error|failed', before: 2, after: 1, debounce: 3000, command: 'Write-Output "error"',
  });
});

test('монитор отклоняет неизвестные параметры и пустую команду', () => {
  assert.throws(() => parse('monitor', '--regex x --other 1 -- echo x'), /параметр/);
  assert.throws(() => parse('monitor', '--regex x -- '), /команд/);
});

test('разделитель команды монитора не распознаётся внутри кавычек', () => {
  const value = parse('monitor', '--regex "step -- finished" -- echo intended');
  assert.equal(value.pattern, 'step -- finished');
  assert.equal(value.command, 'echo intended');
});

test('цикл имеет нижнюю границу десять секунд', () => {
  assert.deepEqual(parse('loop', '10s проверь результат'), { kind: 'loop', interval: 10000, prompt: 'проверь результат' });
  assert.throws(() => parse('loop', '1s проверь'), /10/);
});

test('разовое относительное расписание вычисляет абсолютный срок', () => {
  assert.deepEqual(parse('schedule', 'in 2m проверь сборку', 1000), { kind: 'schedule', due: 121000, prompt: 'проверь сборку' });
});

test('абсолютное расписание требует явного часового пояса', () => {
  assert.throws(() => parse('schedule', 'at 2026-10-06T15:00:00 проверь', 0), /пояс/);
  assert.equal(parse('schedule', 'at 2026-10-06T15:00:00+03:00 проверь', Date.parse('2026-10-05T12:00:00Z')).due, Date.parse('2026-10-06T12:00:00Z'));
});

test('расписание в прошлом и более тридцати дней отклоняется', () => {
  assert.throws(() => parse('schedule', 'at 2026-10-04T12:00:00Z проверь', Date.parse('2026-10-05T12:00:00Z')), /будущ/);
  assert.throws(() => parse('schedule', 'in 31d проверь', 0), /30/);
});
