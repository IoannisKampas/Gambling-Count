// Probe the Pragmatic *platform* services that sit above the per-table game socket.
//
// `GET /api/env/getAll` hands every live-casino client a map of the whole backend
// (captured verbatim in capture/bodies/25972.76.json). Most of those services are
// never touched by the blackjack client itself, and none of them were tested in
// FINDINGS.md, which only ever looked at games./promo./ws1.:
//
//   dgaWS        wss://dga-lc.pragmaticplaylive.net/ws   Direct Game Access (operator-facing)
//   broadcasterWS wss://broadcaster.pragmaticplaylive.net  fan-out push
//   tmservice    https://tmservice.pragmaticplaylive.net table monitoring service
//   gameStats    https://gamestats.pragmaticplaylive.net
//   report       https://report.pragmaticplaylive.net
//   simm         https://simm.pragmaticplaylive.net
//   gameWS       wss://games.pragmaticplaylive.net/game  generic game entry (vs gs<N>)
//
// The question each answers: does anything here carry state for MORE THAN ONE table
// on a SINGLE connection, without consuming one of the 6 per-account game sockets?
//
// Read-only: sends no wagering command anywhere. Sockets are held briefly and closed.
//
// Usage: node tools/probe-platform.mjs <JSESSIONID> [tableId]

import WebSocket from 'ws';

const SESSION = process.argv[2];
const TABLE = process.argv[3] || 'sobj266blackjack';
if (!SESSION) {
  console.error('usage: node tools/probe-platform.mjs <JSESSIONID> [tableId]');
  process.exit(1);
}

const ORIGIN = 'https://client.pragmaticplaylive.net';
const q = encodeURIComponent(SESSION);
const results = [];

const HEADERS = { Origin: ORIGIN, Referer: ORIGIN + '/', 'User-Agent': 'Mozilla/5.0' };

async function rest(label, url) {
  const t = Date.now();
  try {
    const r = await fetch(url, { headers: HEADERS });
    const body = (await r.text()).slice(0, 200).replace(/\s+/g, ' ');
    results.push({ kind: 'REST', label, status: r.status, ms: Date.now() - t, body });
  } catch (e) {
    results.push({ kind: 'REST', label, status: 'ERR', ms: Date.now() - t, body: e.message });
  }
}

// Open a socket, optionally send probes, and report whatever comes back.
function socket(label, url, { send = [], hold = 6000 } = {}) {
  return new Promise((resolve) => {
    const got = [];
    let opened = false;
    let settled = false;
    let ws;
    try { ws = new WebSocket(url, { origin: ORIGIN }); }
    catch (e) { results.push({ kind: 'WS', label, status: 'CTOR', body: e.message }); return resolve(); }

    // close and timeout can both fire; only the first one reports.
    const done = (status, note) => {
      if (settled) return;
      settled = true;
      try { ws.removeAllListeners(); ws.close(); } catch {}
      results.push({
        kind: 'WS', label, status,
        body: (note ? note + ' | ' : '') + (got.length ? got.slice(0, 4).join('  ') : 'no messages'),
        frames: got.length,
      });
      resolve();
    };

    ws.on('upgrade', (res) => { if (res.statusCode !== 101) got.push('HTTP ' + res.statusCode); });
    ws.on('open', () => { opened = true; for (const m of send) { try { ws.send(m); } catch {} } });
    ws.on('message', (b, isBin) => {
      got.push(isBin ? '<binary ' + b.length + 'B>' : b.toString().slice(0, 160).replace(/\s+/g, ' '));
    });
    ws.on('error', (e) => done('ERR', e.message));
    ws.on('close', (c) => { if (opened) done(got.length ? 'DATA' : 'CLOSED', 'code ' + c); else done('REFUSED', 'code ' + c); });
    setTimeout(() => { if (ws.readyState <= 1) done(got.length ? 'DATA' : 'SILENT', 'held ' + hold + 'ms'); }, hold);
  });
}

console.log('probing platform services with one session, table ' + TABLE + '\n');

// --- REST layer -------------------------------------------------------------
await rest('session/ping (is the token alive)', `https://games.pragmaticplaylive.net/api/session/ping?JSESSIONID=${q}`);
await rest('lobby/tables (multiTables field)', `https://games.pragmaticplaylive.net/api/lobby/tables?JSESSIONID=${q}`);
await rest('lobby/table/alternatives', `https://games.pragmaticplaylive.net/api/lobby/table/alternatives?tableId=${TABLE}&useCase=SEAT_OCCUPIED&JSESSIONID=${q}`);
await rest('dga root', `https://dga-lc.pragmaticplaylive.net/?JSESSIONID=${q}`);
await rest('dga /api/tables', `https://dga-lc.pragmaticplaylive.net/api/tables?JSESSIONID=${q}`);
await rest('tmservice root', `https://tmservice.pragmaticplaylive.net/?JSESSIONID=${q}`);
await rest('tmservice /api/tables', `https://tmservice.pragmaticplaylive.net/api/tables?JSESSIONID=${q}`);
await rest('gamestats root', `https://gamestats.pragmaticplaylive.net/?JSESSIONID=${q}`);
await rest('report root', `https://report.pragmaticplaylive.net/?JSESSIONID=${q}`);
await rest('simm root', `https://simm.pragmaticplaylive.net/?JSESSIONID=${q}`);

// --- socket layer -----------------------------------------------------------
// broadcaster: a fan-out name. Try bare, then with a table, then with a subscribe.
await socket('broadcasterWS bare', `wss://broadcaster.pragmaticplaylive.net/?JSESSIONID=${q}`);
await socket('broadcasterWS +tableId', `wss://broadcaster.pragmaticplaylive.net/?JSESSIONID=${q}&tableId=${TABLE}&type=json`);
await socket('broadcasterWS +subscribe', `wss://broadcaster.pragmaticplaylive.net/?JSESSIONID=${q}&type=json`, {
  send: [`<subscribe channel="table-${TABLE}"/>`, JSON.stringify({ cmd: 'subscribe', channel: 'table-' + TABLE })],
});

// DGA is the operator-facing integration layer - a player token may well be rejected,
// which is itself the answer.
await socket('dgaWS bare', `wss://dga-lc.pragmaticplaylive.net/ws?JSESSIONID=${q}`);
await socket('dgaWS +tableId', `wss://dga-lc.pragmaticplaylive.net/ws?JSESSIONID=${q}&tableId=${TABLE}&type=json`);

// the generic gameWS from env/getAll, vs the gs<N> host the app currently bootstraps on
await socket('gameWS generic (no tableId)', `wss://games.pragmaticplaylive.net/game?JSESSIONID=${q}&type=json&version=3`);

await socket('chatWS', `wss://chat.pragmaticplaylive.net/chat?JSESSIONID=${q}&tableId=${TABLE}`);

// --- report -----------------------------------------------------------------
console.log('='.repeat(100));
for (const r of results) {
  console.log(
    r.kind.padEnd(5) + String(r.status).padEnd(9) +
    r.label.padEnd(36) + String(r.body).slice(0, 110),
  );
}
console.log('='.repeat(100));
console.log('\nWhat to look for: any row above that returns state for more than one table.');
process.exit(0);
