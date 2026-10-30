import fs from 'node:fs';

export function splitCompleteLines(buffer) {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  return { lines, remainder };
}

export function parseTranscriptLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || obj.type !== 'assistant') return null;
  const usage = obj.message?.usage;
  if (!usage || typeof usage.credits !== 'number') return null;
  return {
    requestId: usage.request_id || obj.message?.id || obj.uuid,
    credits: usage.credits,
    billable: usage.billable === true,
    timestamp: obj.timestamp,
    sessionId: obj.sessionId,
    model: obj.message?.model || 'unknown'
  };
}

export class JsonlTailer {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.remainder = '';
  }

  reset() {
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
    if (!stat.isFile()) return [];
    if (stat.size < this.offset) this.reset();
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

    const { lines, remainder } = splitCompleteLines(this.remainder + buffer.toString('utf8'));
    this.remainder = remainder;
    return lines.map(parseTranscriptLine).filter(Boolean);
  }
}
