import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';

const prefix = /^(\d{4}-\d\d-\d\dT\S+) (?:INFO|DEBUG)\s+debug\.message (.*)$/;
const validAmount = v => Number.isFinite(Number(v)) && Number(v) >= 0 && v !== 'missing';
function unique(map, key, value) {
  if (!map.has(key)) map.set(key, value);
  else if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) map.set(key, null);
}

// Parse only four whitelisted metadata lines. Never evaluate logs or keep prompts,
// request bodies, headers, account data, or credentials in the index.
export class UsageLogIndex {
  constructor({ root = path.join(os.homedir(), '.qoder', 'logs'), saved = [] } = {}) {
    this.root = root;
    this.runs = new Map();
    this.files = new Map();
    this.probes = new Map();
    this.saved = new Map();
    for (const r of saved) {
      if (!r?.sessionId || !r.requestId || (r.ownerId !== null && typeof r.ownerId !== 'string')) continue;
      if (r.credits !== null && r.credits !== undefined && (typeof r.credits !== 'number' || r.credits < 0 || !Number.isFinite(r.credits))) continue;
      this.saved.set(`${r.sessionId}:${r.requestId}`, r);
    }
  }

  addLine(runId, line) {
    const match = line.match(prefix);
    if (!match) return;
    const [, ts, message] = match;
    let run = this.runs.get(runId);
    if (!run) {
      run = { owners: new Map(), servers: new Map(), requests: new Map(), billing: new Map() };
      this.runs.set(runId, run);
    }
    let m = message.match(/^\[(?:SubAgentLifecycle\] createForSubagent:|AgentLoop\] lifecycle initialized:) requestSetId=([^,]+), (?:agentType=(?:main|sub), )?businessInfo=(\{.*\})$/);
    if (m) {
      try {
        const b = JSON.parse(m[2]);
        if (typeof b.id === 'string') unique(run.owners, m[1], { ownerId: b.id, subtask: b.sub_task ?? null });
      } catch { /* A partial or upgraded format is unavailable evidence. */ }
      return;
    }
    m = message.match(/^\[qoder-server-request\] <-- operation=sendRemoteChatAsk .*?serverRequestId=(\S+).*?requestSetId=(\S+)/);
    if (m) { unique(run.servers, m[1], m[2]); return; }
    m = message.match(/^\[QoderInferResponse\] reason=([^,]+), sessionId=([^,]+), qoderRequestId=([^,]+), serverRequestId=([^,]+),/);
    if (m) {
      let request = run.requests.get(m[3]);
      if (!request) { request = { sessionId: m[2], reason: m[1], servers: new Set() }; run.requests.set(m[3], request); }
      if (request.sessionId !== m[2]) request.sessionId = null;
      request.servers.add(m[4]);
      return;
    }
    m = message.match(/^\[ForkCompletionBilling\] requestIndex=\d+, requestId=([^,]+), model=([^,]+), credits=([^,]+), originalCredits=[^,]+, billable=([^,]+),/);
    if (m) {
      const amount = m[4] === 'false' ? 0 : m[4] === 'true' && validAmount(m[3]) ? Number(m[3]) : null;
      unique(run.billing, m[1], { model: m[2], credits: amount, billable: m[4] === 'true' ? true : m[4] === 'false' ? false : null });
      // Timestamp is metadata, never a join key.
      run.lastAt = ts;
    }
  }

  export() {
    const merged = new Map(this.saved);
    for (const run of this.runs.values()) {
      for (const [requestId, req] of run.requests) {
        if (!req.sessionId) continue;
        const owners = new Map();
        let missing = false;
        let ownerConflict = false;
        for (const serverId of req.servers) {
          const setId = run.servers.get(serverId), owner = run.owners.get(setId);
          if ((run.servers.has(serverId) && setId === null) || (run.owners.has(setId) && owner === null)) ownerConflict = true;
          if (!owner) missing = true;
          else owners.set(owner.ownerId, owner);
        }
        const owner = !missing && owners.size === 1 ? [...owners.values()][0] : null;
        const hasMetering = run.billing.has(requestId);
        const bill = run.billing.get(requestId);
        const record = { requestId, sessionId: req.sessionId, ownerId: owner?.ownerId ?? null, subtask: owner?.subtask ?? null,
          hasMetering, model: bill?.model ?? null, credits: bill?.credits ?? null, billable: bill?.billable ?? null };
        const key = `${req.sessionId}:${requestId}`, prior = merged.get(key);
        if (prior) {
          if (prior.ownerId && record.ownerId && prior.ownerId !== record.ownerId) record.ownerId = null;
          else if (!record.ownerId && !ownerConflict && owners.size < 2) {
            record.ownerId = prior.ownerId;
            record.subtask = prior.subtask;
          }
          if (!hasMetering && prior.hasMetering) Object.assign(record, { hasMetering: true, model: prior.model, credits: prior.credits, billable: prior.billable });
          else if (hasMetering && prior.hasMetering && (prior.credits !== record.credits || prior.billable !== record.billable)) record.credits = null;
        }
        merged.set(key, record);
      }
    }
    return [...merged.values()];
  }

  records(sessionId) { return this.export().filter(r => r.sessionId === sessionId); }

  scan(sessionId) {
    if (!this.root) return;
    const now = Date.now();
    if (!this.probes.has(sessionId) || now - this.probes.get(sessionId) > 30000) {
      this.probes.set(sessionId, now);
      let projects = [];
      try { projects = fs.readdirSync(path.join(this.root, 'sessions'), { withFileTypes: true }); } catch { /* Missing logs are supported. */ }
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const dir = path.join(this.root, 'sessions', project.name, sessionId, 'segments');
        let segments = [];
        try { segments = fs.readdirSync(dir); } catch { continue; }
        for (const name of segments.filter(n => n.endsWith('.jsonl'))) {
          const runId = name.slice(0, -6), file = path.join(this.root, 'runs', runId, 'qodercli.log');
          if (!this.files.has(file)) this.files.set(file, { runId, offset: 0, remainder: '', decoder: new StringDecoder('utf8') });
        }
      }
    }
    for (const [file, tail] of this.files) {
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        if (size < tail.offset) { tail.offset = 0; tail.remainder = ''; tail.decoder = new StringDecoder('utf8'); }
        const buffer = Buffer.alloc(65536);
        while (tail.offset < size) {
          const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - tail.offset), tail.offset);
          if (!n) break;
          tail.offset += n;
          const lines = (tail.remainder + tail.decoder.write(buffer.subarray(0, n))).split('\n');
          tail.remainder = lines.pop() ?? '';
          for (const line of lines) this.addLine(tail.runId, line.replace(/\r$/, ''));
          // An oversized damaged line must not consume unbounded memory.
          if (tail.remainder.length > 2 * 1024 * 1024) tail.remainder = '';
        }
      } catch { /* Busy, missing, or rotated logs must not stop the watcher. */ }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  }
}
