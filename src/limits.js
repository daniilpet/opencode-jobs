import { duration } from './parser.js';

export function jobLimits(kind, timeout, maxRuns) {
  if (!['background', 'monitor', 'loop', 'schedule'].includes(kind)) {
    if (timeout !== undefined || maxRuns !== undefined) throw new Error('Лимит исполнения задаётся только для создаваемых заданий.');
    return {};
  }
  const value = timeout === undefined ? (['background', 'schedule'].includes(kind) ? 1800000 : 3600000) : typeof timeout === 'string' ? duration(timeout) : timeout;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 86400000) throw new Error('Срок работы должен быть положительным и не более 24 часов.');
  if (kind !== 'loop') {
    if (maxRuns !== undefined) throw new Error('Число срабатываний задаётся только для loop.');
    return { timeout: value };
  }
  const runs = maxRuns === undefined ? 12 : maxRuns;
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) throw new Error('Число срабатываний loop должно быть от 1 до 100.');
  return { timeout: value, maxRuns: runs };
}
