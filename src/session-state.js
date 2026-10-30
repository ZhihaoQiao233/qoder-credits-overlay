import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Qoder 把每会话的总账写在 <sessionId>/state.json，s0 段用 AES-256-GCM 加密。
// 该主密钥硬编码在 qoder-worker-runtime.obf.mjs 里，随客户端升级可能更换；换掉时
// 这里会解密失败并返回 null，调用方应退回 transcript 口径而不是崩溃。
export const SESSION_STATE_KEY = Buffer.from([
  44, 6, 96, 159, 67, 137, 172, 134, 152, 52, 157, 248, 15, 219, 49, 114,
  225, 17, 195, 37, 71, 151, 145, 95, 214, 226, 9, 169, 250, 96, 125, 232
]);

const HEADER_BYTES = 8192;

export function projectHash(root) {
  const resolved = path.resolve(root).replace(/\\/g, '/');
  const normalized =
    process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function stateFileFor(jsonlPath) {
  const sessionId = path.basename(jsonlPath, path.extname(jsonlPath));
  return path.join(path.dirname(jsonlPath), sessionId, 'state.json');
}

export function workspaceRootOf(jsonlPath) {
  let text;
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const read = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
      text = buffer.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const firstLine = text.split('\n')[0];
  try {
    const header = JSON.parse(firstLine);
    if (header?.type !== 'workspace-directories') return null;
    const root = header.directories?.[0];
    return typeof root === 'string' && root ? root : null;
  } catch {
    return null;
  }
}

export function readSessionCredits(jsonlPath, root) {
  if (!root) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(stateFileFor(jsonlPath), 'utf8'));
  } catch {
    return null;
  }
  const segment = raw?.items?.s0;
  if (!segment?.n || !segment?.p || !segment?.t) return null;
  try {
    const aad = Buffer.from(
      JSON.stringify({ sessionId: raw.sessionId, projectHash: projectHash(root), segmentKey: 's0' }),
      'utf8'
    );
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      SESSION_STATE_KEY,
      Buffer.from(segment.n, 'base64')
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(segment.t, 'base64'));
    const payload = JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(segment.p, 'base64')), decipher.final()]).toString('utf8')
    );
    const total = payload?.credits?.total;
    if (typeof total !== 'number' || !Number.isFinite(total)) return null;
    return {
      updatedAt: payload.updatedAt ?? raw.updatedAt ?? null,
      latestRequestId: payload.latestRequestId ?? null,
      totalCredits: total,
      byModel: payload.credits.byModel ?? {}
    };
  } catch {
    return null;
  }
}
