import test from 'node:test';
import assert from 'node:assert/strict';
import { expiryReason } from '../src/scheduler.js';

test('причина истечения без worker остаётся краткой', () => {
  assert.equal(expiryReason({}), 'Истёк предельный срок работы.');
});

test('причина истечения с worker описывает последнее наблюдение', () => {
  assert.match(expiryReason({ workerID: 'ses_a', executionStatus: 'running' }), /была активна в последнем наблюдении/);
  assert.match(expiryReason({ workerID: 'ses_a', executionStatus: 'pending' }), /не завершилась/);
  assert.match(expiryReason({ workerID: 'ses_a', executionStatus: 'interrupted' }), /прервана/);
  assert.match(expiryReason({ workerID: 'ses_a' }), /последнее состояние: неизвестно/);
  assert.match(expiryReason({ workerID: 'ses_a', executionStatus: 'weird' }), /последнее состояние: weird/);
  for (const reason of [expiryReason({ workerID: 'ses_a', executionStatus: 'running' })]) {
    assert.match(reason, /^Истёк предельный срок работы\./);
    assert.match(reason, /подтверждённого результата нет/);
  }
});
