import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as appPaths from './paths.js';

const eventName = process.argv[2];
const chunks = [];

for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!payload.session_id || !payload.transcript_path) {
    throw new Error('Hook payload is missing session_id or transcript_path');
  }
  const line = JSON.stringify({
    event: eventName,
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
    requestSetId: payload.parent_request_set_id ?? null,
    at: new Date().toISOString()
  });
  fs.mkdirSync(appPaths.dataDir(), { recursive: true });
  fs.appendFileSync(appPaths.eventsPath(), `${line}\n`);

  if (process.env.QODER_CREDITS_NO_SPAWN !== '1') {
    const child = spawn(process.execPath, [appPaths.watcherScript(), '--ensure'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  }
} catch (error) {
  try {
    fs.mkdirSync(appPaths.dataDir(), { recursive: true });
    fs.appendFileSync(
      path.join(appPaths.dataDir(), 'error.log'),
      `${new Date().toISOString()} ${eventName || 'unknown'} ${error.stack}\n`
    );
  } catch {
    // Hook failures must never block Qoder.
  }
}

process.exit(0);
