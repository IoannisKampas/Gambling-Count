// Can we reach Playtech's live gateway from Node, and how far without a token?
// Replays the captured handshake frames verbatim and decodes whatever comes back.
//
// Usage: node tools/pt-probe.mjs [howManyOutFrames] [holdSeconds]

import WebSocket from 'ws';
import { decode, render, methodOf, gatewayFrames } from './pt-decode.mjs';

const N = Number(process.argv[2] || 3);
const HOLD = Number(process.argv[3] || 20);
const URL_ = 'wss://ielive-gateway.ptielive.com/ws';
const ORIGIN = 'https://ielive.ptielive.com';

// collect the captured outbound frames, in order
const out = [];
for await (const f of gatewayFrames()) if (f.dir === 'out') out.push(f.buf);
console.log('captured outbound frames available: ' + out.length);
for (let i = 0; i < Math.min(N, out.length); i++) {
  console.log('  replay#' + i + '  ' + (methodOf(decode(out[i])) || '?'));
}

const ws = new WebSocket(URL_, {
  origin: ORIGIN,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  },
});

// Every request after Init carries the session's context id in field 4. The captured
// frames hold the OLD one, so swap it for the fresh id from InitResponse. Both ids are
// the same fixed width, so a byte substitution is enough - no re-encoding needed.
const ctxOf = (nodes) => { const f = nodes.find((n) => n.field === 4 && n.type === 'string'); return f ? f.value : null; };
const OLD_CTX = (() => { for (const b of out) { const c = ctxOf(decode(b)); if (c) return c; } return null; })();
let NEW_CTX = null;
function retarget(buf) {
  if (!OLD_CTX || !NEW_CTX || OLD_CTX.length !== NEW_CTX.length) return buf;
  const s = buf.toString('binary').split(OLD_CTX).join(NEW_CTX);
  return Buffer.from(s, 'binary');
}

let got = 0;
let queue = [];
ws.on('upgrade', (r) => console.log('\nupgrade HTTP ' + r.statusCode));
ws.on('open', () => {
  console.log('WS OPEN — old context id in capture: ' + OLD_CTX);
  try { ws.send(out[0]); console.log('-> sent ' + methodOf(decode(out[0]))); } catch {}
  // SKIP env: comma-separated method substrings to leave out (default: the stale login,
  // whose captured token is dead anyway - the point is to see what works without it)
  const skip = (process.env.SKIP || 'login').split(',').filter(Boolean);
  queue = out.slice(1).filter((b) => {
    const m = methodOf(decode(b)) || '';
    return !skip.some((s) => m.toLowerCase().includes(s.toLowerCase()));
  }).slice(0, N);
});
ws.on('message', (b, isBin) => {
  got++;
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  let nodes; try { nodes = decode(buf); } catch { console.log('<- undecodable ' + buf.length + 'B'); return; }
  const m = methodOf(nodes) || '(none)';

  // first response carries the fresh context id; then drain the queue
  if (!NEW_CTX && /InitResponse/.test(m)) {
    NEW_CTX = ctxOf(nodes);
    console.log('   fresh context id: ' + NEW_CTX + '\n');
    queue.forEach((f, i) => setTimeout(() => {
      const r = retarget(f);
      try { ws.send(r); console.log('-> sent ' + (methodOf(decode(r)) || '?')); } catch {}
    }, 500 * (i + 1)));
    return;
  }
  console.log('\n<- ' + m + '  (' + buf.length + 'B)');
  console.log(render(nodes.filter((n) => n.field !== 1)).join('\n').slice(0, 700));
});
ws.on('unexpected-response', (_, r) => console.log('REFUSED HTTP ' + r.statusCode + ' ' + r.statusMessage));
ws.on('error', (e) => console.log('ERROR: ' + e.message));
ws.on('close', (c, r) => console.log('\nCLOSED code=' + c + ' reason=' + String(r).slice(0, 120)));

setTimeout(() => { console.log('\n=== frames received: ' + got + ' ==='); try { ws.close(); } catch {} process.exit(0); }, HOLD * 1000);
