import fs from 'node:fs';
import { splitCompleteLines } from './transcript.js';

function quotaBucket(usage, key) {
  const bucket = usage?.[key];
  if (!bucket || typeof bucket.used !== 'number') return null;
  return bucket;
}

export function parseQuotaLine(line) {
  if (!line.includes('AccountUsage') || !line.includes('"qoderUsage"')) return null;
  const start = line.indexOf('{"operation"');
  if (start < 0) return null;
  let obj;
  try {
    obj = JSON.parse(line.slice(start).trim());
  } catch {
    return null;
  }
  const usage = obj.qoderUsage;
  if (!usage) return null;
  // A dedicated package absorbs consumption before the add-on quota does, so
  // leaving it out freezes `used` while credits are really being spent.
  const packages = Array.isArray(usage.dedicatedResourcePackages)
    ? usage.dedicatedResourcePackages.filter((pkg) => pkg && typeof pkg.used === 'number')
    : [];
  const buckets = [
    quotaBucket(usage, 'userQuota'),
    quotaBucket(usage, 'addOnQuota'),
    ...packages
  ].filter(Boolean);
  if (buckets.length === 0) return null;
  return {
    used: buckets.reduce((total, bucket) => total + (bucket.used || 0), 0),
    remaining: buckets.reduce((total, bucket) => total + (bucket.remaining || 0), 0),
    total: buckets.reduce((total, bucket) => total + (bucket.total || 0), 0),
    unit: buckets[0].unit || 'credits',
    at: (line.match(/^\[([^\]]+)\]/) || [, ''])[1]
  };
}

export function readLatestQuota(logPath) {
  if (!fs.existsSync(logPath)) return null;
  let latest = null;
  for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
    const quota = parseQuotaLine(line);
    if (quota) latest = quota;
  }
  return latest;
}

export class QuotaLogReader {
  constructor(resolvePath) {
    this.resolvePath = typeof resolvePath === 'function' ? resolvePath : () => resolvePath;
    this.path = null;
    this.offset = 0;
    this.remainder = '';
    this.latest = null;
  }

  #syncPath() {
    const next = this.resolvePath() || null;
    if (next !== this.path) {
      this.path = next;
      this.offset = 0;
      this.remainder = '';
      this.latest = null;
    }
    return next;
  }

  read() {
    const logPath = this.#syncPath();
    if (!logPath) return null;

    let stat;
    try {
      stat = fs.statSync(logPath);
    } catch {
      return this.latest;
    }
    if (!stat.isFile()) return this.latest;
    if (stat.size < this.offset) {
      this.offset = 0;
      this.remainder = '';
      this.latest = null;
    }
    if (stat.size === this.offset) return this.latest;

    const length = stat.size - this.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = stat.size;

    const split = splitCompleteLines(this.remainder + buffer.toString('utf8'));
    this.remainder = split.remainder;
    for (const line of split.lines) {
      const quota = parseQuotaLine(line);
      if (quota) this.latest = quota;
    }
    return this.latest;
  }
}
