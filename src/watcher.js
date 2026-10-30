import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UsageAggregator } from './aggregator.js';
import { JsonlTailer, splitCompleteLines } from './transcript.js';
import { SubagentScanner } from './subagents.js';
import { QuotaLogReader } from './account-usage.js';
import { readSessionCredits, stateFileFor, workspaceRootOf } from './session-state.js';
import * as appPaths from './paths.js';
import { UsageLogIndex } from './usage-log.js';
import { atomicWriteJson } from './atomic-state.js';

const round2 = (value) => Math.round(value * 100) / 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const calibrationMessage = (official, transcript, turns) =>
  `${turns ? `近 ${turns} 轮 ` : ''}官网 ${official} · 记录 ${transcript.toFixed(2)} · 幕后 ${(official - transcript).toFixed(2)}`;
const MAX_SESSIONS = 20;
const MAX_TURNS = 50;
const MAX_TASKS = 20;
const LOG_PROBE_MS = 30000;
const OVERLAY_RESPAWN_MS = 5000;
const SETTLE_MS = 180000;

class EventTailer {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.remainder = '';
  }

  readNew() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return [];
    }
    if (stat.size < this.offset) {
      this.offset = 0;
      this.remainder = '';
    }
    if (stat.size === this.offset) return [];

    const length = stat.size - this.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(this.filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = stat.size;

    const split = splitCompleteLines(this.remainder + buffer.toString('utf8'));
    this.remainder = split.remainder;
    const events = [];
    for (const line of split.lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // A damaged event line must not stop the watcher.
      }
    }
    return events;
  }
}

export class Watcher {
  constructor(options = {}) {
    this.dataDir = options.dataDir || appPaths.dataDir();
    this.eventsFile = options.eventsFile || appPaths.eventsPath();
    this.stateFile = options.stateFile || appPaths.statePath();
    this.attributionFile = options.attributionFile || path.join(this.dataDir, 'attribution.json');
    this.followLog = options.logPath === undefined;
    this.logPath = this.followLog ? null : options.logPath;
    this.stopGraceMs = options.stopGraceMs ?? 1000;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.launchOverlay = options.launchOverlay ?? false;
    this.overlayScript = options.overlayScript || appPaths.overlayScript();
    this.aggregator = new UsageAggregator();
    this.eventTailer = new EventTailer(this.eventsFile);
    this.quota = new QuotaLogReader(() => this.#resolveLogPath());
    this.logProbe = null;
    this.sessions = new Map();
    this.currentSessionId = null;
    this.lastCompleted = null;
    this.completedTurns = [];
    this.quotaAnchor = null;
    this.window = null;
    this.timer = null;
    this.running = false;
    this.overlayPid = null;
    this.overlayRestart = false;
    this.startedAt = options.startedAt || new Date().toISOString();
    this.usageIndex = options.usageIndex || new UsageLogIndex({
      ...(options.usageLogRoot !== undefined ? { root: options.usageLogRoot } : {}),
      saved: this.#readAttribution()
    });
  }

  #readAttribution() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.attributionFile, 'utf8'));
      // Version 1 contained guessed flush ownership. It is not billing evidence.
      return raw.version === 2 && Array.isArray(raw.usageRecords) ? raw.usageRecords : [];
    } catch { return []; }
  }

  async #writeAttribution() {
    try {
      await atomicWriteJson(this.attributionFile, {
        version: 2, updatedAt: new Date().toISOString(), usageRecords: this.usageIndex.export()
      });
    } catch (error) { this.#logError(error); }
  }

  #resolveLogPath() {
    if (!this.followLog) return this.logPath;
    const now = Date.now();
    if (!this.logProbe || now - this.logProbe.at > LOG_PROBE_MS) {
      this.logProbe = { at: now, path: appPaths.mainLogPath() };
    }
    return this.logProbe.path;
  }

  #session(sessionId, transcriptPath) {
    if (!this.sessions.has(sessionId)) {
      if (!transcriptPath) throw new Error(`Missing transcript path for ${sessionId}`);
      const session = {
        sessionId,
        transcriptPath,
        mainTailer: new JsonlTailer(transcriptPath),
        subagents: new SubagentScanner(transcriptPath),
        startQuota: null,
        endedAt: null,
        root: undefined,
        ledger: null,
        ledgerMtime: null,
        tasks: [],
        reconciliation: null
      };
      this.sessions.set(sessionId, session);
    }
    return this.sessions.get(sessionId);
  }

  #ingest(session) {
    const mainRecords = session.mainTailer.readNew();
    if (mainRecords.length) this.aggregator.addRecords(session.sessionId, mainRecords);
    const subagentRecords = session.subagents.scanNew();
    if (subagentRecords.length) this.aggregator.addRecords(session.sessionId, subagentRecords);
  }

  #previousStop(before) {
    let previous = null;
    for (const turn of this.completedTurns) {
      if (turn.completedAt < before && (previous === null || turn.completedAt > previous)) {
        previous = turn.completedAt;
      }
    }
    return previous;
  }

  #ledger(session) {
    if (session.root === undefined) session.root = workspaceRootOf(session.transcriptPath);
    if (!session.root) return null;
    let mtime;
    try {
      mtime = fs.statSync(stateFileFor(session.transcriptPath)).mtimeMs;
    } catch {
      session.ledger = null;
      session.ledgerMtime = null;
      return null;
    }
    if (session.ledgerMtime !== mtime) {
      session.ledgerMtime = mtime;
      session.ledger = readSessionCredits(session.transcriptPath, session.root);
    }
    return session.ledger;
  }

  // state.json 的 credits.byModel 是按模型分的累计实扣，transcript 里没有 compact、
  // memory_generation、skill_evolution 这些调用，两边做差就是被藏起来的那部分消耗。
  #residualHidden(session, ledger) {
    const fallback = new Date(new Date(ledger.updatedAt).getTime() + 1000).toISOString();
    const transcript = this.aggregator.sumByModelThrough(
      session.sessionId,
      ledger.latestRequestId,
      fallback
    );
    const residual = {};
    for (const [model, entry] of Object.entries(ledger.byModel ?? {})) {
      const value = (entry?.credits ?? 0) - (transcript[model] ?? 0);
      if (value > 0.0001) residual[model] = value;
    }
    return residual;
  }

  // Attribution is an ID join, never a timestamp/flush-window guess.
  #attributeHidden(session) {
    this.usageIndex.scan(session.sessionId);
    const evidence = this.usageIndex.records(session.sessionId);
    const byRequest = new Map(evidence.map(r => [r.requestId, r]));
    const records = this.aggregator.records(session.sessionId);
    const observed = this.aggregator.observedRequests(session.sessionId);
    const transcriptIds = new Set(observed.map(r => r.requestId));
    const hidden = evidence.filter(r => r.hasMetering && r.credits !== null && !transcriptIds.has(r.requestId));
    const knownByModel = {};
    for (const r of hidden) knownByModel[r.model] = (knownByModel[r.model] ?? 0) + r.credits;
    for (const task of session.tasks) {
      const windowRecords = records.filter(r => r.timestamp >= task.start && (!task.stop || r.timestamp <= task.stop));
      const windowObserved = observed.filter(r => r.timestamp >= task.start && (!task.stop || r.timestamp <= task.stop));
      const owners = new Set(windowObserved.map(r => byRequest.get(r.requestId)?.ownerId).filter(Boolean));
      if (task.requestSetId) owners.add(task.requestSetId);
      task.ownerId = owners.size === 1 ? [...owners][0] : null;
      // Multiple Hook submissions can be steering messages in the same official
      // request set. In that case show the official row's complete known chat.
      const chat = task.ownerId ? records.filter(r => byRequest.get(r.requestId)?.ownerId === task.ownerId ||
        (!byRequest.get(r.requestId)?.ownerId && windowRecords.includes(r))) : windowRecords;
      task.chatByModel = {};
      for (const r of chat) task.chatByModel[r.model] = (task.chatByModel[r.model] ?? 0) + r.credits;
      task.hidden = {};
      if (task.ownerId) for (const r of hidden.filter(r => r.ownerId === task.ownerId)) {
        task.hidden[r.model] = (task.hidden[r.model] ?? 0) + r.credits;
      }
      task.attribution = task.ownerId && chat.every(r => byRequest.get(r.requestId)?.ownerId === task.ownerId) ? 'request-id' : 'transcript-only';
      if (task.stop && this.lastCompleted?.sessionId === session.sessionId && this.lastCompleted.at === task.stop) {
        this.lastCompleted.taskCredits = this.#taskTotal(task);
        this.lastCompleted.settlement = 'pending';
        this.lastCompleted.requestSetId = task.ownerId;
      }
    }
    const ledger = this.#ledger(session);
    if (!ledger) { session.reconciliation = null; return; }
    const residual = this.#residualHidden(session, ledger);
    const models = new Set([...Object.keys(residual), ...Object.keys(knownByModel)]);
    const unmatchedByModel = {}, aheadByModel = {};
    let unmatched = 0, ahead = 0;
    for (const model of models) {
      const gap = (residual[model] ?? 0) - (knownByModel[model] ?? 0);
      if (gap > 0.0001) { unmatchedByModel[model] = gap; unmatched += gap; }
      if (gap < -0.0001) { aheadByModel[model] = -gap; ahead -= gap; }
    }
    session.reconciliation = {
      unmatchedCredits: round2(unmatched), unmatchedByModel,
      loggedCreditsNotInLedger: round2(ahead), loggedCreditsNotInLedgerByModel: aheadByModel,
      // Neither silence nor a stable cumulative ledger proves background work ended.
      settlement: 'pending'
    };
  }

  #taskTotal(task) {
    let total = 0;
    for (const value of Object.values(task.chatByModel ?? {})) total += value;
    for (const value of Object.values(task.hidden ?? {})) total += value;
    return round2(total);
  }

  #taskBreakdown(session, snapshot) {
    const task = session.tasks.length ? session.tasks[session.tasks.length - 1] : null;
    const chat = task?.chatByModel ?? snapshot.taskByModel ?? {};
    const hidden = task?.hidden ?? {};
    const byModel = {};
    let total = 0;
    for (const model of new Set([...Object.keys(chat), ...Object.keys(hidden)])) {
      const chatCredits = chat[model] ?? 0;
      const hiddenCredits = hidden[model] ?? 0;
      byModel[model] = {
        chat: round2(chatCredits),
        hidden: round2(hiddenCredits),
        total: round2(chatCredits + hiddenCredits)
      };
      total += chatCredits + hiddenCredits;
    }
    return { credits: round2(total), byModel, ownerId: task?.ownerId ?? null, attribution: task?.attribution ?? 'transcript-only' };
  }

  #taskCalibration(session, snapshot, exact) {
    const transcript = round2(snapshot.taskCredits);
    if (exact.ownerId) {
      return {
        source: 'worker-log', official: null, knownActual: exact.credits, transcript,
        gap: round2(Object.values(exact.byModel).reduce((sum, m) => sum + m.hidden, 0)),
        message: `已记录实扣 ${exact.credits.toFixed(2)} · 后台待结清`
      };
    }
    const latest = this.quota.read();
    if (!session.startQuota || !latest || !snapshot.completedAt) return null;
    // The counter absorbs a turn's background calls minutes after it stops, so
    // an early snapshot would report the transcript figure back as "official".
    const settledAt = new Date(new Date(snapshot.completedAt).getTime() + this.settleMs).toISOString();
    if (latest.at < settledAt) return null;
    const previousStop = this.#previousStop(snapshot.startedAt);
    if (previousStop && session.startQuota.at <= previousStop) return null;
    const inside = this.completedTurns.filter(
      (turn) => turn.completedAt > session.startQuota.at && turn.completedAt <= latest.at
    );
    if (inside.length !== 1 || inside[0].completedAt !== snapshot.completedAt) return null;
    const official = latest.used - session.startQuota.used;
    if (official < 0) return null;
    return {
      source: 'quota',
      approximate: true,
      official,
      transcript,
      gap: round2(official - transcript),
      from: session.startQuota.at,
      to: latest.at,
      message: calibrationMessage(official, transcript)
    };
  }

  #windowCalibration() {
    const latest = this.quota.read();
    if (!latest) return;
    if (!this.quotaAnchor) {
      this.quotaAnchor = latest;
      return;
    }
    if (latest.at <= this.quotaAnchor.at) return;
    const from = this.quotaAnchor.at;
    const turns = this.completedTurns.filter(
      (turn) => turn.startedAt >= from && turn.completedAt <= latest.at
    );
    if (turns.length === 0) return;
    const official = latest.used - this.quotaAnchor.used;
    this.quotaAnchor = latest;
    if (official < 0) {
      this.window = null;
      return;
    }
    let transcript = 0;
    for (const sessionId of this.sessions.keys()) {
      transcript += this.aggregator.sumBetween(sessionId, from, latest.at);
    }
    transcript = round2(transcript);
    this.window = {
      official,
      transcript,
      gap: round2(official - transcript),
      turns: turns.length,
      from,
      to: latest.at,
      message: calibrationMessage(official, transcript, turns.length)
    };
  }

  async #processEvent(event) {
    if (!event?.sessionId || !event?.transcriptPath) return;
    const session = this.#session(event.sessionId, event.transcriptPath);
    // Events older than this process are replayed history: the balance snapshot
    // from back then is gone and their transcript is already complete.
    const replayed = typeof event.at === 'string' && event.at < this.startedAt;

    if (event.event === 'task-start') {
      this.currentSessionId = event.sessionId;
      this.aggregator.startTask(event.sessionId, event.at);
      session.startQuota = replayed ? null : this.quota.read();
      session.endedAt = null;
      const task = { start: event.at, stop: null, hidden: {}, requestSetId: event.requestSetId ?? null };
      session.tasks.push(task);
      if (session.tasks.length > MAX_TASKS) session.tasks.shift();
    } else if (event.event === 'task-stop') {
      this.currentSessionId = event.sessionId;
      this.aggregator.stopTask(event.sessionId, event.at);
      if (!replayed && this.stopGraceMs > 0) await sleep(this.stopGraceMs);
      this.#ingest(session);
      const snapshot = this.aggregator.snapshot(event.sessionId);
      for (const task of session.tasks) {
        if (task.stop) continue;
        task.stop = event.at;
        task.chat = round2(snapshot.taskCredits);
        task.chatByModel = snapshot.taskByModel;
      }
      const exact = this.#taskBreakdown(session, snapshot);
      this.lastCompleted = {
        sessionId: event.sessionId,
        taskCredits: exact.credits,
        at: event.at
      };
      this.completedTurns.push({
        sessionId: event.sessionId,
        startedAt: snapshot.startedAt,
        completedAt: event.at
      });
      if (this.completedTurns.length > MAX_TURNS) this.completedTurns.shift();
    } else if (event.event === 'session-end') {
      session.endedAt = event.at;
    }
    this.#ingest(session);
  }

  #activity(session, snapshot) {
    return snapshot.completedAt || snapshot.startedAt || session.endedAt || '';
  }

  #pruneSessions() {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const ranked = [...this.sessions.values()]
      .map((session) => ({ session, at: this.#activity(session, this.aggregator.snapshot(session.sessionId)) }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const keep = new Set(ranked.slice(0, MAX_SESSIONS).map((entry) => entry.session.sessionId));
    if (this.currentSessionId) keep.add(this.currentSessionId);
    for (const sessionId of [...this.sessions.keys()]) {
      if (keep.has(sessionId)) continue;
      this.sessions.delete(sessionId);
      this.aggregator.forget(sessionId);
    }
  }

  #buildState() {
    const sessions = {};
    for (const [sessionId, session] of this.sessions) {
      const snapshot = this.aggregator.snapshot(sessionId);
      const ledger = this.#ledger(session);
      const exact = this.#taskBreakdown(session, snapshot);
      sessions[sessionId] = {
        taskCredits: exact.credits,
        taskTranscriptCredits: round2(snapshot.taskCredits),
        taskByModel: exact.byModel,
        taskRequestSetId: exact.ownerId,
        taskAttribution: exact.attribution,
        taskSettlement: 'pending',
        ledgerReconciliation: session.reconciliation,
        recentTasks: session.tasks.map(t => ({ startedAt: t.start, completedAt: t.stop,
          requestSetId: t.ownerId, knownActual: this.#taskTotal(t), attribution: t.attribution,
          settlement: 'pending', hiddenByModel: t.hidden })),
        conversationCredits: round2(snapshot.conversationCredits),
        exactConversationCredits: ledger ? round2(ledger.totalCredits) : null,
        status: snapshot.status,
        startedAt: snapshot.startedAt,
        completedAt: snapshot.completedAt,
        endedAt: session.endedAt,
        calibration: snapshot.completedAt ? this.#taskCalibration(session, snapshot, exact) : null
      };
    }
    return {
      updatedAt: new Date().toISOString(),
      currentSessionId: this.currentSessionId,
      lastCompleted: this.lastCompleted,
      window: this.window,
      sessions
    };
  }

  async #writeState(state) {
    await atomicWriteJson(this.stateFile, state);
  }

  async runOnce() {
    for (const event of this.eventTailer.readNew()) {
      await this.#processEvent(event);
    }
    this.#pruneSessions();
    for (const session of this.sessions.values()) {
      this.#ingest(session);
      this.#attributeHidden(session);
    }
    this.#windowCalibration();
    const state = this.#buildState();
    await this.#writeState(state);
    await this.#writeAttribution();
    return state;
  }

  #spawnOverlay() {
    if (!fs.existsSync(this.overlayScript)) return;
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-STA', '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', this.overlayScript],
        // DETACHED_PROCESS leaves PowerShell without a console and it exits at
        // once, so the child stays attached but hidden and unref'd.
        { stdio: 'ignore', windowsHide: true }
      );
    } catch (error) {
      this.#log(`overlay 启动失败：${error.message}`);
      return;
    }
    this.overlayPid = child.pid ?? null;
    this.overlaySpawnedAt = Date.now();
    child.on('error', (error) => {
      this.overlayPid = null;
      this.#log(`overlay 启动失败：${error.message}`);
    });
    child.on('exit', (code, signal) => {
      this.overlayPid = null;
      // 悬浮窗进程一旦没了就要重新拉起，否则胶囊会永远消失。
      this.overlayRestart = true;
      this.#log(`overlay 退出 code=${code} signal=${signal ?? '-'}`);
    });
    child.unref();
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (this.launchOverlay) this.#spawnOverlay();
    const tick = async () => {
      if (!this.running) return;
      try {
        if (
          this.launchOverlay &&
          this.overlayRestart &&
          !this.overlayPid &&
          Date.now() - (this.overlaySpawnedAt ?? 0) > OVERLAY_RESPAWN_MS
        ) {
          this.overlayRestart = false;
          this.#spawnOverlay();
        }
        await this.runOnce();
      } catch (error) {
        this.#logError(error);
      }
      if (this.running) this.timer = setTimeout(tick, 1000);
    };
    tick();
  }

  close() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  #log(message) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(path.join(this.dataDir, 'error.log'), `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Logging must never take down the watcher.
    }
  }

  #logError(error) {
    this.#log(error.stack);
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockFile) {
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (pid && processAlive(pid)) return false;
  } catch {
    // Missing lock or stale contents are handled by rewriting it below.
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, String(process.pid));
  return true;
}

async function main() {
  const lockFile = appPaths.lockPath();
  if (!acquireLock(lockFile)) return;
  const watcher = new Watcher({ launchOverlay: true });
  const cleanup = () => {
    watcher.close();
    fs.rmSync(lockFile, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => fs.rmSync(lockFile, { force: true }));
  watcher.start();
}

const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const self = fileURLToPath(import.meta.url).toLowerCase();
if (entry === self) {
  main().catch((error) => {
    const dir = appPaths.dataDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'error.log'), `${new Date().toISOString()} ${error.stack}\n`);
    } catch {
      // Ignore secondary failures while reporting the primary one.
    }
    process.exit(1);
  });
}
