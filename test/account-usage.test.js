import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLatestQuota, parseQuotaLine, QuotaLogReader } from '../src/account-usage.js';

const usageLine = (at, qoderUsage) =>
  `[${at}] [INFO] [main] [Auth] [AccountUsage] 用量响应摘要 ` +
  `{"operation":"account.getQuotaUsage","path":"/sash/api/v2/me/usage","status":200,` +
  `"qoderUsage":${qoderUsage}}`;

test('counts dedicated resource packages alongside the add-on quota', () => {
  const quota = parseQuotaLine(usageLine('2026-10-28T09:47:00.745Z',
    '{"usageType":"credits","userQuota":{"total":0,"used":0,"remaining":0,"unit":"credits"},' +
    '"addOnQuota":{"total":2700,"used":1703,"remaining":997,"unit":"credits"},' +
    '"dedicatedResourcePackageCount":1,' +
    '"dedicatedResourcePackages":[{"total":2000,"used":1853,"remaining":147,"available":true,"unit":"credits"}]}'));
  assert.equal(quota.used, 3556);
  assert.equal(quota.remaining, 1144);
  assert.equal(quota.total, 4700);
});

test('tolerates a missing dedicated resource package list', () => {
  const quota = parseQuotaLine(usageLine('2026-10-27T08:34:42.847Z',
    '{"usageType":"credits","addOnQuota":{"total":2800,"used":1721,"remaining":1079,"unit":"credits"},' +
    '"dedicatedResourcePackages":"missing"}'));
  assert.equal(quota.used, 1721);
  assert.equal(quota.remaining, 1079);
  assert.equal(quota.total, 2800);
});

test('reads latest used and remaining from AccountUsage log', () => {
  const q = readLatestQuota('test/fixtures/main.log');
  assert.equal(q.used, 1840);
  assert.equal(q.remaining, 860);
  assert.equal(q.total, 2700);
  assert.equal(q.unit, 'credits');
  assert.equal(q.at, '2026-10-29T13:14:23.113Z');
});

test('returns null when the log is missing or has no quota line', () => {
  assert.equal(readLatestQuota('test/fixtures/missing.log'), null);
});

test('quota reader only reads appended bytes and follows a new log path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-quota-'));
  const first = path.join(dir, 'first.log');
  const second = path.join(dir, 'second.log');
  const quotaLine = (at, used) => `[${at}] [INFO] [Auth] [AccountUsage] 响应摘要 ` +
    `{"operation":"account.getQuotaUsage","qoderUsage":{"addOnQuota":{"total":2700,"used":${used},` +
    `"remaining":${2700 - used},"unit":"credits"}}}`;

  let target = first;
  const reader = new QuotaLogReader(() => target);
  assert.equal(reader.read(), null);

  fs.writeFileSync(first, quotaLine('2026-10-29T10:00:00.000Z', 100) + '\n');
  assert.equal(reader.read().used, 100);
  assert.equal(reader.read().used, 100);

  fs.appendFileSync(first, quotaLine('2026-10-29T11:00:00.000Z', 150) + '\n');
  assert.equal(reader.read().used, 150);

  fs.writeFileSync(second, quotaLine('2026-10-29T12:00:00.000Z', 10) + '\n');
  target = second;
  assert.equal(reader.read().used, 10);
  assert.equal(reader.path, second);
});

test('quota reader keeps the last snapshot when a partial line is appended', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-quota-'));
  const log = path.join(dir, 'main.log');
  const line = '[2026-10-29T10:00:00.000Z] [INFO] [Auth] [AccountUsage] 响应摘要 ' +
    '{"operation":"account.getQuotaUsage","qoderUsage":{"addOnQuota":{"total":2700,"used":100,' +
    '"remaining":2600,"unit":"credits"}}}';
  fs.writeFileSync(log, `${line}\n`);
  const reader = new QuotaLogReader(log);
  assert.equal(reader.read().used, 100);

  fs.appendFileSync(log, '[2026-10-29T11:00:00.000Z] [INFO] [Auth] [AccountUs');
  assert.equal(reader.read().used, 100);

  fs.appendFileSync(log, 'age] 响应摘要 {"operation":"account.getQuotaUsage","qoderUsage":{"addOnQuota":{"total":2700,"used":120,"remaining":2580,"unit":"credits"}}}\n');
  assert.equal(reader.read().used, 120);
});

