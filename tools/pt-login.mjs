// Prove the Playtech chain end to end: mint a temporary token in the signed-in browser,
// then authenticate the gateway socket from Node and read the lobby.
//
//   browser -> GetTemporaryAuthenticationToken.php  (5-minute token, needs player cookies)
//   node    -> InitRequest                          (gets a context id)
//   node    -> loginRequest(token, context)         (rebuilt protobuf)
//   node    <- tablesUpdateNotification             (all tables + results)
//
// The browser is used only to mint, exactly like the Pragmatic JSESSIONID flow, and is
// closed immediately afterwards. Read-only: no bet is ever sent.
//
// Usage: node tools/pt-login.mjs [holdSeconds]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { buildLogin, retarget, parseRaw, getField, str } from './pt-proto.mjs';
import { gatewayFrames, decode, render, methodOf } from './pt-decode.mjs';
import { requireChrome, platformArgs, displayProblem } from '../src/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.chrome-profile');
const PORT = 9223;
const HOLD = Number(process.argv[2] || 30);

// The operator's Playtech table page; loading it runs the real launch chain, which mints
// a 5-minute session token we can lift off the wire.
const GAME_URL = process.env.PT_GAME_URL ||
  'https://www.stoiximan.gr/casino/live/games/roulette-italiana/11496/tables/';

let CHROME;
try { CHROME = requireChrome(); } catch (e) { console.error(e.message); process.exit(1); }
const displayIssue = displayProblem();
if (displayIssue) { console.error(displayIssue); process.exit(1); }

// ---------------------------------------------------------------- mint step ----
async function mintToken() {
  const child = spawn(CHROME, [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', ...platformArgs(),
    '--window-position=-32000,-32000', '--window-size=1200,800',
    GAME_URL,
  ], { detached: false, stdio: 'ignore' });

  let ws;
  const stop = () => { try { ws && ws.close(); } catch {} try { child.kill(); } catch {} };
  try {
    let wsUrl = null;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try { wsUrl = (await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json()).webSocketDebuggerUrl; } catch {}
      if (!wsUrl) await new Promise((r) => setTimeout(r, 500));
    }
    if (!wsUrl) throw new Error('CDP never came up');

    ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    let id = 1; const pend = new Map();
    ws.on('message', (m) => {
      const o = JSON.parse(m.toString());
      if (o.id && pend.has(o.id)) { const p = pend.get(o.id); pend.delete(o.id); o.error ? p.j(new Error(o.error.message)) : p.r(o.result); }
    });
    const cmd = (method, params = {}, sessionId) => new Promise((r, j) => {
      const i = id++; pend.set(i, { r, j });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

    // Minting needs a rolling `perm` credential seeded by pasSetupPage, so rather than
    // reconstructing that chain we drive the real launch and read the token off the
    // wire - the same approach session.mjs uses for the Pragmatic JSESSIONID.
    let text = '';
    const sessions = new Set();
    const wait = new Promise((resolve) => {
      const done = (t) => { text = t; resolve(); };
      ws.on('message', async (raw) => {
        let o; try { o = JSON.parse(raw.toString()); } catch { return; }
        if (o.method === 'Target.attachedToTarget') {
          const sid = o.params.sessionId;
          sessions.add(sid);
          cmd('Network.enable', {}, sid).catch(() => {});
          cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => {});
          cmd('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
        }
        if (o.method === 'Network.responseReceived' &&
            /GetTemporaryAuthenticationToken/i.test(o.params?.response?.url || '')) {
          const sid = o.sessionId;
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 250));
            try {
              const b = await cmd('Network.getResponseBody', { requestId: o.params.requestId }, sid);
              if (b && b.body) return done(b.body);
            } catch {}
          }
        }
      });
    });

    // Browser-level auto-attach catches the page and every out-of-process game iframe;
    // the handler above enables Network on each as it appears.
    await cmd('Target.setDiscoverTargets', { discover: true });
    await cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    await Promise.race([wait, new Promise((r) => setTimeout(r, 60000))]);
    if (!text) throw new Error('no GetTemporaryAuthenticationToken response seen in 60s (is the profile signed in to stoiximan?)');
    let j; try { j = JSON.parse(text); } catch { throw new Error('token endpoint did not return JSON: ' + text.slice(0, 160).replace(/\s+/g, ' ')); }
    if (j.errorCode !== 0 || !j.sessionToken) throw new Error('mint failed: ' + JSON.stringify(j).slice(0, 200));
    return { token: j.sessionToken.sessionToken, expires: j.sessionToken.expirationTime?.timestamp, user: j.username };
  } finally { stop(); }
}

// -------------------------------------------------------------- gateway step ----
const captured = { init: null, login: null, lobby: [] };
for await (const f of gatewayFrames()) {
  if (f.dir !== 'out') continue;
  const m = methodOf(decode(f.buf)) || '';
  if (!captured.init && /InitRequest/.test(m)) captured.init = f.buf;
  if (!captured.login && /loginRequest/.test(m)) captured.login = f.buf;
  if (/lobby\//.test(m)) captured.lobby.push({ m, buf: f.buf });
}
if (!captured.init || !captured.login) { console.error('capture is missing Init/login frames'); process.exit(1); }

// PT_TOKEN lets a token minted elsewhere (e.g. by tools/capture.mjs driving the real
// launch) be supplied directly - it only lives 5 minutes, so this keeps the mint and
// the login in one run.
let token, expires = '?', user = '?';
if (process.env.PT_TOKEN) {
  token = process.env.PT_TOKEN.trim();
  console.log('using supplied token ' + token.slice(0, 26) + '…');
} else {
  console.log('minting Playtech token in the signed-in profile…');
  ({ token, expires, user } = await mintToken());
  console.log('  token   : ' + token.slice(0, 26) + '…  (user ' + user + ', expires ' + expires + ')');
}

const ws = new WebSocket('wss://ielive-gateway.ptielive.com/ws', {
  origin: 'https://ielive.ptielive.com',
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0 Safari/537.36' },
});
let ctx = null, req = 10;
const tables = new Map();

ws.on('open', () => { console.log('gateway open — InitRequest'); ws.send(captured.init); });
ws.on('message', (b) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  let nodes; try { nodes = decode(buf); } catch { return; }
  const m = methodOf(nodes) || '';

  if (!ctx && /InitResponse/.test(m)) {
    ctx = str(getField(parseRaw(buf), 4));
    console.log('  context : ' + ctx);
    const frame = buildLogin(captured.login, { token, contextId: ctx, requestId: String(req++) });
    console.log('-> loginRequest (' + frame.length + 'B, rebuilt)');
    ws.send(frame);
    return;
  }
  if (/loginResponse/.test(m)) {
    const p = parseRaw(buf);
    const payload = getField(p, 3);
    const err = buf.toString('utf8').match(/not authenticated|Invalid|error/i);
    console.log('\n<- loginResponse (' + buf.length + 'B) ' + (err ? 'PROBLEM: ' + err[0] : 'looks OK'));
    console.log(render(decode(payload ? payload.raw : buf)).join('\n').slice(0, 500));
    // now ask the lobby for tables
    for (const l of captured.lobby) {
      const f = retarget(l.buf, { contextId: ctx, requestId: String(req++) });
      console.log('-> ' + l.m);
      ws.send(f);
    }
    return;
  }
  if (/systemError/.test(m)) { console.log('\n<- systemError: ' + buf.toString('utf8').replace(/[^\x20-\x7e]/g, ' ').slice(0, 200)); return; }
  if (/tablesUpdateNotification|subscribeResponse/.test(m)) {
    const p3 = getField(parseRaw(buf), 3);
    if (p3) harvest(p3.raw);
    console.log('<- ' + m.split('/').pop() + ': ' + tables.size + ' tables known');
    return;
  }
  console.log('<- ' + m + ' (' + buf.length + 'B)');
});
function readV(raw) { let r = 0n, s = 0n; for (const b of raw) { r |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) break; s += 7n; } return r; }

// Pull table entries out of a lobby payload. Results are stored as number+100
// (verified: field 12 reads "33" while 58.1.2 reads 133).
const RESULT_BASE = 100;
function harvest(payloadRaw) {
  for (const t of parseRaw(payloadRaw).filter((x) => x.field === 2 && x.wire === 2)) {
    const f = parseRaw(t.raw);
    const idF = f.find((x) => x.field === 25);
    if (!idF) continue;
    const id = Number(readV(idF.raw));
    const typeF = f.find((x) => x.field === 106);
    const textF = f.find((x) => x.field === 12);
    const prev = tables.get(id) || {};
    const row = {
      type: typeF ? typeF.raw.toString('utf8') : (prev.type || '?'),
      text: textF ? textF.raw.toString('utf8') : prev.text,
      last: prev.last, history: prev.history || [],
    };
    const f58 = f.find((x) => x.field === 58);
    if (f58) {
      const inner = parseRaw(f58.raw).find((x) => x.field === 1);
      if (inner) {
        const g = parseRaw(inner.raw);
        const lastF = g.find((x) => x.field === 2);
        if (lastF) row.last = Number(readV(lastF.raw)) - RESULT_BASE;
        const hist = g.filter((x) => x.field === 7).map((x) => Number(readV(x.raw)) - RESULT_BASE);
        if (hist.length) row.history = hist;
      }
    }
    tables.set(id, row);
  }
}
ws.on('error', (e) => console.log('ws error ' + e.message));
ws.on('close', (c) => console.log('closed ' + c));

setTimeout(() => {
  const withRes = [...tables.entries()].filter(([, t]) => t.last != null || (t.history || []).length);
  console.log('\n=== tables seen: ' + tables.size + '   with results: ' + withRes.length + ' ===');
  const types = {};
  for (const [, t] of tables) types[t.type] = (types[t.type] || 0) + 1;
  console.log('by game type: ' + Object.entries(types).map(([k, v]) => k + '=' + v).join(', '));
  console.log('\n  tableId   type      last  text  history');
  for (const [id, t] of withRes.slice(0, 16)) {
    console.log('  ' + String(id).padEnd(9) + String(t.type).padEnd(9) +
      String(t.last ?? '-').padStart(4) + '  ' + String(t.text ?? '-').padStart(4) + '   [' +
      (t.history || []).join(',') + ']');
  }
  try { ws.close(); } catch {}
  process.exit(0);
}, HOLD * 1000);
