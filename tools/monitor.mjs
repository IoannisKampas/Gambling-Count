// Read-only multi-table Blackjack monitor.
//
// Opens the Pragmatic Play game socket for each requested table and prints every
// card and result as it happens. No video socket is ever opened. It sends nothing
// to the server except the keepalive ping the real client sends — never a bet,
// never a seat request, never a game action.
//
// Usage: node tools/monitor.mjs <JSESSIONID> [tableId ...]
//        node tools/monitor.mjs <JSESSIONID>            (first 6 open tables)

import WebSocket from 'ws';
import fs from 'node:fs';

const JSESSIONID = process.argv[2];
const argIds = process.argv.slice(3);
if (!JSESSIONID) {
  console.error('usage: node tools/monitor.mjs <JSESSIONID> [tableId ...]');
  process.exit(1);
}

// Observed hard limit: 6 concurrent game sockets per account.
const MAX_CONCURRENT = 6;
const ORIGIN = 'https://client.pragmaticplaylive.net';
const BOOTSTRAP = 'wss://gs15.pragmaticplaylive.net/game';

let names = new Map();
try {
  const lobby = JSON.parse(fs.readFileSync('data/lobby-tables.json', 'utf8'));
  for (const t of lobby.tables) names.set(t.id, (t.title && t.title.key) || t.id);
  if (argIds.length === 0) {
    for (const t of lobby.tables.filter((x) => x.game === 'blackjack' && x.open).slice(0, MAX_CONCURRENT)) {
      argIds.push(t.id);
    }
  }
} catch {}

if (argIds.length > MAX_CONCURRENT) {
  console.error('refusing: ' + argIds.length + ' tables exceeds the observed cap of ' + MAX_CONCURRENT);
  process.exit(1);
}

// --- card decoding -------------------------------------------------------
// scanCode is rank + suit + deck-index, e.g. "4D8" = 4 of Diamonds from deck 8,
// "0S1" = Ten of Spades, "1H2" = Ace of Hearts, "KD6" = King of Diamonds.
const SUIT = { C: '♣', D: '♦', H: '♥', S: '♠' };
const RANK = { 0: '10', 1: 'A', J: 'J', Q: 'Q', K: 'K' };

function card(sc) {
  if (!sc) return '??';
  const r = RANK[sc[0]] || sc[0];
  return r + (SUIT[sc[1]] || sc[1]);
}
function hiLo(sc) {
  const r = sc && sc[0];
  if (r === '1' || r === '0' || r === 'J' || r === 'Q' || r === 'K') return -1;
  if (r >= '2' && r <= '6') return +1;
  return 0;
}

// --- per-table state -----------------------------------------------------
const T = new Map();

// Add a card to the running count once, however many times it is reported.
function countCard(st, game, seat, hand, sc) {
  if (!sc) return;
  const key = game + '|' + seat + '|' + hand + '|' + sc;
  if (st.counted.has(key)) return;
  st.counted.add(key);
  st.rc += hiLo(sc);
  st.seen++;
}
const seatLabel = (s) => (String(s) === '-1' ? 'DEALER' : 'seat ' + s);
const stamp = () => new Date().toISOString().slice(11, 19);
const tag = (id) => (names.get(id) || id).padEnd(20);

function log(id, msg) {
  console.log(stamp() + '  ' + tag(id) + msg);
}

function connect(tableId, wsAddress, hops = 0) {
  if (hops > 3) return log(tableId, 'too many redirects, giving up');
  const st = T.get(tableId);
  const url =
    wsAddress + '?JSESSIONID=' + encodeURIComponent(JSESSIONID) +
    '&tableId=' + tableId + '&type=json&version=3';
  const ws = new WebSocket(url, { origin: ORIGIN });
  st.ws = ws;
  let channel = null;

  ws.on('message', (buf) => {
    let j;
    try { j = JSON.parse(buf.toString()); } catch { return; }
    const kind = Object.keys(j)[0];
    const b = j[kind] || {};
    if (b.channel) channel = b.channel;

    switch (kind) {
      case 'switch':
        st.server = b.gameServer;
        st.redirecting = true;
        return connect(tableId, b.wsAddress, hops + 1);

      case 'duplicatePlayerSession':
        return log(tableId, 'REJECTED - account already has ' + MAX_CONCURRENT + ' sockets open');

      case 'table':
        st.physical = b.value;
        return;
      case 'dealer':
        st.dealer = b.value;
        return log(tableId, 'dealer ' + b.value + '  (' + st.physical + ' on ' + st.server + ')');

      case 'currentShoe':
        if (st.shoe && st.shoe !== b.code) {
          log(tableId, '=== NEW SHOE ' + b.code + ' - running count reset (was ' + st.rc + ') ===');
          st.rc = 0;
          st.seen = 0;
          st.counted.clear();
        }
        st.shoe = b.code;
        return;

      case 'game':
        st.game = b.id;
        return log(tableId, '-- round ' + b.id + ' --');

      // a single card revealed
      case 'card': {
        countCard(st, b.game, b.seat, b.hand, b.sc);
        return log(
          tableId,
          '  ' + seatLabel(b.seat).padEnd(8) + card(b.sc).padEnd(5) +
          ' score=' + String(b.score).padEnd(4) + ' RC=' + (st.rc > 0 ? '+' : '') + st.rc,
        );
      }

      // full hand state; the authoritative view of every seat.
      // h0 is the main hand, h1.. appear after a split.
      case 'playerSeat': {
        for (const key of Object.keys(b)) {
          if (!/^h\d+$/.test(key)) continue;
          const h = b[key];
          if (!h || !h.cards) continue;
          for (const c of h.cards) countCard(st, b.gameId, b.seatNumber, key, c.scanCode);
          log(
            tableId,
            '  ' + seatLabel(b.seatNumber).padEnd(8) +
            h.cards.map((c) => card(c.scanCode)).join(' ').padEnd(18) +
            ' score=' + h.score + (h.hiddenCardDealt ? ' (+hole)' : '') +
            (key === 'h0' ? '' : ' [split ' + key + ']'),
          );
        }
        return;
      }

      case 'score':
        return log(tableId, '  ' + seatLabel(b.seat).padEnd(8) + 'final score ' + b.value);

      case 'handresult':
        return log(tableId, '  ' + seatLabel(b.seat).padEnd(8) + 'RESULT ' + b.value);

      case 'bjGameEnd':
        return log(tableId, '  round ended   RC=' + (st.rc > 0 ? '+' : '') + st.rc + '  cards seen=' + st.seen);
    }
  });

  ws.on('error', (e) => log(tableId, 'socket error: ' + e.message));
  ws.on('close', (c) => {
    if (st.redirecting) { st.redirecting = false; return; }
    log(tableId, 'disconnected (' + c + '), reconnecting in 5s');
    clearInterval(st.ka);
    setTimeout(() => connect(tableId, BOOTSTRAP), 5000);
  });

  clearInterval(st.ka);
  st.ka = setInterval(() => {
    if (ws.readyState === 1 && channel) {
      ws.send('<ping channel="' + channel + '" time="' + Date.now() + '"/>');
    }
  }, 10000);
}

console.log('monitoring ' + argIds.length + ' tables, no video. Ctrl+C to stop.\n');
for (const id of argIds) {
  T.set(id, { server: 'gs15', rc: 0, seen: 0, shoe: null, dealer: null, physical: '?', counted: new Set() });
  connect(id, BOOTSTRAP);
}

process.on('SIGINT', () => {
  console.log('\n\n=== running counts at exit ===');
  for (const [id, st] of T) {
    console.log(tag(id) + 'shoe ' + st.shoe + '  RC=' + (st.rc > 0 ? '+' : '') + st.rc + '  cards=' + st.seen);
    try { st.ws.close(); } catch {}
  }
  process.exit(0);
});
