import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Watcher } from '../src/watcher.js';
import { SESSION_STATE_KEY, projectHash, stateFileFor } from '../src/session-state.js';
import { UsageLogIndex } from '../src/usage-log.js';

const ROOT = path.join(os.tmpdir(), 'qoder-credits-test-root');

const fixture = fileURLToPath(new URL('./fixtures/session-main.jsonl', import.meta.url));
const logFixture = fileURLToPath(new URL('./fixtures/main.log', import.meta.url));

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-credits-'));
  const eventsFile = path.join(dir, 'events.jsonl');
  const transcriptPath = path.join(dir, 'session-main.jsonl');
  fs.copyFileSync(fixture, transcriptPath);
  const watcher = new Watcher({
    dataDir: dir,
    eventsFile,
    stateFile: path.join(dir, 'state.json'),
    lockFile: path.join(dir, 'lock'),
    logPath: null,
    stopGraceMs: 0,
    launchOverlay: false,
    usageLogRoot: null,
    ...overrides
  });
  return { dir, eventsFile, transcriptPath, watcher };
}

const event = (name, at, transcriptPath, sessionId = 's1') => JSON.stringify({
  event: name, sessionId, transcriptPath, at
}) + '\n';

const quotaLine = (at, used) => `[${at}] [INFO] [main] [Auth] [AccountUsage] 响应摘要 ` +
  `{"operation":"account.getQuotaUsage","requestId":"q","qoderUsage":{"usageType":"credits",` +
  `"userQuota":{"total":0,"used":0,"remaining":0,"unit":"credits"},` +
  `"addOnQuota":{"total":2700,"used":${used},"remaining":${2700 - used},"unit":"credits"}}}`;

const BASE = Date.now() - 3600000;
const at = (offset) => new Date(BASE + offset).toISOString();

const record = (id, credits, timestamp, model = 'mmodel') => JSON.stringify({
  type: 'assistant',
  timestamp,
  sessionId: 's1',
  message: { id, model, usage: { credits, billable: true, request_id: id } }
}) + '\n';

function setupCalibrating(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-credits-'));
  const eventsFile = path.join(dir, 'events.jsonl');
  const logFile = path.join(dir, 'main.log');
  const transcriptPath = path.join(dir, 'live.jsonl');
  fs.writeFileSync(transcriptPath, '');
  const watcher = new Watcher({
    dataDir: dir,
    eventsFile,
    stateFile: path.join(dir, 'state.json'),
    logPath: logFile,
    stopGraceMs: 0,
    launchOverlay: false,
    usageLogRoot: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  });
  return { dir, eventsFile, transcriptPath, watcher, logFile };
}

function setupLedger(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-credits-'));
  const sessionId = 's1';
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({ type: 'workspace-directories', sessionId, directories: [ROOT] }) + '\n'
  );
  const eventsFile = path.join(dir, 'events.jsonl');
  const logFile = path.join(dir, 'main.log');
  const watcher = new Watcher({
    dataDir: dir,
    eventsFile,
    stateFile: path.join(dir, 'state.json'),
    logPath: logFile,
    stopGraceMs: 0,
    launchOverlay: false,
    usageLogRoot: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  });
  return { dir, eventsFile, transcriptPath, sessionId, watcher, logFile };
}

function sealLedger(transcriptPath, sessionId, total, key = SESSION_STATE_KEY, options = {}) {
  const { byModel = {}, latestRequestId = null, updatedAt = new Date().toISOString() } = options;
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.from(
    JSON.stringify({ sessionId, projectHash: projectHash(ROOT), segmentKey: 's0' }),
    'utf8'
  );
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const data = Buffer.concat([
    cipher.update(
      JSON.stringify({ updatedAt, latestRequestId, credits: { total, byModel } }),
      'utf8'
    ),
    cipher.final()
  ]);
  const statePath = stateFileFor(transcriptPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      sessionId,
      revision: 1,
      updatedAt,
      items: {
        s0: { n: nonce.toString('base64'), p: data.toString('base64'), t: cipher.getAuthTag().toString('base64') }
      }
    })
  );
  // 落盘时间跟着账上的时间走，缓存才不会把新账本当成没变。
  fs.utimesSync(statePath, new Date(updatedAt), new Date(updatedAt));
}

test('produces running task and conversation totals', async () => {
  const { eventsFile, transcriptPath, watcher } = setup();
  fs.writeFileSync(eventsFile, event('task-start', '2026-10-29T10:10:00Z', transcriptPath));
  const state = await watcher.runOnce();
  assert.equal(state.sessions.s1.status, 'running');
  assert.equal(state.sessions.s1.taskCredits, 2);
  assert.equal(state.sessions.s1.conversationCredits, 7);
  assert.equal(state.currentSessionId, 's1');
});

test('completes a task and records lastCompleted', async () => {
  const { eventsFile, transcriptPath, watcher } = setup();
  fs.writeFileSync(eventsFile, event('task-start', '2026-10-29T10:10:00Z', transcriptPath));
  await watcher.runOnce();
  fs.appendFileSync(eventsFile, event('task-stop', '2026-10-29T10:12:30Z', transcriptPath));
  const state = await watcher.runOnce();
  assert.equal(state.sessions.s1.status, 'completed');
  assert.equal(state.sessions.s1.taskCredits, 2);
  assert.equal(state.lastCompleted.taskCredits, 2);
});

test('reads only complete event lines', async () => {
  const { eventsFile, transcriptPath, watcher } = setup();
  const line = event('task-start', '2026-10-29T10:10:00Z', transcriptPath);
  fs.writeFileSync(eventsFile, line.slice(0, line.length - 2));
  let state = await watcher.runOnce();
  assert.equal(state.currentSessionId, null);
  fs.appendFileSync(eventsFile, line.slice(line.length - 2));
  state = await watcher.runOnce();
  assert.equal(state.sessions.s1.status, 'running');
});

test('replaying events re-attributes the running task window', async () => {
  const { eventsFile, transcriptPath, watcher } = setup();
  let lines = event('task-start', '2026-10-29T10:08:00Z', transcriptPath);
  lines += event('task-stop', '2026-10-29T10:09:45Z', transcriptPath);
  lines += event('task-start', '2026-10-29T10:10:30Z', transcriptPath);
  fs.writeFileSync(eventsFile, lines);
  const state = await watcher.runOnce();
  assert.equal(state.sessions.s1.status, 'running');
  assert.equal(state.sessions.s1.taskCredits, 2);
  assert.equal(state.sessions.s1.conversationCredits, 7);
  assert.equal(state.lastCompleted.taskCredits, 5);
});

test('session-end does not steal the current session', async () => {
  const { eventsFile, transcriptPath, watcher } = setup();
  fs.writeFileSync(eventsFile, event('task-start', '2026-10-29T10:10:00Z', transcriptPath));
  fs.appendFileSync(eventsFile, event('session-end', '2026-10-29T10:20:00Z', path.join(path.dirname(transcriptPath), 'gone.jsonl'), 's2'));
  const state = await watcher.runOnce();
  assert.equal(state.currentSessionId, 's1');
  assert.equal(state.sessions.s2.endedAt, '2026-10-29T10:20:00Z');
});

test('calibrates a task once the balance counter settles', async () => {
  const { eventsFile, transcriptPath, watcher, logFile } = setupCalibrating();
  fs.writeFileSync(transcriptPath, record('r1', 2, at(20000)));
  fs.writeFileSync(logFile, quotaLine(at(0), 1000) + '\n');
  fs.writeFileSync(eventsFile, event('task-start', at(10000), transcriptPath));
  await watcher.runOnce();

  fs.appendFileSync(logFile, quotaLine(at(40000), 1002) + '\n');
  fs.appendFileSync(eventsFile, event('task-stop', at(30000), transcriptPath));
  let state = await watcher.runOnce();
  assert.equal(state.sessions.s1.status, 'completed');
  assert.equal(state.sessions.s1.calibration, null);

  fs.appendFileSync(logFile, quotaLine(at(600000), 1003) + '\n');
  state = await watcher.runOnce();
  assert.equal(state.sessions.s1.calibration.official, 3);
  assert.equal(state.sessions.s1.calibration.transcript, 2);
  assert.equal(state.sessions.s1.calibration.gap, 1);
  assert.equal(state.sessions.s1.calibration.message, '官网 3 · 记录 2.00 · 幕后 1.00');
});

test('a start snapshot older than the previous turn blocks task calibration', async () => {
  const { eventsFile, transcriptPath, watcher, logFile } = setupCalibrating();
  fs.writeFileSync(transcriptPath, record('r1', 2, at(15000)) + record('r2', 3, at(35000)));
  fs.writeFileSync(logFile, quotaLine(at(0), 1000) + '\n');
  fs.writeFileSync(eventsFile, event('task-start', at(10000), transcriptPath));
  await watcher.runOnce();
  fs.appendFileSync(eventsFile, event('task-stop', at(20000), transcriptPath));
  await watcher.runOnce();
  fs.appendFileSync(eventsFile, event('task-start', at(30000), transcriptPath));
  await watcher.runOnce();
  fs.appendFileSync(eventsFile, event('task-stop', at(40000), transcriptPath));
  await watcher.runOnce();

  fs.appendFileSync(logFile, quotaLine(at(600000), 1005) + '\n');
  const state = await watcher.runOnce();
  assert.equal(state.sessions.s1.calibration, null);
  assert.equal(state.window.official, 5);
  assert.equal(state.window.transcript, 5);
  assert.equal(state.window.gap, 0);
  assert.equal(state.window.turns, 2);
  assert.equal(state.window.message, '近 2 轮 官网 5 · 记录 5.00 · 幕后 0.00');
});

test('the window anchor advances so spans never double count', async () => {
  const { eventsFile, transcriptPath, watcher, logFile } = setupCalibrating();
  fs.writeFileSync(transcriptPath, record('r1', 5, at(15000)) + record('r2', 4, at(615000)));
  fs.writeFileSync(logFile, quotaLine(at(0), 1000) + '\n');
  fs.writeFileSync(eventsFile, event('task-start', at(10000), transcriptPath));
  await watcher.runOnce();
  fs.appendFileSync(eventsFile, event('task-stop', at(20000), transcriptPath));
  await watcher.runOnce();

  fs.appendFileSync(logFile, quotaLine(at(600000), 1005) + '\n');
  fs.appendFileSync(eventsFile, event('task-start', at(610000), transcriptPath));
  await watcher.runOnce();
  fs.appendFileSync(eventsFile, event('task-stop', at(620000), transcriptPath));
  await watcher.runOnce();
  let state = await watcher.runOnce();
  assert.equal(state.window.official, 5);
  assert.equal(state.window.turns, 1);

  fs.appendFileSync(logFile, quotaLine(at(1200000), 1009) + '\n');
  state = await watcher.runOnce();
  assert.equal(state.window.from, at(600000));
  assert.equal(state.window.official, 4);
  assert.equal(state.window.transcript, 4);
});

test('replayed history never fabricates a calibration', async () => {
  const { eventsFile, transcriptPath, watcher } = setup({ logPath: logFixture });
  fs.writeFileSync(eventsFile, event('task-start', '2026-10-29T10:10:00Z', transcriptPath));
  fs.appendFileSync(eventsFile, event('task-stop', '2026-10-29T10:12:30Z', transcriptPath));
  const state = await watcher.runOnce();
  assert.equal(state.sessions.s1.status, 'completed');
  assert.equal(state.sessions.s1.calibration, null);
  assert.equal(state.window, null);
});

test('replayed task-stop events skip the grace wait', async () => {
  const { eventsFile, transcriptPath, watcher } = setup({ stopGraceMs: 300 });
  let lines = event('task-start', '2026-10-29T10:00:00Z', transcriptPath);
  for (let index = 0; index < 3; index += 1) {
    lines += event('task-stop', `2026-10-29T10:0${index + 1}:00Z`, transcriptPath);
    lines += event('task-start', `2026-10-29T10:0${index + 2}:00Z`, transcriptPath);
  }
  fs.writeFileSync(eventsFile, lines);
  const started = Date.now();
  await watcher.runOnce();
  assert.ok(Date.now() - started < 300, 'replay must not wait for the transcript grace period');
});

test('keeps only the most recent sessions in state', async () => {
  const { eventsFile, transcriptPath, watcher } = setup();
  let lines = '';
  for (let index = 0; index < 25; index += 1) {
    const sessionId = `s${index}`;
    const at = `2026-10-29T10:${String(index).padStart(2, '0')}:00Z`;
    lines += event('task-start', at, transcriptPath, sessionId);
  }
  fs.writeFileSync(eventsFile, lines);
  const state = await watcher.runOnce();
  assert.equal(Object.keys(state.sessions).length, 20);
  assert.equal(state.currentSessionId, 's24');
  assert.ok(state.sessions.s24);
  assert.equal(state.sessions.s0, undefined);
});

test('state file is replaced without a missing-file window', async () => {
  const { eventsFile, transcriptPath, watcher } = setup();
  fs.writeFileSync(eventsFile, event('task-start', '2026-10-29T10:10:00Z', transcriptPath));
  await watcher.runOnce();
  const stateFile = watcher.stateFile;
  assert.ok(fs.existsSync(stateFile));
  await watcher.runOnce();
  assert.ok(fs.existsSync(stateFile));
  assert.equal(fs.readdirSync(path.dirname(stateFile)).filter((n) => n.endsWith('.tmp')).length, 0);
});

test('a session ledger alone never fabricates exact task ownership', async () => {
  const { eventsFile, transcriptPath, sessionId, watcher } = setupLedger();
  sealLedger(transcriptPath, sessionId, 0, SESSION_STATE_KEY, { updatedAt: at(10000) });
  fs.appendFileSync(transcriptPath, record('r1', 2, at(20000)));
  fs.writeFileSync(eventsFile, event('task-start', at(10000), transcriptPath));
  await watcher.runOnce();

  sealLedger(transcriptPath, sessionId, 2.4, SESSION_STATE_KEY, {
    byModel: { mmodel: { credits: 2.4 } },
    latestRequestId: 'r1',
    updatedAt: at(40000)
  });
  fs.appendFileSync(eventsFile, event('task-stop', at(30000), transcriptPath));
  await watcher.runOnce();
  const state = await watcher.runOnce();
  const session = state.sessions.s1;
  assert.equal(session.status, 'completed');
  assert.equal(session.taskCredits, 2);
  assert.equal(session.taskTranscriptCredits, 2);
  assert.equal(session.taskByModel.mmodel.chat, 2);
  assert.equal(session.taskByModel.mmodel.hidden, 0);
  assert.equal(session.taskByModel.mmodel.total, 2);
  assert.equal(session.calibration, null);
  assert.equal(session.taskSettlement, 'pending');
  assert.equal(session.ledgerReconciliation.unmatchedCredits, 0.4);
  assert.equal(session.exactConversationCredits, 2.4);
});

test('integer quota calibration never replaces actual task amounts', async () => {
  const { eventsFile, transcriptPath, sessionId, watcher, logFile } = setupLedger();
  fs.appendFileSync(transcriptPath, record('r1', 2, at(20000)));
  sealLedger(transcriptPath, sessionId, 50, SESSION_STATE_KEY, {
    byModel: { mmodel: { credits: 50 } },
    latestRequestId: 'r1',
    updatedAt: at(25000)
  });
  fs.writeFileSync(logFile, quotaLine(at(0), 1000) + '\n');
  fs.writeFileSync(eventsFile, event('task-start', at(10000), transcriptPath));
  await watcher.runOnce();

  sealLedger(transcriptPath, sessionId, 52.5, SESSION_STATE_KEY, {
    byModel: { mmodel: { credits: 52.5 } },
    latestRequestId: 'r1',
    updatedAt: at(40000)
  });
  fs.appendFileSync(logFile, quotaLine(at(600000), 1003) + '\n');
  fs.appendFileSync(eventsFile, event('task-stop', at(30000), transcriptPath));
  await watcher.runOnce();
  const state = await watcher.runOnce();
  assert.equal(state.sessions.s1.calibration.source, 'quota');
  assert.equal(state.sessions.s1.calibration.approximate, true);
  assert.equal(state.sessions.s1.taskCredits, 2);
});

test('an unidentified delayed flush stays at session level', async () => {
  const { eventsFile, transcriptPath, sessionId, watcher } = setupLedger();
  sealLedger(transcriptPath, sessionId, 0, SESSION_STATE_KEY, { updatedAt: at(10000) });
  fs.writeFileSync(eventsFile, event('task-start', at(10000), transcriptPath));
  await watcher.runOnce();

  fs.appendFileSync(transcriptPath, record('r1', 2, at(20000)));
  sealLedger(transcriptPath, sessionId, 2, SESSION_STATE_KEY, {
    byModel: { mmodel: { credits: 2 } },
    latestRequestId: 'r1',
    updatedAt: at(25000)
  });
  fs.appendFileSync(eventsFile, event('task-stop', at(30000), transcriptPath));
  await watcher.runOnce();
  await watcher.runOnce();
  let state = await watcher.runOnce();
  assert.equal(state.sessions.s1.taskCredits, 2);
  assert.equal(state.lastCompleted.taskCredits, 2);

  // 任务停下后触发的后台调用要等下一轮才写进账本，得记回刚结束的那个任务。
  fs.appendFileSync(eventsFile, event('task-start', at(50000), transcriptPath));
  sealLedger(transcriptPath, sessionId, 3.5, SESSION_STATE_KEY, {
    byModel: { mmodel: { credits: 2 }, qmodel_38max: { credits: 1.5 } },
    latestRequestId: 'r1',
    updatedAt: at(60000)
  });
  await watcher.runOnce();
  state = await watcher.runOnce();
  assert.equal(state.lastCompleted.taskCredits, 2);
  assert.equal(state.sessions.s1.taskCredits, 0);
  assert.equal(state.sessions.s1.ledgerReconciliation.unmatchedCredits, 1.5);
});

test('a rotated key degrades to the transcript figure instead of breaking', async () => {
  const { eventsFile, transcriptPath, sessionId, watcher } = setupLedger();
  sealLedger(transcriptPath, sessionId, 10, crypto.randomBytes(32));
  fs.appendFileSync(transcriptPath, record('r1', 2, at(20000)));
  fs.writeFileSync(eventsFile, event('task-start', at(10000), transcriptPath));
  await watcher.runOnce();
  fs.appendFileSync(eventsFile, event('task-stop', at(30000), transcriptPath));
  const state = await watcher.runOnce();
  assert.equal(state.sessions.s1.taskCredits, 2);
  assert.equal(state.sessions.s1.calibration, null);
  assert.equal(state.sessions.s1.exactConversationCredits, null);
});

test('unproven legacy attribution is not reused after restart', async () => {
  const { dir, eventsFile, transcriptPath, sessionId, watcher } = setupLedger();
  fs.appendFileSync(transcriptPath, record('r1', 2, at(20000)));
  sealLedger(transcriptPath, sessionId, 2, SESSION_STATE_KEY, {
    byModel: { mmodel: { credits: 2 } }, latestRequestId: 'r1', updatedAt: at(10000)
  });
  fs.writeFileSync(eventsFile, event('task-start', at(10000), transcriptPath));
  await watcher.runOnce();

  // 任务跑着的时候账本多出 1.00 的幕后消耗，记在这个任务上。
  sealLedger(transcriptPath, sessionId, 3, SESSION_STATE_KEY, {
    byModel: { mmodel: { credits: 3 } }, latestRequestId: 'r1', updatedAt: at(30000)
  });
  await watcher.runOnce();
  let state = await watcher.runOnce();
  assert.equal(state.sessions.s1.taskByModel.mmodel.hidden, 0);

  // 监视器重启后接着上次的账本算，之前的归因不能丢。
  const restarted = new Watcher({
    dataDir: dir,
    eventsFile,
    stateFile: path.join(dir, 'state.json'),
    logPath: path.join(dir, 'main.log'),
    stopGraceMs: 0,
    launchOverlay: false,
    usageLogRoot: null,
    startedAt: '2026-01-01T00:00:00.000Z'
  });
  await restarted.runOnce();
  state = await restarted.runOnce();
  assert.equal(state.sessions.s1.taskByModel.mmodel.hidden, 0);

  sealLedger(transcriptPath, sessionId, 3.5, SESSION_STATE_KEY, {
    byModel: { mmodel: { credits: 3.5 } }, latestRequestId: 'r1', updatedAt: at(40000)
  });
  await restarted.runOnce();
  state = await restarted.runOnce();
  assert.equal(state.sessions.s1.taskByModel.mmodel.hidden, 0);
  assert.equal(state.sessions.s1.taskCredits, 2);
});

function addEvidence(index, requestId, ownerId, credits, subtask = 'agent_sub_skill_evolution') {
  const server = `server-${requestId}`, child = `child-${requestId}`;
  const pre = '2026-10-30T12:27:10.553+08:00';
  index.addLine('run', `${pre} DEBUG debug.message [SubAgentLifecycle] createForSubagent: requestSetId=${child}, businessInfo={"id":"${ownerId}","sub_task":"${subtask}"}`);
  index.addLine('run', `${pre} INFO  debug.message [qoder-server-request] <-- operation=sendRemoteChatAsk status=200 serverRequestId=${server} requestSetId=${child}`);
  index.addLine('run', `${pre} INFO  debug.message [QoderInferResponse] reason=agent-loop:test, sessionId=s1, qoderRequestId=${requestId}, serverRequestId=${server}, status=200`);
  if (credits !== null) index.addLine('run', `${pre} DEBUG debug.message [ForkCompletionBilling] requestIndex=0, requestId=${requestId}, model=mmodel, credits=${credits}, originalCredits=999, billable=true, creditCalculation=included`);
}

test('a late cost with an explicit owner updates the previous turn while the next runs', async () => {
  const usageIndex = new UsageLogIndex({ root: null });
  const { eventsFile, transcriptPath, watcher } = setupLedger({ usageIndex });
  fs.writeFileSync(eventsFile, event('task-start', at(10000), transcriptPath));
  fs.appendFileSync(transcriptPath, record('r1', 2, at(20000)));
  addEvidence(usageIndex, 'r1', 'turn-A', null, '');
  await watcher.runOnce();
  fs.appendFileSync(eventsFile, event('task-stop', at(30000), transcriptPath));
  await watcher.runOnce();
  fs.appendFileSync(eventsFile, event('task-start', at(40000), transcriptPath));
  fs.appendFileSync(transcriptPath, record('r2', 3, at(50000)));
  addEvidence(usageIndex, 'r2', 'turn-B', null, '');
  addEvidence(usageIndex, 'hidden-A', 'turn-A', 0.4);
  const state = await watcher.runOnce();
  assert.equal(state.sessions.s1.taskCredits, 3);
  assert.equal(state.lastCompleted.taskCredits, 2.4);
  assert.equal(state.sessions.s1.taskRequestSetId, 'turn-B');
  assert.equal(state.sessions.s1.taskSettlement, 'pending');
});

test('exact evidence is restored, and old residual attributions are discarded', async () => {
  const usageIndex = new UsageLogIndex({ root: null });
  const { dir, eventsFile, transcriptPath, watcher } = setupLedger({ usageIndex });
  fs.writeFileSync(eventsFile, event('task-start', at(10000), transcriptPath));
  fs.appendFileSync(transcriptPath, record('r1', 2, at(20000)));
  addEvidence(usageIndex, 'r1', 'turn-A', null, '');
  addEvidence(usageIndex, 'h1', 'turn-A', 0.5);
  await watcher.runOnce();
  const restarted = new Watcher({ dataDir:dir, eventsFile, stateFile:path.join(dir,'state.json'), logPath:null, stopGraceMs:0, usageLogRoot:null });
  const state=await restarted.runOnce();
  assert.equal(state.sessions.s1.taskCredits,2.5);
  assert.equal(state.sessions.s1.taskRequestSetId,'turn-A');
  const cache=JSON.parse(fs.readFileSync(watcher.attributionFile));
  assert.equal(cache.version,2);
  assert.equal(cache.usageRecords.length,2);
});

test('a free main request can still identify its paid background owner', async () => {
  const usageIndex = new UsageLogIndex({ root: null });
  const { eventsFile, transcriptPath, watcher } = setupLedger({ usageIndex });
  fs.writeFileSync(eventsFile, event('task-start', at(10000), transcriptPath));
  fs.appendFileSync(transcriptPath, record('free-main', 17, at(20000), 'dfmodel').replace('"billable":true', '"billable":false'));
  addEvidence(usageIndex, 'free-main', 'free-turn', null, '');
  addEvidence(usageIndex, 'paid-hidden', 'free-turn', 0.75);
  const state = await watcher.runOnce();
  assert.equal(state.sessions.s1.taskCredits,0.75);
  assert.equal(state.sessions.s1.taskRequestSetId,'free-turn');
});
