import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSubagentRecords } from '../src/subagents.js';

test('reads billable subagent credits inside window only', () => {
  const records = scanSubagentRecords(
    'test/fixtures/session/main.jsonl',
    '2026-10-29T10:10:00Z',
    '2026-10-29T10:20:00Z'
  );
  assert.equal(records.length, 2);
  assert.equal(records.reduce((n, r) => n + r.credits, 0), 4.5);
});
