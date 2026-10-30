import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARKER, loadSettings, mergeHooks, removeHooks, saveSettings } from '../src/install-hooks.js';

const spec = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\tools\\hook.js'] };

test('adds our hooks to the three events and leaves other settings alone', () => {
  const base = { enabledPlugins: { x: true } };
  const merged = mergeHooks(base, spec);
  assert.deepEqual(merged.enabledPlugins, { x: true });
  for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd']) {
    assert.equal(merged.hooks[event].length, 1);
    assert.equal(merged.hooks[event][0].hooks[0].name, MARKER);
  }
  assert.deepEqual(merged.hooks.Stop[0].hooks[0].args, ['C:\\tools\\hook.js', 'task-stop']);
  assert.deepEqual(base, { enabledPlugins: { x: true } });
});

test('reinstalling does not duplicate our hooks', () => {
  const once = mergeHooks({}, spec);
  const twice = mergeHooks(once, spec);
  assert.equal(twice.hooks.Stop.length, 1);
  assert.deepEqual(twice, once);
});

test('keeps foreign hooks in the same event', () => {
  const foreign = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', name: 'other', command: 'other.exe' }] }]
    }
  };
  const merged = mergeHooks(foreign, spec);
  assert.equal(merged.hooks.Stop.length, 2);
  assert.equal(merged.hooks.Stop[0].hooks[0].name, 'other');
  const removed = removeHooks(merged);
  assert.equal(removed.hooks.Stop.length, 1);
  assert.equal(removed.hooks.Stop[0].hooks[0].name, 'other');
});

test('removing drops empty events and the hooks key', () => {
  const merged = mergeHooks({ enabledPlugins: { x: true } }, spec);
  const removed = removeHooks(merged);
  assert.equal(removed.hooks, undefined);
  assert.deepEqual(removed.enabledPlugins, { x: true });
});

test('round-trips settings through disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-hooks-'));
  const file = path.join(dir, 'settings.json');
  const settings = mergeHooks({ enabledPlugins: { a: true } }, spec);
  saveSettings(file, settings);
  assert.deepEqual(loadSettings(file), settings);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing settings file loads as empty object', () => {
  assert.deepEqual(loadSettings(path.join(os.tmpdir(), 'no-such-qoder-credits-settings.json')), {});
});
