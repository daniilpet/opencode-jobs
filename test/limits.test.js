import test from 'node:test';
import assert from 'node:assert/strict';
import { jobLimits } from '../src/limits.js';

test('фон, монитор и цикл получают конечные пределы по умолчанию', () => {
  assert.deepEqual(jobLimits('background'), { timeout: 1800000 });
  assert.deepEqual(jobLimits('monitor'), { timeout: 3600000 });
  assert.deepEqual(jobLimits('loop'), { timeout: 3600000, maxRuns: 12 });
});

test('явные длительные задания допускаются только внутри потолка', () => {
  assert.deepEqual(jobLimits('loop', '24h', 100), { timeout: 86400000, maxRuns: 100 });
  assert.deepEqual(jobLimits('background', '2h'), { timeout: 7200000 });
  assert.throws(() => jobLimits('monitor', '25h'), /24/);
  assert.throws(() => jobLimits('loop', '1h', 101), /100/);
});

test('нулевые и некорректные лимиты не отключают защиту', () => {
  assert.throws(() => jobLimits('background', 0));
  assert.throws(() => jobLimits('background', Infinity));
  assert.throws(() => jobLimits('background', '0s'));
  assert.throws(() => jobLimits('loop', '1h', 0));
  assert.throws(() => jobLimits('loop', '1h', 1.5));
  assert.throws(() => jobLimits('loop', '1h', '12'));
});

test('горизонт разового расписания не подменяется временем процесса', () => {
  assert.deepEqual(jobLimits('schedule'), { timeout: 1800000 });
  assert.deepEqual(jobLimits('schedule', '24h'), { timeout: 86400000 });
  assert.throws(() => jobLimits('schedule', '25h'));
  assert.throws(() => jobLimits('background', '1h', 12));
});
