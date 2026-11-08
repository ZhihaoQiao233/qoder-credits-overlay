import fs from 'node:fs';
import path from 'node:path';
import { JsonlTailer } from './transcript.js';

export class SubagentScanner {
  constructor(transcriptPath) {
    this.sessionId = path.basename(transcriptPath, path.extname(transcriptPath));
    this.directory = path.join(path.dirname(transcriptPath), this.sessionId, 'subagents');
    this.tailers = new Map();
    this.toolUseIds = new Map();
  }

  scanNew() {
    let names;
    try {
      names = fs.readdirSync(this.directory);
    } catch {
      return [];
    }
    const records = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(this.directory, name);
      if (!this.tailers.has(filePath)) this.tailers.set(filePath, new JsonlTailer(filePath));
      try {
        const meta = JSON.parse(fs.readFileSync(filePath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
        if (typeof meta.toolUseId === 'string') this.toolUseIds.set(name, meta.toolUseId);
      } catch {}
      records.push(...this.tailers.get(filePath).readNew()
        .filter(record => record.sessionId === this.sessionId)
        .map(record => ({ ...record, subagentFile: name })));
    }
    return records;
  }
}

export function scanSubagentRecords(transcriptPath, fromIso, toIso) {
  const scanner = new SubagentScanner(transcriptPath);
  return scanner
    .scanNew()
    .filter((record) => record.billable && record.timestamp >= fromIso && record.timestamp <= toIso);
}
