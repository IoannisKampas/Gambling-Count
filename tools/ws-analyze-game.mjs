// Connect to the Pragmatic *game* socket for one table, follow the `switch`
// redirect, and emit every server message as JSON grouped by message kind.
// Read-only: sends nothing but the keepalive <ping>.
//
// Usage: node tools/ws-analyze-game.mjs <JSESSIONID> <tableId> [seconds] [out.json]

import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const [, , SESSION, TABLE, SECS = '15', OUT = 'game-analysis.json'] = process.argv;
if (!SESSION || !TABLE) {
  console.error('usage: node tools/ws-analyze-game.mjs <JSESSIONID> <tableId> [seconds] [out]');
  process.exit(1);
}

const ORIGIN = 'https://client.pragmaticplaylive.net';
const t0 = Date.now();
const messages = [];
const events = [];
let ws = null;
let pinger = null;

const url = (host) =>
  `${host}?JSESSIONID=${encodeURIComponent(SESSION)}&tableId=${encodeURIComponent(TABLE)}&type=json&version=3`;

function connect(host, why) {
  events.push({ tMs: Date.now() - t0, event: 'connect', host, why });
  ws = new WebSocket(url(host), { origin: ORIGIN });
  ws.on('open', () => {
    events.push({ tMs: Date.now() - t0, event: 'open', host });
    clearInterval(pinger);
    pinger = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(`<ping channel="table-${TABLE}" time="${Date.now()}"/>`);
    }, 5000);
  });
  ws.on('message', (buf) => {
    const s = buf.toString();
    let json = null;
    try { json = JSON.parse(s); } catch {}
    const kind = json ? Object.keys(json)[0] : 'unparsed';
    messages.push({ i: messages.length, tMs: Date.now() - t0, kind, json: json ?? s });
    if (kind === 'switch' && json.switch?.wsAddress) {
      try { ws.removeAllListeners(); ws.close(); } catch {}
      connect(json.switch.wsAddress, 'switch redirect');
    }
  });
  ws.on('error', (e) => events.push({ tMs: Date.now() - t0, event: 'error', message: e.message }));
  ws.on('close', (c) => events.push({ tMs: Date.now() - t0, event: 'close', code: c }));
}

connect('wss://gs15.pragmaticplaylive.net/game', 'initial');

setTimeout(() => {
  clearInterval(pinger);
  try { ws.close(); } catch {}
  const byKind = {};
  const firstOf = {};
  for (const m of messages) {
    byKind[m.kind] = (byKind[m.kind] || 0) + 1;
    if (!(m.kind in firstOf)) firstOf[m.kind] = m.json;
  }
  const report = { tableId: TABLE, durationSec: Number(SECS), summary: { total: messages.length, byKind }, schemaSamples: firstOf, events, messages };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ tableId: TABLE, total: messages.length, byKind, events }, null, 2));
  console.log('\nfirst instance of each message kind:');
  console.log(JSON.stringify(firstOf, null, 1).slice(0, 3500));
  console.log('\nfull log -> ' + OUT);
  process.exit(0);
}, Number(SECS) * 1000);
