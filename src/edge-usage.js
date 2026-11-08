import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { pathToFileURL } from 'node:url';

const USAGE_URL = 'https://qoder.com/account/usage';
const MAX_BYTES = 4 * 1024 * 1024;
const CODES = new Set(['browser-closed', 'login-required', 'usage-page-missing', 'sync-failed']);
const failure = (code = 'sync-failed') => Object.assign(new Error(code), { code });
const connectionFailure = error => failure(['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error?.code) ? 'browser-closed' : 'sync-failed');
const remaining = deadline => {
  const ms = deadline - Date.now();
  if (ms <= 0) throw failure();
  return Math.min(ms, 8000);
};

// Deliberately self-contained: serialized into the already authenticated usage page.
// No credential material or response headers cross the page/CDP boundary.
export async function readUsageInPage(args) {
  const fail = (code = 'sync-failed') => { throw Object.assign(new Error(code), { code }); };
  const checkLocation = () => {
    if (location.origin !== 'https://qoder.com' || !/^\/account\/usage\/?$/.test(location.pathname)) fail('login-required');
  };
  const validTime = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  const fields = ['session_id', 'business_id', 'credits', 'kind', 'model_category', 'source', 'operation', 'begin_at', 'finish_at'];
  try {
    if (!args || !Array.isArray(args.sessionIds) || args.sessionIds.length > 10000
      || args.sessionIds.some(id => typeof id !== 'string' || !id || id.length > 1024)
      || !validTime(args.startTime) || !validTime(args.endTime) || Number(args.startTime) > Number(args.endTime)) fail();
    const { startTime, endTime } = args;
    const sessions = new Set(args.sessionIds);
    const deadline = Date.now() + 25000;
    const rows = [];
    let current = 1, pageSize = 100, expected;
    checkLocation();
    while (current <= 100) {
      checkLocation();
      const ms = Math.min(8000, deadline - Date.now());
      if (ms <= 0) fail();
      const url = new URL('/api/v1/me/usages/big_model_credits/histories', 'https://qoder.com');
      url.search = new URLSearchParams({
        page: String(current), page_size: String(pageSize), start_time: String(startTime), end_time: String(endTime),
        order_by: 'begin_at', order: '-1'
      }).toString();
      const controller = new AbortController();
      let timer;
      let body;
      try {
        body = await Promise.race([
          (async () => {
            const response = await fetch(url.href, {
              method: 'GET', credentials: 'same-origin', cache: 'no-store', mode: 'same-origin',
              redirect: 'error', signal: controller.signal
            });
            checkLocation();
            const responseUrl = new URL(response.url);
            if (response.status === 401 || response.status === 403 || response.redirected
              || response.type === 'opaqueredirect' || responseUrl.origin !== 'https://qoder.com'
              || responseUrl.pathname !== url.pathname) fail('login-required');
            if (!response.ok) fail();
            return response.json();
          })(),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(Object.assign(new Error('sync-failed'), { code: 'sync-failed' }));
            }, ms);
          })
        ]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      checkLocation();
      if (Date.now() >= deadline || !body || typeof body !== 'object') fail();
      if (body.code === 401 || body.code === 403) fail('login-required');
      if ((body.code !== undefined && ![0, 200, '0', '200'].includes(body.code)) || body.success === false) fail();
      // Accept a bare or data-wrapped page; exactly one row array avoids silently
      // choosing a partial collection if the service's envelope changes.
      const data = body.data && !Array.isArray(body.data) ? body.data : body;
      const arrays = Object.values(data).filter(Array.isArray);
      const meta = data.page_result ?? body.page_result;
      if (arrays.length !== 1 || !meta || typeof meta !== 'object') fail();
      const batch = arrays[0];
      const { current_page: at, next_page: next, last_page: last, page_size: size, total_size: total } = meta;
      if (![at, last, size, total].every(Number.isSafeInteger) || at !== current || size < 1 || size > 100
        || total < 0 || total > 10000 || last < 0 || last > 100
        || (last !== Math.max(1, Math.ceil(total / size)) && !(last === 0 && total === 0))
        || batch.length !== Math.min(size, Math.max(0, total - (current - 1) * size))) fail();
      if (expected && (size !== expected.size || total !== expected.total || last !== expected.last)) fail();
      expected = { size, total, last };
      const terminal = current >= last;
      if (terminal ? ![0, -1, null].includes(next) : next !== current + 1) fail();
      for (const row of batch) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) fail();
        if (!sessions.has(row.session_id)) continue;
        const clean = {};
        for (const key of fields) {
          if (!Object.hasOwn(row, key)) continue;
          const value = row[key];
          if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) fail();
          if (typeof value === 'string' && value.length > 4096) fail();
          clean[key] = value;
        }
        rows.push(clean);
      }
      if (terminal) return { rows, from: startTime, to: endTime };
      current = next;
      pageSize = size;
    }
    fail();
  } catch (error) {
    fail(error?.code === 'login-required' ? 'login-required' : 'sync-failed');
  }
}

function usagePage(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://qoder.com' && !url.username && !url.password && /^\/account\/usage\/?$/.test(url.pathname);
  } catch { return false; }
}

function validateWs(value, port, pathname) {
  let url;
  try { url = new URL(value); } catch { throw failure(); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== port
    || url.pathname !== pathname || url.username || url.password || url.search || url.hash) throw failure();
  // Resolve localhost ourselves: never rely on DNS or a machine proxy for CDP.
  return `http://127.0.0.1:${port}${pathname}`;
}

async function activeEndpoint(profileDir) {
  let file;
  try {
    file = await fs.open(path.join(profileDir, 'DevToolsActivePort'), 'r');
    const buffer = Buffer.alloc(2049);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    if (bytesRead > 2048 || lines.length !== 2 || !/^[1-9]\d{0,4}$/.test(lines[0])
      || Number(lines[0]) > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1])) throw failure();
    return { port: Number(lines[0]), pathname: lines[1] };
  } catch (error) {
    throw failure(error?.code === 'ENOENT' ? 'browser-closed' : 'sync-failed');
  } finally { await file?.close(); }
}

function getJson(port, pathname, deadline) {
  return new Promise((resolve, reject) => {
    let timer, request, response, done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      response?.destroy();
      request?.destroy();
      error ? reject(error) : resolve(value);
    };
    try {
      timer = setTimeout(() => finish(failure()), remaining(deadline));
      request = http.get({ hostname: '127.0.0.1', port, path: pathname, agent: false }, res => {
        response = res;
        if (res.statusCode !== 200) return finish(failure()); // Never follow redirects.
        const chunks = [];
        let length = 0;
        res.on('data', chunk => {
          length += chunk.length;
          if (length > MAX_BYTES) return finish(failure());
          chunks.push(chunk);
        });
        res.on('error', () => finish(failure('browser-closed')));
        res.on('end', () => {
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(failure()); }
        });
      });
      request.on('error', error => finish(connectionFailure(error)));
    } catch { finish(failure()); }
  });
}

// One command per socket. Native HTTP upgrade gives us deterministic destroy()
// on timeout (the built-in WebSocket's closing handshake can otherwise linger).
function cdp(url, method, params, deadline) {
  return new Promise((resolve, reject) => {
    let request, socket, timer, done = false, buffer = Buffer.alloc(0), fragments = [], fragmentSize = 0;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.destroy();
      request?.destroy();
      error ? reject(error) : resolve(value);
    };
    const send = (body, opcode = 1) => {
      const mask = crypto.randomBytes(4);
      const header = Buffer.alloc(body.length < 126 ? 2 : body.length < 65536 ? 4 : 10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | (body.length < 126 ? body.length : body.length < 65536 ? 126 : 127);
      if (header.length === 4) header.writeUInt16BE(body.length, 2);
      if (header.length === 10) header.writeBigUInt64BE(BigInt(body.length), 2);
      const masked = Buffer.from(body);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
    };
    const receive = chunk => {
      try {
        if (done) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_BYTES + 14) throw failure();
        while (buffer.length >= 2) {
          const first = buffer[0], opcode = first & 15, final = !!(first & 128);
          if ((first & 112) || (buffer[1] & 128)) throw failure();
          let length = buffer[1] & 127, offset = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          if (length === 127) {
            if (buffer.length < 10) return;
            const big = buffer.readBigUInt64BE(2);
            if (big > BigInt(MAX_BYTES)) throw failure();
            length = Number(big); offset = 10;
          }
          if (length > MAX_BYTES || (opcode >= 8 && (!final || length > 125))) throw failure();
          if (buffer.length < offset + length) return;
          const payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 8) return finish(failure('browser-closed'));
          if (opcode === 9) { send(payload, 10); continue; }
          if (opcode === 10) continue;
          if ((opcode !== 0 && opcode !== 1) || (opcode === 0 ? !fragments.length : fragments.length > 0)) throw failure();
          fragments.push(payload);
          fragmentSize += length;
          if (fragmentSize > MAX_BYTES) throw failure();
          if (!final) continue;
          const message = JSON.parse(Buffer.concat(fragments).toString('utf8'));
          fragments = []; fragmentSize = 0;
          if (message.method === 'Inspector.detached') return finish(failure('browser-closed'));
          if (message.id !== 1) continue;
          if (message.error || !message.result) throw failure();
          return finish(null, message.result);
        }
      } catch { finish(failure()); }
    };
    try {
      const key = crypto.randomBytes(16).toString('base64');
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      timer = setTimeout(() => finish(failure()), remaining(deadline));
      request = http.request(url, { agent: false, headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key
      } });
      request.on('error', error => finish(connectionFailure(error)));
      request.on('response', res => { res.destroy(); finish(failure()); });
      request.on('upgrade', (res, upgraded, head) => {
        socket = upgraded;
        socket.on('error', () => finish(failure('browser-closed')));
        socket.on('close', () => finish(failure('browser-closed')));
        if (done) return socket.destroy();
        if (res.statusCode !== 101 || res.headers['sec-websocket-accept'] !== accept
          || res.headers.upgrade?.toLowerCase() !== 'websocket') return finish(failure());
        clearTimeout(timer);
        const commandMs = Math.min(method === 'Runtime.evaluate' ? 27000 : 8000, deadline - Date.now());
        if (commandMs <= 0) return finish(failure());
        timer = setTimeout(() => finish(failure()), commandMs);
        socket.on('data', receive);
        send(Buffer.from(JSON.stringify({ id: 1, method, params })));
        if (head.length) receive(head);
      });
      request.end();
    } catch { finish(failure()); }
  });
}

export class EdgeUsageSource {
  constructor({ profileDir, executable } = {}) {
    profileDir ??= process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'QoderCredits', 'edge-billing-profile');
    if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) throw failure();
    this.profileDir = path.resolve(profileDir);
    this.executable = executable ?? (process.platform === 'win32'
      ? path.join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : 'msedge');
  }

  async #discover(deadline) {
    const endpoint = await activeEndpoint(this.profileDir);
    const version = await getJson(endpoint.port, '/json/version', deadline);
    const browser = validateWs(version?.webSocketDebuggerUrl, endpoint.port, endpoint.pathname);
    // The random browser ID must match the dedicated profile file before listing
    // any targets; a recycled port belonging to another browser is not reusable.
    const targets = await getJson(endpoint.port, '/json/list', deadline);
    if (!Array.isArray(targets) || targets.length > 1000) throw failure();
    const target = targets.find(item => item?.type === 'page' && usagePage(item.url));
    let page;
    if (target) {
      if (typeof target.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(target.id)) throw failure();
      page = validateWs(target.webSocketDebuggerUrl, endpoint.port, `/devtools/page/${target.id}`);
    }
    return { browser, page };
  }

  async open() {
    const deadline = Date.now() + 20000;
    let endpoint;
    try { endpoint = await this.#discover(deadline); } catch { /* Stale or absent: launch only this profile. */ }
    if (!endpoint) {
      await new Promise((resolve, reject) => {
        let child, timer;
        const finish = error => { clearTimeout(timer); error ? reject(failure('browser-closed')) : resolve(); };
        try {
          timer = setTimeout(() => finish(true), remaining(deadline));
          child = childProcess.spawn(this.executable, [
            `--user-data-dir=${this.profileDir}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
            '--no-first-run', '--no-default-browser-check', '--disable-sync', USAGE_URL
          ], { shell: false, detached: true, stdio: 'ignore' });
          child.once('error', () => finish(true));
          child.once('spawn', () => { child.unref(); finish(); });
        } catch { finish(true); }
      });
      while (Date.now() < deadline) {
        try { endpoint = await this.#discover(deadline); break; } catch { /* Wait for this profile's new endpoint. */ }
        await new Promise(resolve => setTimeout(resolve, Math.min(150, Math.max(1, deadline - Date.now()))));
      }
      if (!endpoint) throw failure('browser-closed');
    }
    if (!endpoint.page) await cdp(endpoint.browser, 'Target.createTarget', { url: USAGE_URL }, deadline);
  }

  async read(args) {
    try {
      // Copy only coordinator arguments. Never splice strings into executable JS.
      const input = { sessionIds: args?.sessionIds, startTime: args?.startTime, endTime: args?.endTime };
      const deadline = Date.now() + 35000;
      const endpoint = await this.#discover(deadline);
      if (!endpoint.page) throw failure('usage-page-missing');
      const expression = `(${readUsageInPage.toString()})(${JSON.stringify(input)}).catch(error => ({ error: { code: error.code === 'login-required' ? 'login-required' : 'sync-failed' } }))`;
      const result = await cdp(endpoint.page, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, deadline);
      if (result.exceptionDetails) throw failure();
      const value = result.result?.value;
      if (value?.error) throw failure(CODES.has(value.error.code) ? value.error.code : 'sync-failed');
      if (!value || !Array.isArray(value.rows) || value.rows.length > 10000 || value.from !== input.startTime || value.to !== input.endTime) throw failure();
      const fields = ['session_id', 'business_id', 'credits', 'kind', 'model_category', 'source', 'operation', 'begin_at', 'finish_at'];
      const rows = value.rows.filter(row => row && input.sessionIds.includes(row.session_id)).map(row => {
        const clean = {};
        for (const key of fields) {
          if (!Object.hasOwn(row, key)) continue;
          const item = row[key];
          if (item !== null && typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item))) throw failure();
          if (typeof item === 'string' && item.length > 4096) throw failure();
          clean[key] = item;
        }
        return clean;
      });
      return { rows, from: input.startTime, to: input.endTime };
    } catch (error) {
      throw failure(CODES.has(error?.code) ? error.code : 'sync-failed');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--open') throw failure();
    await new EdgeUsageSource().open();
  } catch (error) {
    console.error(CODES.has(error?.code) ? error.code : 'sync-failed');
    process.exitCode = 1;
  }
}
