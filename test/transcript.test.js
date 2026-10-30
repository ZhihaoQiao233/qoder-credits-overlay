import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscriptLine, splitCompleteLines } from '../src/transcript.js';

test('parses billable assistant usage', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-29T12:25:20.283Z',
    sessionId: 's1',
    message: { id: 'm1', usage: { credits: 2.5, billable: true, request_id: 'r1' } }
  });
  assert.deepEqual(parseTranscriptLine(line), {
    requestId: 'r1', credits: 2.5, billable: true,
    timestamp: '2026-10-29T12:25:20.283Z', sessionId: 's1', model: 'unknown'
  });
});

test('keeps the model name so credits can be split per model', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-29T12:25:20.283Z',
    sessionId: 's1',
    message: { id: 'm1', model: 'mmodel', usage: { credits: 2.5, billable: true, request_id: 'r1' } }
  });
  assert.equal(parseTranscriptLine(line).model, 'mmodel');
});

test('returns null for non-usage or malformed records', () => {
  assert.equal(parseTranscriptLine('{"type":"user"}'), null);
  assert.equal(parseTranscriptLine('not-json'), null);
  assert.equal(parseTranscriptLine(JSON.stringify({
    type: 'assistant', timestamp: 't', sessionId: 's',
    message: { id: 'm', usage: { credits: 1, billable: false, request_id: 'r' } }
  })).billable, false);
});

test('keeps partial last line in remainder', () => {
  const result = splitCompleteLines('{"a":1}\n{"b":2}\n{"c"');
  assert.deepEqual(result.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(result.remainder, '{"c"');
});
