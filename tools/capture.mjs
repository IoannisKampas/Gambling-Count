// Traffic capture harness.
// Launches Chrome under CDP with its own profile and records every HTTP request
// and every WebSocket frame from every target, including out-of-process iframes.
// Nothing leaves the machine; everything lands in capture/.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireChrome, platformArgs, displayProblem } from '../src/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.chrome-profile');
const OUT_DIR = path.join(ROOT, 'capture');
const BODY_DIR = path.join(OUT_DIR, 'bodies');
const PORT = 9222;
const START_URL = process.argv[2] || 'https://www.stoiximan.gr/casino/live/games/blackjack-161/35927/tables/';

fs.mkdirSync(BODY_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(OUT_DIR, 'session-' + stamp + '.jsonl');
const log = fs.createWriteStream(logPath, { flags: 'a' });
const rec = (type, data) => log.write(JSON.stringify({ t: Date.now(), type, ...data }) + '\n');

let CHROME;
try { CHROME = requireChrome(); } catch (e) { console.error(e.message); process.exit(1); }
const displayIssue = displayProblem();
if (displayIssue) { console.error(displayIssue); process.exit(1); }

console.log('browser :', CHROME);
console.log('profile :', PROFILE, '(log in here once; it persists)');
console.log('log     :', logPath);

const child = spawn(
  CHROME,
  [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    ...platformArgs(),
    '--disable-features=Translate',
    START_URL,
  ],
  { detached: false, stdio: 'ignore' },
);
child.on('exit', (c) => {
  console.log('browser exited', c);
  shutdown();
});

async function browserWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('CDP endpoint never came up');
}

let nextId = 1;
const pending = new Map();
let ws;

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const reqs = new Map(); // requestId -> { url, mime, sessionId }
const sockets = new Map(); // requestId -> url
let reqCount = 0;
let frameCount = 0;

const WANT_BODY = /\.(json|js)(\?|$)|\/api\/|lobby|table|config|game|casino|state/i;
const SKIP_BODY = /\.(png|jpe?g|gif|webp|svg|woff2?|ttf|mp4|m3u8|ts|css|ico)(\?|$)/i;

async function saveBody(requestId, sessionId, url, mime) {
  try {
    const r = await send('Network.getResponseBody', { requestId }, sessionId);
    const body = r.base64Encoded ? Buffer.from(r.body, 'base64') : Buffer.from(r.body, 'utf8');
    if (body.length > 8 * 1024 * 1024) return;
    const ext = /json/i.test(mime) ? 'json' : /javascript/i.test(mime) ? 'js' : 'txt';
    const name = requestId.replace(/[^\w.-]/g, '_') + '.' + ext;
    fs.writeFileSync(path.join(BODY_DIR, name), body);
    rec('body', { requestId, url, mime, file: name, bytes: body.length });
  } catch {}
}

async function attach(sessionId, targetInfo) {
  rec('target', { sessionId, type: targetInfo.type, url: targetInfo.url });
  try {
    await send('Network.enable', { maxPostDataSize: 65536 }, sessionId);
    await send('Page.enable', {}, sessionId).catch(() => {});
    await send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    ).catch(() => {});
  } catch {}
  await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
}

function onEvent(m) {
  const s = m.sessionId;
  const p = m.params || {};
  switch (m.method) {
    case 'Target.attachedToTarget':
      attach(p.sessionId, p.targetInfo);
      break;

    case 'Network.requestWillBeSent': {
      const request = p.request;
      reqs.set(p.requestId, { url: request.url, sessionId: s });
      reqCount++;
      rec('req', {
        requestId: p.requestId,
        method: request.method,
        url: request.url,
        resourceType: p.type,
        postData: request.postData ? request.postData.slice(0, 8192) : undefined,
        headers: request.headers,
      });
      break;
    }
    case 'Network.responseReceived': {
      const e = reqs.get(p.requestId);
      if (e) {
        e.mime = p.response.mimeType;
        e.status = p.response.status;
      }
      rec('res', {
        requestId: p.requestId,
        url: p.response.url,
        status: p.response.status,
        mime: p.response.mimeType,
        resourceType: p.type,
      });
      break;
    }
    case 'Network.loadingFinished': {
      const e = reqs.get(p.requestId);
      if (!e) return;
      if (!SKIP_BODY.test(e.url) && (WANT_BODY.test(e.url) || /json|javascript/i.test(e.mime || ''))) {
        saveBody(p.requestId, e.sessionId, e.url, e.mime || '');
      }
      break;
    }

    case 'Network.webSocketCreated':
      sockets.set(p.requestId, p.url);
      rec('ws-open', { requestId: p.requestId, url: p.url });
      console.log('WS open:', p.url);
      break;
    case 'Network.webSocketHandshakeResponseReceived':
      rec('ws-handshake', {
        requestId: p.requestId,
        status: p.response ? p.response.status : undefined,
      });
      break;
    case 'Network.webSocketFrameSent':
      frameCount++;
      rec('ws-sent', {
        requestId: p.requestId,
        url: sockets.get(p.requestId),
        payload: p.response ? p.response.payloadData : undefined,
      });
      break;
    case 'Network.webSocketFrameReceived':
      frameCount++;
      rec('ws-recv', {
        requestId: p.requestId,
        url: sockets.get(p.requestId),
        payload: p.response ? p.response.payloadData : undefined,
      });
      break;
    case 'Network.webSocketClosed':
      rec('ws-close', { requestId: p.requestId, url: sockets.get(p.requestId) });
      break;
    case 'Network.eventSourceMessageReceived':
      rec('sse', {
        requestId: p.requestId,
        eventName: p.eventName,
        data: p.data ? p.data.slice(0, 8192) : undefined,
      });
      break;
  }
}

let closed = false;
function shutdown() {
  if (closed) return;
  closed = true;
  console.log('\ncaptured ' + reqCount + ' requests, ' + frameCount + ' ws frames -> ' + logPath);
  log.end(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const url = await browserWsUrl();
ws = new WebSocket(url);
ws.addEventListener('open', async () => {
  console.log('CDP connected. Log in and open a Blackjack table.');
  await send('Target.setDiscoverTargets', { discover: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const entry = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) entry.reject(new Error(m.error.message));
    else entry.resolve(m.result);
    return;
  }
  if (m.method) onEvent(m);
});
ws.addEventListener('close', () => {
  console.log('CDP closed');
  shutdown();
});
ws.addEventListener('error', (e) => console.error('CDP error', e.message || e));

setInterval(
  () => console.log('... ' + reqCount + ' reqs, ' + frameCount + ' frames, ' + sockets.size + ' sockets'),
  15000,
);
