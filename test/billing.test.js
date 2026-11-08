import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubagentScanner } from '../src/subagents.js';
import { UsageAggregator } from '../src/aggregator.js';
import { Watcher } from '../src/watcher.js';

const at = n => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const record = (id, credits, second, sessionId = 'A') => ({
  type: 'assistant', sessionId, timestamp: at(second),
  message: { id, model: 'model', usage: { request_id: id, credits, billable: true } }
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (file, rows) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  };
  const transcript = (id, rows = []) => {
    const file = path.join(dir, `${id}.jsonl`);
    write(file, [{ type: 'workspace-directories', sessionId: id, directories: [dir] }, ...rows]);
    return file;
  };
  const events = path.join(dir, 'events.jsonl');
  const event = (name, id, second, requestSetId = null) => ({
    event: name, sessionId: id, at: at(second), requestSetId,
    transcriptPath: path.join(dir, `${id}.jsonl`)
  });
  const watcher = () => new Watcher({
    dataDir: path.join(dir, 'output'), eventsFile: events,
    stateFile: path.join(dir, 'output', 'state.json'),
    logPath: null, usageLogRoot: null, stopGraceMs: 0, launchOverlay: false
  });
  return { dir, write, transcript, events, event, watcher };
}

test('scans only this session subagents and rejects a foreign session record', t => {
  const f = fixture(t);
  const main = f.transcript('A');
  f.transcript('B');
  f.write(path.join(f.dir, 'A', 'subagents', 'agent-one.jsonl'), [record('a', 3, 2), record('foreign', 40, 2, 'B')]);
  f.write(path.join(f.dir, 'B', 'subagents', 'agent-two.jsonl'), [record('b', 20, 2, 'B')]);
  f.write(path.join(f.dir, 'subagents', 'legacy.jsonl'), [record('legacy', 90, 2)]);
  const scanner = new SubagentScanner(main);
  const rows = scanner.scanNew();
  assert.deepEqual(rows.map(r => r.requestId), ['a']);
  assert.equal(rows[0].credits, 3);
  assert.deepEqual(scanner.scanNew(), []);
});

test('discovers a session subagent directory created after the first scan', t => {
  const f = fixture(t);
  const scanner = new SubagentScanner(f.transcript('A'));
  assert.deepEqual(scanner.scanNew(), []);
  f.write(path.join(f.dir, 'A', 'subagents', 'agent-one.jsonl'), [record('a', 3, 2)]);
  assert.equal(scanner.scanNew().length, 1);
});

test('includes subagent charges once and displays the reported 543.50 total', async t => {
  const f = fixture(t);
  const main = record('main', 352.614709854, 2);
  main.message.content = [{ type: 'tool_use', id: 'tool-one' }, { type: 'tool_use', id: 'tool-two' }];
  f.transcript('A', [main]);
  f.write(path.join(f.dir, 'A', 'subagents', 'one.jsonl'), [record('sub-one', 92.648758873, 3)]);
  f.write(path.join(f.dir, 'A', 'subagents', 'one.meta.json'), [{ toolUseId: 'tool-one' }]);
  f.write(path.join(f.dir, 'A', 'subagents', 'two.jsonl'), [record('sub-two', 98.2426485535, 4)]);
  f.write(path.join(f.dir, 'A', 'subagents', 'two.meta.json'), [{ toolUseId: 'tool-two' }]);
  f.write(f.events, [f.event('task-start', 'A', 1), f.event('task-stop', 'A', 5, 'owner-A')]);
  const w = f.watcher();
  for (let i = 0; i < 2; i++) {
    const state = await w.runOnce();
    assert.equal(state.sessions.A.taskCredits, 543.50);
    assert.equal(state.sessions.A.conversationCredits, 543.50);
    assert.equal(state.sessions.A.taskRequestSetId, 'owner-A');
  }
});

test('late subagent billing belongs to its launching turn, not the next turn', async t => {
  const f = fixture(t);
  const main = record('main-one', 2, 2);
  main.message.id = 'split-message';
  const call = { type: 'assistant', sessionId: 'A', timestamp: at(2), message: {
    id: 'split-message', content: [{ type: 'tool_use', id: 'tool-one' }]
  } };
  f.transcript('A', [call, main, record('main-two', 3, 7)]);
  f.write(path.join(f.dir, 'A', 'subagents', 'one.jsonl'), [record('late-child', 5, 8)]);
  f.write(path.join(f.dir, 'A', 'subagents', 'one.meta.json'), [{ toolUseId: 'tool-one' }]);
  f.write(f.events, [f.event('task-start', 'A', 1), f.event('task-stop', 'A', 4, 'owner-one'),
    f.event('task-start', 'A', 6), f.event('task-stop', 'A', 9, 'owner-two')]);
  const s = (await f.watcher().runOnce()).sessions.A;
  assert.equal(s.recentTasks[0].knownActual, 7);
  assert.equal(s.recentTasks[1].knownActual, 3);
  assert.equal(s.conversationCredits, 10);
});

test('a child without a proven parent remains at session level until metadata arrives', async t => {
  const f = fixture(t);
  const main = record('main', 2, 2);
  main.message.content = [{ type: 'tool_use', id: 'tool' }];
  f.transcript('A', [main]);
  f.write(path.join(f.dir, 'A', 'subagents', 'one.jsonl'), [record('child', 5, 3)]);
  f.write(f.events, [f.event('task-start', 'A', 1), f.event('task-stop', 'A', 4, 'owner')]);
  const w = f.watcher();
  const before = (await w.runOnce()).sessions.A;
  assert.equal(before.taskCredits, 2);
  assert.equal(before.conversationCredits, 7);
  f.write(path.join(f.dir, 'A', 'subagents', 'one.meta.json'), [{ toolUseId: 'tool' }]);
  assert.equal((await w.runOnce()).sessions.A.taskCredits, 7);
});

test('a billable child follows a non-billable parent request into its original turn', async t => {
  const f = fixture(t);
  const parent = record('free-parent', 0, 2);
  parent.message.usage.billable = false;
  parent.message.content = [{ type: 'tool_use', id: 'tool-free' }];
  f.transcript('A', [parent, record('next-turn', 3, 7)]);
  f.write(path.join(f.dir, 'A', 'subagents', 'one.jsonl'), [record('paid-child', 5, 8)]);
  f.write(path.join(f.dir, 'A', 'subagents', 'one.meta.json'), [{ toolUseId: 'tool-free' }]);
  f.write(f.events, [f.event('task-start', 'A', 1), f.event('task-stop', 'A', 4, 'owner-one'),
    f.event('task-start', 'A', 6), f.event('task-stop', 'A', 9, 'owner-two')]);
  const s = (await f.watcher().runOnce()).sessions.A;
  assert.equal(s.recentTasks[0].knownActual, 5);
  assert.equal(s.recentTasks[1].knownActual, 3);
  assert.equal(s.conversationCredits, 8);
});

test('ledger reconciliation does not depend on main/subagent ingestion order', () => {
  const a = new UsageAggregator();
  const usage = (requestId, credits, timestamp) => ({ requestId, credits, timestamp, billable: true, model: 'm' });
  a.addRecords('A', [usage('main-1', 1, at(1)), usage('main-3', 1, at(3))]);
  a.addRecords('A', [usage('sub-2', 1, at(2))]);
  assert.deepEqual(a.sumByModelThrough('A', 'main-3', at(3)), { m: 3 });
});
