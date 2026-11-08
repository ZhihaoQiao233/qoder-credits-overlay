import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';

// Dynamic loading makes the initial TDD failure an explicit missing-feature assertion.
const feature = await import('../src/edge-usage.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const args = { sessionIds: ['A'], startTime: 1700000000, endTime: 1700003600 };
const origin = 'https://qoder.com';
const usageUrl = `${origin}/account/usage`;
const endpoint = `${origin}/api/v1/me/usages/big_model_credits/histories`;
const row = (id, session = 'A') => ({
  session_id: session, business_id: id, credits: 1.25, kind: 'chat',
  model_category: 'model', source: 'ide', operation: 'chat',
  begin_at: 1700000000, finish_at: 1700000010
});
const page = (rows, current = 1, last = 1, total = rows.length, size = 100) => ({
  data: { histories: rows, page_result: {
    current_page: current, next_page: current < last ? current + 1 : 0,
    last_page: last, page_size: size, total_size: total
  } }
});
const response = (body, options = {}) => ({
  ok: true, status: 200, url: endpoint, redirected: false, type: 'basic',
  json: async () => body, ...options
});
function requireFeature() {
  assert.equal(typeof feature.readUsageInPage, 'function', 'readUsageInPage must be implemented');
  assert.equal(typeof feature.EdgeUsageSource, 'function', 'EdgeUsageSource must be implemented');
}
function inPage(fetch, input = args, extra = {}) {
  requireFeature();
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout, Date,
    location: new URL(usageUrl), fetch, ...extra
  });
  return vm.runInContext(`(${feature.readUsageInPage.toString()})(${JSON.stringify(input)})`, context);
}
function safeError(code) {
  return error => {
    assert.equal(error.code, code);
    assert.match(error.message, /^[a-z -]+$/i);
    assert.doesNotMatch(JSON.stringify(error) + String(error), /SECRET|private-body|headers|token/);
    assert.equal(error.cause, undefined);
    return true;
  };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('page reader is self-contained, filters sessions, whitelists fields and fixes the fetch boundary', async () => {
  const calls = [];
  const result = await inPage(async (url, options) => {
    calls.push({ url: new URL(url), options });
    return response(page([{ ...row('one'), name: 'SECRET', account: { email: 'SECRET' } }, row('foreign', 'B')]));
  });
  assert.deepEqual(plain(result), { rows: [row('one')], from: args.startTime, to: args.endTime });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, origin);
  assert.equal(calls[0].url.pathname, '/api/v1/me/usages/big_model_credits/histories');
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
    page: '1', page_size: '100', start_time: '1700000000', end_time: '1700003600', order_by: 'begin_at', order: '-1'
  });
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.mode, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers, undefined);
});

test('traverses every page including pages containing only other sessions, with one endTime', async () => {
  const visited = [];
  const result = await inPage(async url => {
    const u = new URL(url);
    const n = Number(u.searchParams.get('page'));
    visited.push([n, u.searchParams.get('end_time')]);
    return response(page([row(String(n), n === 2 ? 'B' : 'A')], n, 3, 3, 1));
  });
  assert.deepEqual(plain(result.rows), [row('1'), row('3')]);
  assert.deepEqual(visited, [[1, '1700003600'], [2, '1700003600'], [3, '1700003600']]);
});

for (const status of [401, 403]) {
  test(`HTTP ${status} is a sanitized login error`, async () => {
    await assert.rejects(inPage(async () => response('SECRET', { ok: false, status })), safeError('login-required'));
  });
}

test('later HTTP and JSON errors reject the whole series instead of returning partial rows', async () => {
  for (const failure of [response('private-body SECRET', { ok: false, status: 500 }),
    response(null, { json: async () => { throw new Error('SECRET'); } })]) {
    let count = 0;
    await assert.rejects(inPage(async () => ++count === 1 ? response(page([row('first')], 1, 2, 2, 1)) : failure), safeError('sync-failed'));
    assert.equal(count, 2);
  }
});

test('never fetches from a foreign origin or a page other than the usage page', async () => {
  for (const href of ['https://evil.example/account/usage', 'http://qoder.com/account/usage',
    'https://qoder.com.evil.example/account/usage', `${origin}/login`]) {
    let calls = 0;
    await assert.rejects(inPage(async () => { calls++; }, args, { location: new URL(href) }), safeError('login-required'));
    assert.equal(calls, 0);
  }
});

test('rejects response redirects and navigation during a series without a second send', async () => {
  for (const options of [{ redirected: true }, { url: 'https://evil.example/SECRET' }, { type: 'opaqueredirect' }]) {
    await assert.rejects(inPage(async () => response(page([row('one')]), options)), safeError('login-required'));
  }
  const location = new URL(usageUrl);
  let calls = 0;
  await assert.rejects(inPage(async () => {
    calls++;
    location.href = 'https://evil.example/account/usage';
    return response(page([row('first')], 1, 2, 2, 1));
  }, args, { location }), safeError('login-required'));
  assert.equal(calls, 1);
});

test('malformed, looping, changing and overlarge pagination never succeeds', async () => {
  const mutations = [
    p => { delete p.data.page_result; },
    p => { p.data.page_result.current_page = 2; },
    p => { p.data.page_result.next_page = 1; },
    p => { p.data.page_result.last_page = '1'; },
    p => { p.data.page_result.page_size = 0; },
    p => { p.data.page_result.total_size = -1; },
    p => { p.data.page_result.total_size = 101; },
    p => { p.data.page_result.last_page = 100001; p.data.page_result.total_size = 10000100; },
    p => { p.data.histories = null; },
    p => { p.data.histories[0].credits = { private: 'SECRET' }; }
  ];
  for (const mutate of mutations) {
    const body = page([row('one')]);
    mutate(body);
    await assert.rejects(inPage(async () => response(body)), safeError('sync-failed'));
  }
  for (const key of ['last_page', 'page_size', 'total_size']) {
    let n = 0;
    await assert.rejects(inPage(async () => {
      const body = page([row(String(++n))], n, 2, 2, 1);
      if (n === 2) body.data.page_result[key]++;
      return response(body);
    }), safeError('sync-failed'));
  }
});

test('an empty valid history succeeds but invalid time windows and session IDs do not send', async () => {
  assert.deepEqual(plain(await inPage(async () => response(page([])))), { rows: [], from: args.startTime, to: args.endTime });
  for (const input of [{ ...args, endTime: args.startTime - 1 }, { ...args, startTime: 'SECRET' },
    { ...args, sessionIds: 'A' }, { ...args, sessionIds: [null] }]) {
    let calls = 0;
    await assert.rejects(inPage(async () => { calls++; }, input), safeError('sync-failed'));
    assert.equal(calls, 0);
  }
});

test('the total deadline rejects a slow multi-page series even when individual requests finish', async () => {
  let now = 0, calls = 0;
  await assert.rejects(inPage(async () => {
    now += 6000;
    return response(page([row(String(++calls))], calls, 10, 10, 1));
  }, args, { Date: { now: () => now } }), safeError('sync-failed'));
  assert.ok(calls < 10);
});

test('bare and nested row envelopes with an outer page_result are read without exposing metadata', async () => {
  const meta = { current_page: 1, next_page: 0, last_page: 1, page_size: 100, total_size: 1 };
  for (const body of [
    { data: [row('one')], page_result: meta, account: 'SECRET' },
    { data: { rows: [row('one')] }, page_result: meta, account: 'SECRET' }
  ]) {
    const result = await inPage(async () => response(body));
    assert.deepEqual(plain(result), { rows: [row('one')], from: args.startTime, to: args.endTime });
  }
});

test('same-origin redirects away from the histories endpoint are rejected as login-required', async () => {
  await assert.rejects(inPage(async () => response(page([row('one')]), { url: `${origin}/login` })), safeError('login-required'));
});

test('request timeout covers both fetch and body, aborts and clears its timers', async () => {
  for (const bodyHangs of [false, true]) {
    let aborted = false;
    const timers = new Set();
    await assert.rejects(inPage(async (url, { signal }) => {
      signal.addEventListener('abort', () => { aborted = true; });
      if (bodyHangs) return response(null, { json: () => new Promise(() => {}) });
      return new Promise(() => {});
    }, args, {
      setTimeout: (fn, ms) => {
        assert.ok(ms > 0 && ms <= 60000);
        const timer = setTimeout(fn, 15);
        timers.add(timer);
        return timer;
      },
      clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); }
    }), safeError('sync-failed'));
    assert.equal(aborted, true);
    assert.equal(timers.size, 0);
  }
});

// A local CDP peer exercises real HTTP, WebSocket framing and socket disposal.
// It never connects to or starts a browser.
async function peer(t, options = {}) {
  requireFeature();
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'edge-usage-test-'));
  const requests = [], commands = [], sockets = new Set();
  let port;
  const browserPath = '/devtools/browser/dedicated-test-id';
  const pagePath = '/devtools/page/usage-target';
  const send = (socket, value, opcode = 1) => {
    const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const header = Buffer.alloc(body.length < 126 ? 2 : 4);
    header[0] = 0x80 | opcode;
    header[1] = body.length < 126 ? body.length : 126;
    if (body.length >= 126) header.writeUInt16BE(body.length, 2);
    socket.write(Buffer.concat([header, body]));
  };
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (options.httpRedirect) {
      res.writeHead(302, { Location: options.httpRedirect });
      res.end();
    } else if (req.url === '/json/version') {
      res.end(JSON.stringify({ Browser: 'Edg/130.0', webSocketDebuggerUrl: options.browserWs?.(port) ?? `ws://127.0.0.1:${port}${browserPath}` }));
    } else if (req.url === '/json/list') {
      res.end(JSON.stringify(options.targets?.(port) ?? [{
        id: 'usage-target', type: 'page', url: usageUrl, webSocketDebuggerUrl: `ws://localhost:${port}${pagePath}`
      }]));
    } else {
      res.writeHead(404); res.end('SECRET');
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('end', () => socket.destroy());
  });
  server.on('upgrade', (req, socket, head) => {
    requests.push(req.url);
    if (options.noHandshake) return;
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = head;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        let size = buffer[1] & 127, offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const masked = !!(buffer[1] & 128);
        if (buffer.length < offset + (masked ? 4 : 0) + size) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        offset += masked ? 4 : 0;
        const body = Buffer.from(buffer.subarray(offset, offset + size));
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + size);
        if (opcode === 8) { socket.end(); return; }
        if (opcode !== 1) continue;
        const command = JSON.parse(body.toString());
        commands.push(command);
        if (options.closeOnCommand) { socket.destroy(); return; }
        if (options.noReply) continue;
        Promise.resolve().then(async () => {
          if (options.command) return options.command(command);
          if (command.method === 'Runtime.evaluate') {
            const value = await vm.runInNewContext(command.params.expression, {
              URL, URLSearchParams, AbortController, setTimeout, clearTimeout, Date,
              location: new URL(usageUrl), fetch: async () => response(page([{ ...row('one'), email: 'SECRET' }]))
            });
            return { result: { type: 'object', value } };
          }
          if (command.method === 'Target.createTarget') return { targetId: 'usage-target' };
          throw new Error(`Unexpected CDP command: ${command.method}`);
        }).then(result => send(socket, { id: command.id, result }), () => send(socket, {
          id: command.id, error: { message: 'SECRET private-body' }
        }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  await fs.writeFile(path.join(profileDir, 'DevToolsActivePort'), `${port}\n${browserPath}\n`);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(profileDir, { recursive: true, force: true });
  });
  return { profileDir, requests, commands, sockets, port, browserPath };
}

test('source validates browser identity before listing, evaluates only usage and returns sanitized rows', async t => {
  const p = await peer(t);
  const source = new feature.EdgeUsageSource({ profileDir: p.profileDir });
  assert.deepEqual(await source.read(args), { rows: [row('one')], from: args.startTime, to: args.endTime });
  assert.deepEqual(p.requests.slice(0, 2), ['/json/version', '/json/list']);
  assert.equal(p.commands.length, 1);
  assert.equal(p.commands[0].method, 'Runtime.evaluate');
  assert.equal(p.commands[0].params.awaitPromise, true);
  assert.equal(p.commands[0].params.returnByValue, true);
});

test('serialized session strings cannot inject script into the page', async t => {
  const p = await peer(t);
  const source = new feature.EdgeUsageSource({ profileDir: p.profileDir });
  const input = { ...args, sessionIds: ['A\");throw new Error("SECRET");//'] };
  assert.deepEqual(await source.read(input), { rows: [], from: args.startTime, to: args.endTime });
});

for (const [label, browserWs] of [
  ['foreign host', port => `ws://evil.example:${port}/devtools/browser/dedicated-test-id`],
  ['wrong port', port => `ws://127.0.0.1:${port + 1}/devtools/browser/dedicated-test-id`],
  ['stale browser ID', port => `ws://127.0.0.1:${port}/devtools/browser/unrelated-id`],
  ['userinfo', port => `ws://SECRET@localhost:${port}/devtools/browser/dedicated-test-id`],
  ['query string', port => `ws://localhost:${port}/devtools/browser/dedicated-test-id?SECRET`],
  ['non-ws scheme', port => `wss://localhost:${port}/devtools/browser/dedicated-test-id`]
]) {
  test(`rejects ${label} before listing or opening any page`, async t => {
    const p = await peer(t, { browserWs });
    const source = new feature.EdgeUsageSource({ profileDir: p.profileDir });
    await assert.rejects(source.read(args), safeError('sync-failed'));
    assert.deepEqual(p.requests, ['/json/version']);
    assert.equal(p.commands.length, 0);
  });
}

test('redirects on discovery are not followed', async t => {
  const p = await peer(t, { httpRedirect: 'https://evil.example/SECRET' });
  await assert.rejects(new feature.EdgeUsageSource({ profileDir: p.profileDir }).read(args), safeError('sync-failed'));
  assert.deepEqual(p.requests, ['/json/version']);
});

test('missing or malicious DevToolsActivePort is rejected without discovery', async t => {
  const p = await peer(t);
  const file = path.join(p.profileDir, 'DevToolsActivePort');
  for (const content of ['0\n/devtools/browser/id', '65536\n/devtools/browser/id',
    `${p.port}\nws://evil.example/path`, `${p.port}\n//evil.example/path`, `${p.port}\n/devtools/browser/id?SECRET`,
    `${p.port}\n/devtools/browser/id\nextra`]) {
    await fs.writeFile(file, content);
    await assert.rejects(new feature.EdgeUsageSource({ profileDir: p.profileDir }).read(args), safeError('sync-failed'));
  }
  await fs.unlink(file);
  await assert.rejects(new feature.EdgeUsageSource({ profileDir: p.profileDir }).read(args), safeError('browser-closed'));
  assert.deepEqual(p.requests, []);
});

test('only the exact usage target is eligible; unrelated and login pages are never evaluated', async t => {
  const p = await peer(t, { targets: port => [
    { id: 'other', type: 'page', url: 'https://qoder.com.evil.example/account/usage', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/other` },
    { id: 'login', type: 'page', url: `${origin}/login`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/login` },
    { id: 'worker', type: 'service_worker', url: usageUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/worker` }
  ] });
  await assert.rejects(new feature.EdgeUsageSource({ profileDir: p.profileDir }).read(args), safeError('usage-page-missing'));
  assert.equal(p.commands.length, 0);
});

test('an eligible usage page cannot redirect CDP to a different host or target ID', async t => {
  for (const ws of [port => `ws://evil.example:${port}/devtools/page/usage-target`,
    port => `ws://127.0.0.1:${port}/devtools/page/unrelated`]) {
    const p = await peer(t, { targets: port => [{ id: 'usage-target', type: 'page', url: usageUrl, webSocketDebuggerUrl: ws(port) }] });
    await assert.rejects(new feature.EdgeUsageSource({ profileDir: p.profileDir }).read(args), safeError('sync-failed'));
    assert.equal(p.commands.length, 0);
  }
});

test('page/CDP errors cannot leak raw payloads and page login errors retain a safe code', async t => {
  for (const result of [
    { exceptionDetails: { text: 'SECRET private-body' } },
    { result: { value: { error: { code: 'login-required', message: 'SECRET' } } } },
    { result: { value: { error: { code: 'SECRET' } } } }
  ]) {
    const p = await peer(t, { command: () => result });
    await assert.rejects(new feature.EdgeUsageSource({ profileDir: p.profileDir }).read(args),
      safeError(result.result?.value?.error?.code === 'login-required' ? 'login-required' : 'sync-failed'));
  }
});

test('a disconnected CDP peer reports browser-closed', async t => {
  const p = await peer(t, { closeOnCommand: true });
  await assert.rejects(new feature.EdgeUsageSource({ profileDir: p.profileDir }).read(args), safeError('browser-closed'));
});

test('CDP handshake and command timeouts destroy sockets promptly', async t => {
  for (const options of [{ noHandshake: true }, { noReply: true }]) {
    const p = await peer(t, options);
    const realSetTimeout = globalThis.setTimeout;
    const timerMock = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms, 80), ...rest));
    try {
      await assert.rejects(new feature.EdgeUsageSource({ profileDir: p.profileDir }).read(args), safeError('sync-failed'));
      await new Promise(resolve => realSetTimeout(resolve, 25));
      assert.equal(p.sockets.size, 0, `socket leaked: ${JSON.stringify(options)}`);
    } finally { timerMock.mock.restore(); }
  }
});

test('CDP evaluation allows the bounded page series to finish after a single-request timeout', async t => {
  const p = await peer(t, { command: async () => {
    await new Promise(resolve => setTimeout(resolve, 110));
    return { result: { value: { rows: [row('slow')], from: args.startTime, to: args.endTime } } };
  } });
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => realSetTimeout(fn, ms >= 1000 ? ms / 100 : ms, ...rest));
  const result = await new feature.EdgeUsageSource({ profileDir: p.profileDir }).read(args);
  assert.deepEqual(result.rows, [row('slow')]);
});

test('CLI --open uses LOCALAPPDATA/QoderCredits/edge-billing-profile without launching a real browser', async t => {
  const p = await peer(t);
  const moduleUrl = new URL('../src/edge-usage.js', import.meta.url);
  const script = `
    import childProcess from 'node:child_process';
    import { fileURLToPath } from 'node:url';
    childProcess.spawn = (exe, args) => { console.log(JSON.stringify(args)); throw new Error('SECRET'); };
    process.argv = [process.execPath, fileURLToPath(${JSON.stringify(moduleUrl.href)}), '--open'];
    await import(${JSON.stringify(moduleUrl.href)});
  `;
  const result = await new Promise(resolve => childProcess.execFile(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, LOCALAPPDATA: p.profileDir }, timeout: 5000
  }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  assert.equal(result.error?.code, 1);
  assert.equal(result.stderr.trim(), 'browser-closed');
  assert.equal(JSON.parse(result.stdout)[0], `--user-data-dir=${path.join(p.profileDir, 'QoderCredits', 'edge-billing-profile')}`);
});

test('open reuses only the verified profile and creates usage only when missing', async t => {
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('must not launch'); });
  const existing = await peer(t);
  await new feature.EdgeUsageSource({ profileDir: existing.profileDir }).open();
  assert.equal(existing.commands.length, 0);
  const missing = await peer(t, { targets: () => [] });
  await new feature.EdgeUsageSource({ profileDir: missing.profileDir }).open();
  assert.equal(missing.commands.length, 1);
  assert.equal(missing.commands[0].method, 'Target.createTarget');
  assert.equal(missing.commands[0].params.url, usageUrl);
  assert.equal(spawn.mock.callCount(), 0);
});

test('open launches a missing dedicated debugger with only scoped flags, never closes the process', async t => {
  const p = await peer(t);
  const file = path.join(p.profileDir, 'DevToolsActivePort');
  await fs.unlink(file);
  let launchArgs, launchOptions, executable, killed = false, detached = false;
  t.mock.method(childProcess, 'spawn', (exe, argv, options) => {
    executable = exe; launchArgs = argv; launchOptions = options;
    const child = new EventEmitter();
    child.kill = () => { killed = true; };
    child.unref = () => { detached = true; };
    fs.writeFile(file, `${p.port}\n${p.browserPath}\n`).then(() => child.emit('spawn'));
    return child;
  });
  await new feature.EdgeUsageSource({ profileDir: p.profileDir, executable: 'dedicated-msedge.exe' }).open();
  assert.equal(executable, 'dedicated-msedge.exe');
  assert.deepEqual(launchArgs, [
    `--user-data-dir=${p.profileDir}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', usageUrl
  ]);
  assert.equal(launchOptions.shell, false);
  assert.equal(launchOptions.detached, true);
  assert.equal(launchOptions.stdio, 'ignore');
  assert.equal(detached, true);
  assert.equal(killed, false);
});

test('open does not reuse a live unrelated endpoint from a stale profile file', async t => {
  const p = await peer(t, { browserWs: port => `ws://127.0.0.1:${port}/devtools/browser/other` });
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('error', new Error('SECRET launch failure')));
    return child;
  });
  await assert.rejects(new feature.EdgeUsageSource({ profileDir: p.profileDir }).open(), safeError('browser-closed'));
  assert.equal(p.requests.includes('/json/list'), false);
  assert.equal(p.commands.length, 0);
});
