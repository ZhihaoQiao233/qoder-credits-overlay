// 自检脚本：把「账本 vs transcript」的差值直接算出来。
// 用法：node tools/selfcheck.mjs <sessionId>.jsonl 的完整路径 <会话的 cwd>
// 只读本机文件，不联网、不碰凭据。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KEY = Buffer.from([
  44, 6, 96, 159, 67, 137, 172, 134, 152, 52, 157, 248, 15, 219, 49, 114,
  225, 17, 195, 37, 71, 151, 145, 95, 214, 226, 9, 169, 250, 96, 125, 232
]);

const [jsonl, cwd] = process.argv.slice(2);
if (!jsonl || !cwd) {
  console.error('usage: node tools/selfcheck.mjs <session.jsonl> <cwd>');
  process.exit(1);
}

const sessionId = path.basename(jsonl, '.jsonl');
const statePath = path.join(path.dirname(jsonl), sessionId, 'state.json');
const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const seg = raw.items.s0;
const normalized = path.resolve(cwd).replace(/\\/g, '/').toLowerCase();
const projectHash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
const aad = Buffer.from(
  JSON.stringify({ sessionId: raw.sessionId, projectHash, segmentKey: 's0' }),
  'utf8'
);
const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(seg.n, 'base64'));
decipher.setAAD(aad);
decipher.setAuthTag(Buffer.from(seg.t, 'base64'));
const payload = JSON.parse(
  Buffer.concat([decipher.update(Buffer.from(seg.p, 'base64')), decipher.final()]).toString('utf8')
);

const records = [];
for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  if (obj?.type !== 'assistant') continue;
  const usage = obj.message?.usage;
  if (!usage || typeof usage.credits !== 'number' || usage.billable !== true) continue;
  records.push({
    requestId: usage.request_id || obj.message?.id || obj.uuid,
    credits: usage.credits,
    timestamp: obj.timestamp,
    model: obj.message?.model || 'unknown'
  });
}

const cut = records.findIndex((record) => record.requestId === payload.latestRequestId);
const end = cut < 0 ? records.length - 1 : cut;
const through = {};
const allByModel = {};
for (const record of records) {
  allByModel[record.model] = (allByModel[record.model] ?? 0) + record.credits;
}
for (let index = 0; index <= end; index += 1) {
  const record = records[index];
  through[record.model] = (through[record.model] ?? 0) + record.credits;
}

const residual = {};
for (const [model, entry] of Object.entries(payload.credits.byModel ?? {})) {
  const value = (entry?.credits ?? 0) - (through[model] ?? 0);
  if (Math.abs(value) > 1e-4) residual[model] = value;
}

console.log('state.json      ', statePath);
console.log('ledger updatedAt', payload.updatedAt);
console.log('ledger requestId', payload.latestRequestId);
console.log('ledger total    ', payload.credits.total);
console.log('ledger byModel  ', payload.credits.byModel);
console.log('transcript all  ', records.reduce((sum, record) => sum + record.credits, 0), allByModel);
console.log('transcript thru ', through);
console.log('RESIDUAL       ', residual, '（= 不在 transcript 里的幕后调用消耗）');
