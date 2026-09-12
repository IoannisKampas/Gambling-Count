// Mint a Playtech session token using an ALREADY-RUNNING Chrome (CDP on 9222).
//
// Chrome refuses to start a second instance on the same profile, so when a signed-in
// browser is already up (npm run login, or tools/capture.mjs), we attach to it, open the
// game page in a background tab, lift the token off the wire, and close the tab again.
//
// Prints the token on stdout so it can be piped into a login attempt - it lives ~5 min.
//
// Usage: node tools/pt-mint.mjs [gameUrl] [--verbose]

import WebSocket from 'ws';

const PORT = Number(process.env.CDP_PORT || 9222);
const GAME_URL = process.argv.find((a) => a.startsWith('http')) ||
  'https://www.stoiximan.gr/casino/live/games/roulette-italiana/11496/tables/';
const VERBOSE = process.argv.includes('--verbose');
const say = (m) => VERBOSE && console.error(m);

// Attach to a running Chrome if there is one; otherwise start the profile ourselves.
// Chrome refuses a second instance on the same user-data-dir, so attaching is the only
// option while a signed-in window is open.
async function cdpVersion() {
  try { return await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch { return null; }
}
let ver = await cdpVersion();
let spawned = null;
if (!ver) {
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { requireChrome, platformArgs, displayProblem, stderrTail } = await import('../src/chrome.mjs');
  let CHROME;
  try { CHROME = requireChrome(); } catch (e) { console.error(e.message); process.exit(1); }
  const displayIssue = displayProblem();
  if (displayIssue) { console.error(displayIssue); process.exit(1); }
  say('no running Chrome — launching the profile off-screen');
  spawned = spawn(CHROME, [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(ROOT, '.chrome-profile'),
    '--no-first-run', '--no-default-browser-check', ...platformArgs(),
    '--window-position=-32000,-32000', '--window-size=1200,800',
    'about:blank',
  ], { detached: false, stdio: ['ignore', 'ignore', 'pipe'] });
  const why = stderrTail(spawned);
  for (let i = 0; i < 60 && !ver; i++) { await new Promise((r) => setTimeout(r, 500)); ver = await cdpVersion(); }
  if (!ver) { try { spawned.kill(); } catch {} console.error('Chrome never exposed CDP' + why()); process.exit(1); }
}
say('attached to ' + ver.Browser + (spawned ? ' (launched)' : ' (already running)'));

const ws = new WebSocket(ver.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

let id = 1;
const pend = new Map();
const cmd = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const i = id++;
  pend.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error(method + ' timed out')); } }, 20000);
});

let token = null, meta = null;
let resolveToken;
const gotToken = new Promise((r) => { resolveToken = r; });

async function grabBody(requestId, sessionId, url) {
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const b = await cmd('Network.getResponseBody', { requestId }, sessionId);
      if (b && b.body) {
        const j = JSON.parse(b.body);
        if (j.sessionToken && j.sessionToken.sessionToken) {
          token = j.sessionToken.sessionToken;
          meta = { user: j.username, expires: (j.sessionToken.expirationTime || {}).timestamp };
          resolveToken();
        }
        return;
      }
    } catch {}
  }
}

ws.on('message', (raw) => {
  let o; try { o = JSON.parse(raw.toString()); } catch { return; }
  if (o.id && pend.has(o.id)) {
    const p = pend.get(o.id); pend.delete(o.id);
    return o.error ? p.reject(new Error(o.error.message)) : p.resolve(o.result);
  }
  // enable Network on every target as it attaches (the game runs in its own iframe target)
  if (o.method === 'Target.attachedToTarget') {
    const sid = o.params.sessionId;
    cmd('Network.enable', { maxPostDataSize: 65536 }, sid).catch(() => {});
    cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => {});
    cmd('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
    say('  attached ' + (o.params.targetInfo || {}).type);
  }
  if (o.method === 'Network.responseReceived' &&
      /GetTemporaryAuthenticationToken/i.test(o.params?.response?.url || '')) {
    say('  token response seen (HTTP ' + o.params.response.status + ')');
    grabBody(o.params.requestId, o.sessionId, o.params.response.url);
  }
});

await cmd('Target.setDiscoverTargets', { discover: true });
await cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

const { targetId } = await cmd('Target.createTarget', { url: GAME_URL, background: true });
const { sessionId } = await cmd('Target.attachToTarget', { targetId, flatten: true });
await cmd('Network.enable', { maxPostDataSize: 65536 }, sessionId).catch(() => {});
await cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
say('opened ' + GAME_URL);

await Promise.race([gotToken, new Promise((r) => setTimeout(r, 75000))]);

try { await cmd('Target.closeTarget', { targetId }); } catch {}

// If we launched the browser, shut it down through CDP rather than killing the process:
// Chrome forks children that survive a parent kill and keep the profile locked, which
// makes the *next* mint fail to start. Browser.close releases the lock properly.
if (spawned) {
  try { await cmd('Browser.close'); } catch {}
  await new Promise((r) => setTimeout(r, 900));
  try { spawned.kill(); } catch {}   // belt and braces if it ignored the close
}
try { ws.close(); } catch {}

if (!token) {
  console.error('no token minted — is the profile signed in to the operator?');
  process.exit(1);
}
say('  user ' + meta.user + '  expires ' + meta.expires);
process.stdout.write(token);
process.exit(0);
