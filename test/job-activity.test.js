import test from 'node:test';
import assert from 'node:assert/strict';
import { hasJobActivity } from '../src/job-activity.js';

for (const [active, running, preparing, stopping, expected] of [
  [false, false, false, false, false],
  [false, false, false, true, true],
  [false, false, true, false, true],
  [false, false, true, true, true],
  [false, true, false, false, true],
  [false, true, false, true, true],
  [false, true, true, false, true],
  [false, true, true, true, true],
  [true, false, false, false, true],
  [true, false, false, true, true],
  [true, false, true, false, true],
  [true, false, true, true, true],
  [true, true, false, false, true],
  [true, true, false, true, true],
  [true, true, true, false, true],
  [true, true, true, true, true],
]) {
  test(`активность: active=${active}, runMessage=${running}, preparing=${preparing}, stopPending=${stopping}`, () => {
    const job = Object.freeze({ status: active ? 'active' : 'completed', runMessage: running ? 'msg_run' : undefined, preparing, stopPending: stopping });
    const result = hasJobActivity(job);
    assert.equal(result, expected);
  });
}

for (const status of ['completed', 'failed', 'expired', 'missed', 'interrupted', 'cancelled']) {
  test(`${status}: сохранённые идентификаторы и уведомления не означают исполнение`, () => {
    const job = { status, shellID: 'sh_finished', workerID: 'ses_finished', messages: ['msg_result'], lastMessage: 'msg_result' };
    const result = hasJobActivity(job);
    assert.equal(result, false);
  });
}
