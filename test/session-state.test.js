import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  SESSION_STATE_KEY,
  projectHash,
  stateFileFor,
  workspaceRootOf,
  readSessionCredits
} from '../src/session-state.js';

const ROOT = path.join(os.tmpdir(), 'qoder-credits-test-root');
const SESSION_ID = 'abc-123';

const payload = (total) => ({
  updatedAt: '2026-10-30T03:01:32.525Z',
  latestRequestId: 'r-last',
  total: { input_tokens: 1, output_tokens: 2 },
  credits: {
    total,
    byModel: { qmodel_38max: { credits: total } }
  }
});

function seal({ body, projectRoot, key = SESSION_STATE_KEY, segmentKey = 's0' }) {
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.from(
    JSON.stringify({ sessionId: SESSION_ID, projectHash: projectHash(projectRoot), segmentKey }),
    'utf8'
  );
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(body), 'utf8')), cipher.final()]);
  return {
    n: nonce.toString('base64'),
    p: data.toString('base64'),
    t: cipher.getAuthTag().toString('base64')
  };
}

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-state-'));
  const transcriptPath = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({ type: 'workspace-directories', sessionId: SESSION_ID, directories: [ROOT] }) + '\n'
  );
  if (options.write !== false) {
    const segment = seal({
      body: payload(options.total ?? 200.95253145685737),
      projectRoot: options.projectRoot ?? ROOT,
      key: options.key
    });
    const statePath = stateFileFor(transcriptPath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        sessionId: SESSION_ID,
        revision: 9,
        createdAt: '2026-10-29T12:25:20.277Z',
        updatedAt: '2026-10-30T03:01:32.525Z',
        items: { s0: { c: '2026-10-29T12:25:20.277Z', u: '2026-10-30T03:01:32.525Z', ...segment } }
      })
    );
  }
  return { dir, transcriptPath };
}

test('reads the exact credit total from the encrypted session ledger', () => {
  const { transcriptPath } = setup();
  const ledger = readSessionCredits(transcriptPath, ROOT);
  assert.equal(ledger.totalCredits, 200.95253145685737);
  assert.equal(ledger.updatedAt, '2026-10-30T03:01:32.525Z');
  assert.equal(ledger.byModel.qmodel_38max.credits, 200.95253145685737);
});

test('returns null when the ledger is missing', () => {
  const { transcriptPath } = setup({ write: false });
  assert.equal(readSessionCredits(transcriptPath, ROOT), null);
});

test('returns null when the workspace root does not match the ledger', () => {
  const { transcriptPath } = setup();
  assert.equal(readSessionCredits(transcriptPath, 'C:\\somewhere\\else'), null);
});

test('returns null when the key no longer matches, so callers can degrade', () => {
  const { transcriptPath } = setup({ key: crypto.randomBytes(32) });
  assert.equal(readSessionCredits(transcriptPath, ROOT), null);
});

test('returns null when the ledger is truncated mid-write', () => {
  const { transcriptPath } = setup();
  const statePath = stateFileFor(transcriptPath);
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  raw.items.s0.p = raw.items.s0.p.slice(0, 40);
  fs.writeFileSync(statePath, JSON.stringify(raw));
  assert.equal(readSessionCredits(transcriptPath, ROOT), null);
});

test('resolves the ledger next to the transcript, one folder per session', () => {
  const { dir, transcriptPath } = setup();
  assert.equal(stateFileFor(transcriptPath), path.join(dir, SESSION_ID, 'state.json'));
});

test('reads the workspace root from the transcript header', () => {
  const { transcriptPath } = setup();
  assert.equal(workspaceRootOf(transcriptPath), ROOT);
  assert.equal(workspaceRootOf(path.join(path.dirname(transcriptPath), 'missing.jsonl')), null);
});
