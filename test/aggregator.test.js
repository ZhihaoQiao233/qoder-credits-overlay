import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageAggregator } from '../src/aggregator.js';

const rec = (id, credits, ts, billable = true) => ({ requestId: id, credits, timestamp: ts, billable });

test('counts billable requests once and separates task from conversation', () => {
  const a = new UsageAggregator();
  a.addRecords('s1', [rec('old', 5, '2026-10-29T10:00:00Z')]);
  a.startTask('s1', '2026-10-29T10:10:00Z');
  a.addRecords('s1', [rec('r1', 2, '2026-10-29T10:11:00Z'), rec('r1', 2, '2026-10-29T10:11:01Z')]);
  a.addRecords('s1', [rec('r2', 3, '2026-10-29T10:12:00Z', false)]);
  const s = a.snapshot('s1');
  assert.equal(s.taskCredits, 2);
  assert.equal(s.conversationCredits, 7);
  assert.equal(s.status, 'running');
});

test('freezes task total at stop time', () => {
  const a = new UsageAggregator();
  a.startTask('s1', '2026-10-29T10:10:00Z');
  a.addRecords('s1', [rec('r1', 2, '2026-10-29T10:11:00Z')]);
  a.stopTask('s1', '2026-10-29T10:12:00Z');
  a.addRecords('s1', [rec('r2', 9, '2026-10-29T10:13:00Z')]);
  const s = a.snapshot('s1');
  assert.equal(s.taskCredits, 2);
  assert.equal(s.conversationCredits, 11);
  assert.equal(s.status, 'completed');
});

test('accepts a late record whose timestamp belongs to the stopped task', () => {
  const a = new UsageAggregator();
  a.startTask('s1', '2026-10-29T10:10:00Z');
  a.stopTask('s1', '2026-10-29T10:12:00Z');
  a.addRecords('s1', [rec('late', 1.5, '2026-10-29T10:11:30Z')]);
  assert.equal(a.snapshot('s1').taskCredits, 1.5);
});

test('sums billable credits inside a half-open window', () => {
  const a = new UsageAggregator();
  a.addRecords('s1', [
    rec('before', 5, '2026-10-29T10:00:00Z'),
    rec('edge', 1, '2026-10-29T10:10:00Z'),
    rec('inside', 2, '2026-10-29T10:20:00Z'),
    rec('free', 16, '2026-10-29T10:25:00Z', false),
    rec('end', 4, '2026-10-29T10:30:00Z'),
    rec('after', 8, '2026-10-29T10:40:00Z')
  ]);
  assert.equal(a.sumBetween('s1', '2026-10-29T10:10:00Z', '2026-10-29T10:30:00Z'), 6);
});

test('sums nothing for a session it never saw', () => {
  const a = new UsageAggregator();
  assert.equal(a.sumBetween('nope', '2026-10-29T10:00:00Z', '2026-10-29T11:00:00Z'), 0);
});
