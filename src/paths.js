import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, '..');

export function dataDir() {
  return process.env.QODER_CREDITS_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'QoderCredits');
}

export function eventsPath() {
  return path.join(dataDir(), 'events.jsonl');
}

export function statePath() {
  return path.join(dataDir(), 'state.json');
}

export function lockPath() {
  return path.join(dataDir(), 'watcher.lock');
}

export function errorPath() {
  return path.join(dataDir(), 'error.log');
}

export function watcherScript() {
  return path.join(rootDir, 'src', 'watcher.js');
}

export function hookScript() {
  return path.join(rootDir, 'src', 'hook.js');
}

export function overlayScript() {
  return path.join(rootDir, 'overlay', 'overlay.ps1');
}

export function settingsPath() {
  return path.join(os.homedir(), '.qoder', 'settings.json');
}

export function latestRunDir() {
  const base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.qoder.app.stable', 'logs');
  try {
    const runs = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return runs.length ? path.join(base, runs[0]) : null;
  } catch {
    return null;
  }
}

export function mainLogPath() {
  const run = latestRunDir();
  return run ? path.join(run, 'main.log') : null;
}
