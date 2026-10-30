// Read-only offline audit. Prints only whitelisted metering metadata.
import fs from 'node:fs';
import { UsageLogIndex } from '../src/usage-log.js';
import { parseTranscriptLine } from '../src/transcript.js';
import { readSessionCredits } from '../src/session-state.js';

const [transcriptPath, cwd, logRoot] = process.argv.slice(2);
if (!transcriptPath || !cwd) throw new Error('Usage: node tools/audit-usage.mjs <transcript.jsonl> <workspace> [qoder/logs]');
const rows = fs.readFileSync(transcriptPath, 'utf8').split('\n');
const sessionId = JSON.parse(rows[0]).sessionId;
const index = new UsageLogIndex(logRoot ? { root: logRoot } : {});
index.scan(sessionId);
const evidence = index.records(sessionId), lookup = new Map(evidence.map(r => [r.requestId, r]));
const observed = rows.map(parseTranscriptLine).filter(Boolean), ids = new Set(observed.map(r => r.requestId));
const transcript = [...new Map(observed.filter(r => r.billable).map(r => [r.requestId, r])).values()];
const turns = {}, transcriptByModel = {}, hiddenByModel = {};
const turn = id => turns[id] ??= { chatByModel: {}, hiddenByModel: {}, backgroundRequests: [] };
for (const r of transcript) {
  transcriptByModel[r.model] = (transcriptByModel[r.model] ?? 0) + r.credits;
  const owner = lookup.get(r.requestId)?.ownerId;
  if (owner) { const t = turn(owner); t.chatByModel[r.model] = (t.chatByModel[r.model] ?? 0) + r.credits; }
}
const background = evidence.filter(r => r.hasMetering && !ids.has(r.requestId));
for (const r of background) {
  if (r.credits === null) continue;
  hiddenByModel[r.model] = (hiddenByModel[r.model] ?? 0) + r.credits;
  if (r.ownerId) { const t = turn(r.ownerId); t.hiddenByModel[r.model] = (t.hiddenByModel[r.model] ?? 0) + r.credits; t.backgroundRequests.push(r); }
}
const sum = obj => Object.values(obj).reduce((a,b) => a+b,0);
for (const t of Object.values(turns)) t.knownActual = sum(t.chatByModel) + sum(t.hiddenByModel);
const ledger = readSessionCredits(transcriptPath, cwd), differences = {};
for (const model of new Set([...Object.keys(transcriptByModel), ...Object.keys(hiddenByModel)])) {
  differences[model] = ledger ? (ledger.byModel[model]?.credits ?? 0) - (transcriptByModel[model] ?? 0) - (hiddenByModel[model] ?? 0) : null;
}
console.log(JSON.stringify({ sessionId, sourceLogs: [...index.files.keys()], ledger,
  transcriptTotal: sum(transcriptByModel), transcriptByModel, hiddenTotal: sum(hiddenByModel), hiddenByModel,
  loggedKnownActual: sum(transcriptByModel)+sum(hiddenByModel), ledgerMinusLoggedByModel: differences,
  unlinkedTranscriptRequests: transcript.filter(r => !lookup.get(r.requestId)?.ownerId).map(r => r.requestId),
  background, turns, settlement: 'pending: logs establish individual charges, not a universal finalization watermark'
}, null, 2));
