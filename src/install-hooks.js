import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as appPaths from './paths.js';

export const MARKER = 'qoder-credits-overlay';

const EVENTS = {
  UserPromptSubmit: 'task-start',
  Stop: 'task-stop',
  SessionEnd: 'session-end'
};

function isOurs(definition) {
  return Array.isArray(definition?.hooks) && definition.hooks.some((handler) => handler?.name === MARKER);
}

function clone(settings) {
  return JSON.parse(JSON.stringify(settings ?? {}));
}

export function mergeHooks(settings, { command, args }) {
  const next = clone(settings);
  const hooks = { ...(next.hooks ?? {}) };
  for (const [event, eventName] of Object.entries(EVENTS)) {
    const kept = Array.isArray(hooks[event]) ? hooks[event].filter((definition) => !isOurs(definition)) : [];
    kept.push({
      hooks: [
        {
          type: 'command',
          name: MARKER,
          command,
          args: [...args, eventName],
          timeout: 10,
          async: true
        }
      ]
    });
    hooks[event] = kept;
  }
  next.hooks = hooks;
  return next;
}

export function removeHooks(settings) {
  const next = clone(settings);
  if (!next.hooks) return next;
  const hooks = { ...next.hooks };
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event].filter((definition) => !isOurs(definition));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

export function loadSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`settings.json 解析失败，未做任何修改：${error.message}`);
  }
}

export function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function main() {
  const action = process.argv[2];
  if (action !== 'install' && action !== 'uninstall') {
    console.error('用法: node src/install-hooks.js install|uninstall');
    process.exit(1);
  }

  const settingsFile = appPaths.settingsPath();
  let settings;
  try {
    settings = loadSettings(settingsFile);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (action === 'install') {
    const merged = mergeHooks(settings, { command: process.execPath, args: [appPaths.hookScript()] });
    saveSettings(settingsFile, merged);
    console.log(`已写入 ${settingsFile}`);
    console.log(JSON.stringify(merged.hooks, null, 2));
  } else {
    const cleaned = removeHooks(settings);
    saveSettings(settingsFile, cleaned);
    console.log(`已从 ${settingsFile} 移除 ${MARKER}`);
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const self = fileURLToPath(import.meta.url).toLowerCase();
if (entry === self) {
  main();
}
