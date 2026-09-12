// DGA lobby feed — every table on ONE unauthenticated socket.
//
// The Pragmatic live-casino lobby iframe connects to wss://dga-lc.pragmaticplaylive.net/ws
// with NO JSESSIONID (credentials:"omit") and speaks the protocol below, recovered from
// the lobby bundle apps/lobby/5.14.0/main.js. It carries every table for a casinoId on a
// single connection with no 6-socket cap — but only lobby-grade data:
//
//   client sends: {type:"statistics"} {type:"available",casinoId} {type:"ping",pingTime}
//                 {type:"subscribe",isDeltaEnabled:true,casinoId,key,currency}  (key = operatorGameId)
//   server sends: {globalStats:{playerCount,crashPlayerCount}}
//                 {tableKey:[...]}                        full list of operatorGameId keys
//                 {seat1..seat7, totalSeatedPlayers, availableSeats, playerCount, dealer,
//                  tableId, tableName, tableType, tableVariant, onFireSeatCount, limits,
//                  tableOpen, ...}                        full snapshot on subscribe
//                 {tableId, ...changed fields}            occupancy deltas thereafter
//
// There is NO card / score / hand / shoe message — the client's own processMessage only
// handles globalStats, pongTime, tableId and tableKey. So this feed CANNOT count cards.
// What it is good for: watching all tables' occupancy, dealer, open/closed and the
// provider's onFireSeatCount live and for free, to CHOOSE which six to attach game
// sockets to (see src/feed.mjs). Read-only: it sends no wagering command.
//
// Usage: node tools/dga-lobby.mjs [casinoId] [currency] [subscribeKeys csv]

import WebSocket from 'ws';

const CASINO = process.argv[2] || 'ppcdk00000005350';
const CURRENCY = process.argv[3] || 'EUR';
const SUBS = (process.argv[4] || '').split(',').filter(Boolean);
const URL_ = 'wss://dga-lc.pragmaticplaylive.net/ws';
const ORIGIN = 'https://client.pragmaticplaylive.net';

const ws = new WebSocket(URL_, { origin: ORIGIN, perMessageDeflate: true });
const tables = new Map();               // tableId -> latest snapshot
let keys = [];
const send = (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

ws.on('open', () => {
  send({ type: 'statistics' });
  send({ type: 'available', casinoId: CASINO });
  if (SUBS.length) setTimeout(() => { for (const k of SUBS) send({ type: 'subscribe', isDeltaEnabled: true, casinoId: CASINO, key: k, currency: CURRENCY }); }, 800);
});

ws.on('message', (buf) => {
  let j; try { j = JSON.parse(buf.toString()); } catch { return; }
  if (j.globalStats) { process.stdout.write(`\r[global] players=${j.globalStats.playerCount} crash=${j.globalStats.crashPlayerCount}   tables seen=${tables.size}   `); return; }
  if (j.pongTime) return;
  if (j.tableKey) { keys = j.tableKey; console.log(`\ntableKey: ${keys.length} tables available for casino ${CASINO}`); return; }
  if (j.tableId) {
    const prev = tables.get(j.tableId) || {};
    const cur = { ...prev, ...j };
    tables.set(j.tableId, cur);
    if (j.tableName || !prev.tableName) {           // full snapshot
      console.log(`\n[${j.tableId}] ${cur.tableName || ''}  ${cur.tableType || ''}/${cur.tableVariant || ''}  dealer=${cur.dealer?.name || '?'}  seated=${cur.totalSeatedPlayers ?? '?'}/${(cur.availableSeats ?? 0) + (cur.totalSeatedPlayers ?? 0)}  onFire=${cur.onFireSeatCount ?? 0}  open=${cur.tableOpen}`);
    } else {                                          // delta
      const seated = cur.totalSeatedPlayers ?? Object.keys(j).filter((k) => /^seat\d$/.test(k) && j[k]).length;
      console.log(`  ~ [${j.tableId}] delta: ${Object.keys(j).filter((k) => k !== 'tableId').join(',')}  (seated≈${seated}, onFire=${cur.onFireSeatCount ?? 0})`);
    }
  }
});

ws.on('close', (c) => console.log('\nclosed', c));
ws.on('error', (e) => console.log('\nerror', e.message));
setInterval(() => send({ type: 'ping', pingTime: Date.now() }), 5000);

process.on('SIGINT', () => { try { ws.close(); } catch {} process.exit(0); });
