import fs from 'node:fs';
import path from 'node:path';
import { JsonlTailer } from './transcript.js';

export class SubagentScanner {
  constructor(transcriptPath) {
    this.directory = path.join(path.dirname(transcriptPath), 'subagents');
    this.tailers = new Map();
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
      records.push(...this.tailers.get(filePath).readNew());
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
