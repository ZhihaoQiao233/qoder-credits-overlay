import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Watcher } from '../src/watcher.js';

const from = Date.parse('2026-11-08T00:00:00Z');
const to = Date.parse('2026-11-09T00:00:00Z');
const updatedAt = '2026-11-08T08:00:00.000Z';
const row = (business_id, credits, extra = {}) => ({
  session_id: 'A', business_id, credits, original_credits: 9999,
  kind: 'Charged', model_category: 'Sonus', source: 'Qoder', operation: 'Agent',
  begin_at: from + 1000, finish_at: from + 5000, ...extra
});

function fixture(t, rows, officialSource = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-official-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const eventsFile = path.join(dir, 'events.jsonl');
  const officialUsageFile = path.join(dir, 'official-usage.json');
  const events = [];
  for (const id of ['A', 'B']) {
    const transcriptPath = path.join(dir, `${id}.jsonl`);
    const messages = [{ type: 'workspace-directories', directories: [dir] }];
    for (const [i, credits] of (id === 'A' ? [543.5061172805, 915.7115232870002] : [7]).entries()) {
      const at = ms => new Date(from + i * 10000 + ms).toISOString();
      events.push({ event: 'task-start', sessionId: id, transcriptPath, at: at(1000) });
      messages.push({ type: 'assistant', sessionId: id, timestamp: at(2000), message: {
        id: `${id}-${i}`, model: 'smodel', usage: { request_id: `${id}-${i}`, credits, billable: true }
      } });
      events.push({ event: 'task-stop', sessionId: id, transcriptPath, at: at(5000), requestSetId: `turn-${i}` });
    }
    fs.writeFileSync(transcriptPath, messages.map(x => JSON.stringify(x)).join('\n') + '\n');
  }
  fs.writeFileSync(eventsFile, events.map(x => JSON.stringify(x)).join('\n') + '\n');
  const save = rows => fs.writeFileSync(officialUsageFile, JSON.stringify({ version: 1, from, to, updatedAt, rows }));
  if (rows !== null) save(rows);
  const make = () => new Watcher({ dataDir: dir, eventsFile, stateFile: path.join(dir, 'state.json'),
    officialUsageFile, officialSource, officialSyncMs: 0, logPath: null, usageLogRoot: null,
    stopGraceMs: 0, launchOverlay: false });
  return { dir, make, save, officialUsageFile, eventsFile };
}

test('official credits replace recorded totals using both IDs, without adding the missing amount twice', async t => {
  const f = fixture(t, [row('turn-0', 557.74), row('turn-1', 968.92)]);
  const w = f.make();
  for (let i = 0; i < 2; i++) {
    const state = await w.runOnce();
    const s = state.sessions.A;
    assert.equal(s.taskCredits, 968.92);
    assert.equal(s.taskRecordedCredits, 915.71);
    assert.equal(s.taskAttribution, 'official-api');
    assert.equal(s.taskSettlement, 'synced');
    assert.equal(s.taskOfficialUpdatedAt, updatedAt);
    assert.deepEqual(s.taskByModel, { Sonus: { total: 968.92 } });
    assert.equal(s.recentTasks[0].knownActual, 557.74);
    assert.equal(s.recentTasks[0].recordedCredits, 543.50);
    assert.equal(state.sessions.B.taskCredits, 7);
    assert.equal(s.exactConversationCredits, null);
  }
});

test('free usage uses credits zero rather than original credits or transcript charges', async t => {
  const f = fixture(t, [row('turn-1', 0, { kind: 'Not Charged', original_credits: 968.92 })]);
  const s = (await f.make().runOnce()).sessions.A;
  assert.equal(s.taskCredits, 0);
  assert.equal(s.taskAttribution, 'official-api');
});

test('duplicate rows are idempotent while different model categories are summed in integer cents', async t => {
  const one = row('turn-1', 0.10);
  const f = fixture(t, [one, one, row('turn-1', 0.20, { model_category: 'Cantus' })]);
  const s = (await f.make().runOnce()).sessions.A;
  assert.equal(s.taskCredits, 0.30);
  assert.deepEqual(s.taskByModel, { Sonus: { total: 0.10 }, Cantus: { total: 0.20 } });
});

test('conflicting duplicate rows do not manufacture an official total', async t => {
  const f = fixture(t, [row('turn-1', 968.92), row('turn-1', 1000)]);
  const s = (await f.make().runOnce()).sessions.A;
  assert.equal(s.taskAttribution, 'transcript-only');
  assert.equal(s.taskCredits, 915.71);
  assert.equal(s.taskOfficialUpdatedAt, null);
});

test('conflicting paid and free status cannot certify the same billing identity', async t => {
  const f = fixture(t, [row('turn-1', 968.92), row('turn-1', 0, { kind: 'Not Charged' })]);
  const s = (await f.make().runOnce()).sessions.A;
  assert.equal(s.taskAttribution, 'transcript-only');
  assert.equal(s.taskCredits, 915.71);
});

test('worker-log ownership alone cannot replace a running turn without an official hook ID', async t => {
  const f = fixture(t, [row('turn-1', 968.92)]);
  const events = fs.readFileSync(f.eventsFile, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(e => !(e.sessionId === 'A' && e.event === 'task-stop' && e.requestSetId === 'turn-1'));
  fs.writeFileSync(f.eventsFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const w = f.make();
  w.usageIndex = { scan() {}, export() { return []; }, records() {
    return [{ sessionId: 'A', requestId: 'A-1', ownerId: 'turn-1' }];
  } };
  const s = (await w.runOnce()).sessions.A;
  assert.equal(s.taskCredits, 915.71);
  assert.equal(s.taskOfficialUpdatedAt, null);
});

test('invalid amounts or identities invalidate the snapshot rather than certifying partial totals', async t => {
  for (const bad of [{ credits: -1 }, { credits: '968.92' }, { credits: null }, { business_id: '' },
    { kind: 'pending' }, { kind: 'Not Charged', credits: 1 }, { credits: 0.001 }]) {
    const f = fixture(t, [row('turn-0', 557.74), row('turn-1', 968.92, bad)]);
    const s = (await f.make().runOnce()).sessions.A;
    assert.equal(s.taskAttribution, 'transcript-only');
    assert.equal(s.recentTasks[0].attribution, 'transcript-only');
  }
});

test('a running task without a proven ID is not joined to a similarly timed official row', async t => {
  const f = fixture(t, [row('turn-1', 968.92)]);
  fs.appendFileSync(f.eventsFile, JSON.stringify({ event: 'task-start', sessionId: 'A',
    transcriptPath: path.join(f.dir, 'A.jsonl'), at: new Date(from + 21000).toISOString() }) + '\n');
  const state = await f.make().runOnce();
  assert.equal(state.sessions.A.taskCredits, 0);
  assert.equal(state.sessions.A.taskOfficialUpdatedAt, null);
  assert.equal(state.sessions.A.recentTasks[1].knownActual, 968.92);
});

test('a completed turn syncs immediately and keeps polling fast while the official row settles', async t => {
  const source = { async read() { return { from, to, rows: [row('turn-1', 968.92)] }; } };
  const f = fixture(t, null, source);
  const w = new Watcher({ dataDir: f.dir, eventsFile: f.eventsFile, stateFile: path.join(f.dir, 'state.json'),
    officialUsageFile: f.officialUsageFile, officialSource: source, officialSyncMs: 30000, settleSyncMs: 5000,
    startedAt: '2026-11-07T00:00:00.000Z', logPath: null, usageLogRoot: null, stopGraceMs: 0, launchOverlay: false });
  w.nextOfficialSync = Date.now() + 30000;
  await w.runOnce();
  assert.equal(w.nextOfficialSync, 0);
  await w.syncOfficial();
  const fast = w.nextOfficialSync - Date.now();
  assert.ok(fast > 0 && fast <= 6000, `fast delay ${fast}`);
  w.fastUntil = 0;
  await w.syncOfficial();
  const normal = w.nextOfficialSync - Date.now();
  assert.ok(normal > 29000 && normal <= 31000, `normal delay ${normal}`);
});

test('official syncing replaces corrections and persists only billing metadata across restarts', async t => {
  let amount = 968.92;
  const source = { async read() { return { from, to, rows: [row('turn-1', amount, { prompt: 'PRIVATE', cookie: 'SECRET' })] }; } };
  const f = fixture(t, null, source);
  const w = f.make();
  await w.runOnce();
  await w.syncOfficial();
  assert.equal((await w.runOnce()).sessions.A.taskCredits, 968.92);
  amount = 960;
  await w.syncOfficial();
  const state = await w.runOnce();
  assert.equal(state.sessions.A.taskCredits, 960);
  assert.equal(state.officialSync.status, 'synced');
  const disk = fs.readFileSync(f.officialUsageFile, 'utf8');
  assert.doesNotMatch(disk, /PRIVATE|SECRET|original_credits/);
  assert.equal((await f.make().runOnce()).sessions.A.taskCredits, 960);
});

test('an unavailable browser preserves the last verified amount and reports it as cached', async t => {
  const source = { async read() { throw Object.assign(new Error('sensitive response text'), { code: 'browser-closed' }); } };
  const f = fixture(t, [row('turn-1', 968.92)], source);
  const w = f.make();
  await w.runOnce();
  await w.syncOfficial();
  const state = await w.runOnce();
  assert.equal(state.sessions.A.taskCredits, 968.92);
  assert.equal(state.officialSync.status, 'browser-closed');
  assert.doesNotMatch(JSON.stringify(state.officialSync), /sensitive/);
  assert.equal(JSON.parse(fs.readFileSync(f.officialUsageFile, 'utf8')).updatedAt, updatedAt);
});

test('a malformed refresh preserves a good cache and reports invalid data', async t => {
  const source = { async read() { return { from, to, rows: [row('turn-1', 'bad')] }; } };
  const f = fixture(t, [row('turn-1', 968.92)], source);
  const w = f.make();
  await w.runOnce();
  await w.syncOfficial();
  const state = await w.runOnce();
  assert.equal(state.sessions.A.taskCredits, 968.92);
  assert.equal(state.officialSync.status, 'invalid-data');
  assert.equal(JSON.parse(fs.readFileSync(f.officialUsageFile, 'utf8')).updatedAt, updatedAt);
});

test('delayed official sync never blocks transcript processing or starts overlapping reads', async t => {
  let finish;
  const source = { async read() {
    assert.equal(finish, undefined, 'overlapping official requests');
    return new Promise(resolve => { finish = resolve; });
  } };
  const f = fixture(t, null, source);
  const w = f.make();
  await w.runOnce();
  const pending = w.syncOfficial();
  await w.syncOfficial();
  assert.equal((await w.runOnce()).sessions.A.taskCredits, 915.71);
  finish({ from, to, rows: [row('turn-1', 968.92)] });
  await pending;
  assert.equal((await w.runOnce()).sessions.A.taskCredits, 968.92);
});

test('a complete newer snapshot removes absent rows instead of retaining an unsupported amount', async t => {
  const source = { async read() { return { from, to, rows: [] }; } };
  const f = fixture(t, [row('turn-1', 968.92)], source);
  const w = f.make();
  await w.runOnce();
  await w.syncOfficial();
  assert.equal((await w.runOnce()).sessions.A.taskCredits, 915.71);
});

test('one stop only labels the newest overlapping submission with its request set', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-overlap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'A.jsonl');
  const eventsFile = path.join(dir, 'events.jsonl');
  const t0 = Date.parse('2026-11-08T00:00:00Z');
  const at = second => new Date(t0 + second * 1000).toISOString();
  const messages = [
    { type: 'workspace-directories', directories: [dir] },
    { type: 'assistant', sessionId: 'A', timestamp: at(2), message: {
      id: 'm1', model: 'Sonus', usage: { request_id: 'r1', credits: 30, billable: true } } },
    { type: 'assistant', sessionId: 'A', timestamp: at(6), message: {
      id: 'm2', model: 'Sonus', usage: { request_id: 'r2', credits: 7, billable: true } } }
  ];
  fs.writeFileSync(transcriptPath, messages.map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(eventsFile, [
    { event: 'task-start', sessionId: 'A', transcriptPath, at: at(1) },
    { event: 'task-start', sessionId: 'A', transcriptPath, at: at(5) },
    { event: 'task-stop', sessionId: 'A', transcriptPath, at: at(10), requestSetId: 'new' }
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const officialUsageFile = path.join(dir, 'official-usage.json');
  fs.writeFileSync(officialUsageFile, JSON.stringify({ version: 1, from: t0, to: t0 + 20000, updatedAt,
    rows: [row('old', 100, { begin_at: t0 + 1000, finish_at: t0 + 9000 }),
      row('new', 20, { begin_at: t0 + 5000, finish_at: t0 + 11000 })] }));
  const w = new Watcher({ dataDir: dir, eventsFile, stateFile: path.join(dir, 'state.json'),
    officialUsageFile, officialSource: null, officialSyncMs: 0, logPath: null, usageLogRoot: null,
    stopGraceMs: 0, launchOverlay: false });
  const state = await w.runOnce();
  const s = state.sessions.A;
  assert.equal(s.recentTasks.length, 2);
  assert.equal(s.recentTasks[0].requestSetId, null);
  assert.equal(s.recentTasks[0].attribution, 'transcript-only');
  assert.equal(s.recentTasks[0].knownActual, 37);
  assert.equal(s.recentTasks[1].requestSetId, 'new');
  assert.equal(s.recentTasks[1].knownActual, 20);
  assert.equal(state.lastCompleted.requestSetId, 'new');
  assert.equal(state.lastCompleted.taskCredits, 20);
});
