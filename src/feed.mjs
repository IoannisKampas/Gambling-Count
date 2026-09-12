// Read-only multi-table Blackjack feed.
//
// Protocol as traced in FINDINGS.md. Opens one game socket per table, follows the
// server's `switch` redirect, and never opens a video socket. The only thing it
// ever sends is the keepalive <ping> the real client sends - never a bet, a seat
// request, or any game action.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export const MAX_CONCURRENT = 6; // measured account-wide cap; the 7th is refused

// Pragmatic live blackjack deals from an 8-deck shoe (deck index in the scan code
// runs up to 8). True count = running count / decks remaining.
export const TOTAL_DECKS = 8;
const TOTAL_CARDS = TOTAL_DECKS * 52;

// reconnect backoff bounds
const BACKOFF_BASE = 2000;
const BACKOFF_MAX = 60000;
// A connection has to survive this long to count as healthy. Anything shorter is a
// flap, and the backoff keeps growing - otherwise a socket that connects, takes one
// message and dies resets the delay every time and hammers the provider, which burns
// the account's connect budget (FINDINGS.md §6a) and makes the outage worse.
const STABLE_MS = 30000;
const ORIGIN = 'https://client.pragmaticplaylive.net';
const BOOTSTRAP = 'wss://gs15.pragmaticplaylive.net/game';

const SUIT = { C: '♣', D: '♦', H: '♥', S: '♠' };
const RANK = { 0: '10', 1: 'A', J: 'J', Q: 'Q', K: 'K' };

// scanCode is rank + suit + deck index: "4D8" = 4♦ deck 8, "0S1" = 10♠, "1H2" = A♥.
export function card(sc) {
  if (!sc) return '??';
  return (RANK[sc[0]] || sc[0]) + (SUIT[sc[1]] || sc[1]);
}
export function hiLo(sc) {
  const r = sc && sc[0];
  if (r === '1' || r === '0' || r === 'J' || r === 'Q' || r === 'K') return -1;
  if (r >= '2' && r <= '6') return 1;
  return 0;
}

const seatKey = (s) => (String(s) === '-1' ? 'dealer' : String(s));

// Live blackjack tables have 7 player positions.
export const SEATS = 7;

// `seat.seats_taken` is a bitmask of occupied positions: 13 -> 0b0001101 -> 0,2,3.
export function seatsFromMask(mask) {
  const m = parseInt(mask, 10);
  if (!Number.isFinite(m)) return [];
  const out = [];
  for (let i = 0; i < SEATS; i++) if (m & (1 << i)) out.push(i);
  return out;
}

export class BlackjackFeed extends EventEmitter {
  constructor({ jsessionid, tables, names = new Map() }) {
    super();
    if (!jsessionid) throw new Error('jsessionid required');
    this.authFailures = 0;
    if (tables.length > MAX_CONCURRENT) {
      throw new Error('refusing ' + tables.length + ' tables; the observed cap is ' + MAX_CONCURRENT);
    }
    this.jsessionid = jsessionid;
    this.names = names;
    this.state = new Map();
    for (const id of tables) {
      this.state.set(id, {
        id,
        name: names.get(id) || id,
        server: 'gs15',
        status: 'connecting',
        physical: null,
        dealer: null,
        shoe: null,
        round: null,
        phase: null,
        seats: {},
        taken: [],      // occupied positions, from the seats_taken bitmask
        betCount: 0,    // players with a main bet this round
        streaks: {},    // per-seat win streak, drives the "on fire" marker
        rc: 0,
        seen: 0,
        fromShoeStart: false, backoff: BACKOFF_BASE, // true once a shoe change is seen while connected
        updatedAt: Date.now(),
        _counted: new Set(),
      });
    }
  }

  snapshot() {
    return [...this.state.values()].map((t) => {
      const { _counted, ws, ka, redirecting, ...rest } = t;
      // `seat` messages only fire when somebody sits or stands, so a table nobody has
      // moved at since we connected reports an empty mask. Anyone holding cards or a
      // bet is demonstrably seated, so fold those in for a truthful occupancy.
      const occupied = new Set(t.taken || []);
      for (const key of Object.keys(t.seats || {})) {
        if (key === 'dealer') continue;
        const n = parseInt(key, 10);
        if (Number.isFinite(n)) occupied.add(n);
      }
      rest.taken = [...occupied].sort((a, b) => a - b);
      // decks remaining from cards seen this session (8-deck shoe); floored so the
      // true count near the cut card stays finite rather than exploding
      const decksLeft = Math.max(0.5, (TOTAL_CARDS - t.seen) / 52);
      rest.decksLeft = Math.round(decksLeft * 10) / 10;
      rest.trueCount = Math.round((t.rc / decksLeft) * 10) / 10;
      return rest;
    });
  }

  start() {
    for (const id of this.state.keys()) this.#connect(id, BOOTSTRAP);
    return this;
  }

  // Swap in a freshly minted session and reconnect every table.
  setSession(jsessionid) {
    if (!jsessionid || jsessionid === this.jsessionid) return;
    this.jsessionid = jsessionid;
    this.authFailures = 0;
    for (const t of this.state.values()) {
      t.failures = 0;
      t.redirecting = true; // suppress the close handler's own reconnect
      clearInterval(t.ka);
      try { t.ws && t.ws.close(); } catch {}
      t.status = 'reconnecting';
      t.redirecting = false;
    }
    for (const id of this.state.keys()) this.#connect(id, BOOTSTRAP);
    this.emit('update', null);
  }

  stop() {
    for (const t of this.state.values()) {
      t.stopped = true;
      clearInterval(t.ka);
      try { t.ws && t.ws.close(); } catch {}
    }
    this.state.clear();
  }

  liveCount() {
    return this.state.size;
  }

  // Bring one table live without disturbing the others already streaming.
  addTable(id) {
    if (this.state.has(id)) return true;
    if (this.state.size >= MAX_CONCURRENT) return false;
    this.state.set(id, {
      id,
      name: this.names.get(id) || id,
      server: 'gs15',
      status: 'connecting',
      physical: null, dealer: null, shoe: null, round: null, phase: null,
      seats: {}, taken: [], betCount: 0, streaks: {},
      rc: 0, seen: 0, fromShoeStart: false, backoff: BACKOFF_BASE, updatedAt: Date.now(), _counted: new Set(),
    });
    this.#connect(id, BOOTSTRAP);
    this.emit('update', id);
    return true;
  }

  // Drop one table's socket and forget it, leaving the rest untouched.
  removeTable(id) {
    const t = this.state.get(id);
    if (!t) return;
    t.stopped = true;
    clearInterval(t.ka);
    try { t.ws && t.ws.close(); } catch {}
    this.state.delete(id);
    this.emit('update', id);
  }

  #touch(t) {
    t.updatedAt = Date.now();
    this.emit('update', t.id);
  }

  // count each physical card once, however many times it is reported
  #count(t, game, seat, hand, sc) {
    if (!sc) return;
    const key = game + '|' + seat + '|' + hand + '|' + sc;
    if (t._counted.has(key)) return;
    t._counted.add(key);
    t.rc += hiLo(sc);
    t.seen++;
  }

  #connect(id, wsAddress, hops = 0) {
    const t = this.state.get(id);
    if (!t || t.stopped) return;
    if (hops > 3) {
      t.status = 'error: too many redirects';
      return this.#touch(t);
    }

    const url =
      wsAddress + '?JSESSIONID=' + encodeURIComponent(this.jsessionid) +
      '&tableId=' + id + '&type=json&version=3';
    const ws = new WebSocket(url, { origin: ORIGIN });
    t.ws = ws;
    let channel = null;

    // The socket opens even with a dead session, so "connected" is not "working".
    ws.on('open', () => {
      t.status = 'connected';
      t.openedAt = Date.now(); // measured on close to tell a healthy run from a flap
      this.#touch(t);
    });

    ws.on('message', (buf) => {
      let j;
      try { j = JSON.parse(buf.toString()); } catch { return; }
      const kind = Object.keys(j)[0];
      const b = j[kind] || {};
      if (b.channel) channel = b.channel;

      // every raw message, tagged with its table, for the recorder
      this.emit('message', { tableId: id, kind, message: j });

      // real table data proves the session is good
      if (!['switch', 'duplicatePlayerSession', 'logout', 'closeConnection'].includes(kind)) {
        // note: the backoff is NOT reset here - a single message is not proof of a
        // healthy connection. It resets on close, only if the socket lasted.
        if (t.status !== 'live') { t.status = 'live'; t.failures = 0; }
      }

      switch (kind) {
        case 'switch':
          t.server = b.gameServer;
          t.redirecting = true;
          return this.#connect(id, b.wsAddress, hops + 1);

        case 'duplicatePlayerSession':
          t.status = 'refused: account already has ' + MAX_CONCURRENT + ' sockets open';
          return this.#touch(t);

        case 'table':
          t.physical = b.value;
          return this.#touch(t);

        case 'dealer':
          t.dealer = b.value;
          return this.#touch(t);

        case 'currentShoe':
          if (t.shoe && t.shoe !== b.code) {
            // a new shoe started while we were watching, so we have counted it
            // from the first card - the true count is now trustworthy
            t.rc = 0;
            t.seen = 0;
            t._counted.clear();
            t.fromShoeStart = true;
            this.emit('shoe', { id, shoe: b.code });
          }
          t.shoe = b.code;
          return this.#touch(t);

        case 'game':
          t.round = b.id;
          t.seats = {};      // hands and bets are per-round
          t.betCount = 0;
          t.phase = 'dealing';
          return this.#touch(t);

        // who is sitting at the table, whether or not they have cards yet
        case 'seat':
          if (b.seats_taken != null) t.taken = seatsFromMask(b.seats_taken);
          return this.#touch(t);

        // how many players actually placed a main bet this round
        case 'mainBetCount':
          t.betCount = Number(b.mainBetCount) || 0;
          return this.#touch(t);

        // stake per position; side bets (perfect pairs, 21+3) are tracked separately
        case 'bet': {
          const amount = Number(b.amount) || 0;
          const k = seatKey(b.seat);
          const s = (t.seats[k] ||= { cards: [], score: null, result: null });
          if (b.betCategory === 'MAIN') s.bet = (Number(s.bet) || 0) + amount;
          else s.side = (Number(s.side) || 0) + amount;
          return this.#touch(t);
        }

        // consecutive wins per position - the provider's own "on fire" streak
        case 'wins': {
          const streaks = {};
          for (const key of Object.keys(b)) {
            const m = /^seat(\d+)$/.exec(key);
            if (m) streaks[m[1]] = Number(b[key]) || 0;
          }
          t.streaks = streaks;
          return this.#touch(t);
        }

        case 'betsopen':
        case 'betsclosingsoon':
        case 'betsclosed':
        case 'startDealing':
          t.phase = kind;
          return this.#touch(t);

        case 'card': {
          this.#count(t, b.game, b.seat, b.hand, b.sc);
          const k = seatKey(b.seat);
          const s = (t.seats[k] ||= { cards: [], score: null, result: null });
          if (!s.cards.includes(card(b.sc))) s.cards.push(card(b.sc));
          s.score = b.score;
          return this.#touch(t);
        }

        // full hand state; h0 is the main hand, h1.. appear after a split
        case 'playerSeat': {
          for (const key of Object.keys(b)) {
            if (!/^h\d+$/.test(key)) continue;
            const h = b[key];
            if (!h || !h.cards) continue;
            for (const c of h.cards) this.#count(t, b.gameId, b.seatNumber, key, c.scanCode);
            const k = seatKey(b.seatNumber) + (key === 'h0' ? '' : '/' + key);
            const prev = t.seats[k] || {};
            // the provider sends the string "None" when no decision applies
            const raw = h.currentDecision ||
              (Array.isArray(h.previousDec) ? h.previousDec[h.previousDec.length - 1] : null);
            const dec = raw && raw !== 'None' ? raw : null;
            t.seats[k] = {
              ...prev,                       // keep the stake already recorded
              cards: h.cards.map((c) => card(c.scanCode)),
              score: h.score,
              hole: !!h.hiddenCardDealt,
              bust: !!h.bust,
              active: !!h.activeHand,        // whose turn it is right now
              decision: dec || prev.decision || null,
              result: prev.result || null,
            };
          }
          return this.#touch(t);
        }

        case 'score': {
          const s = (t.seats[seatKey(b.seat)] ||= { cards: [], score: null, result: null });
          s.score = b.value;
          return this.#touch(t);
        }

        case 'handresult': {
          const s = (t.seats[seatKey(b.seat)] ||= { cards: [], score: null, result: null });
          s.result = b.value;
          return this.#touch(t);
        }

        case 'bjGameEnd':
          t.phase = 'ended';
          return this.#touch(t);
      }
    });

    ws.on('error', (e) => {
      t.status = 'error: ' + e.message;
      this.#touch(t);
    });

    ws.on('close', () => {
      if (t.redirecting) { t.redirecting = false; return; } // switch closes the old socket
      if (t.stopped) return;

      // Closing without ever delivering data is what an expired session looks
      // like. Two in a row on the same table means the session, not the table.
      if (t.status !== 'live' && !/refused/.test(t.status || '')) {
        t.failures = (t.failures || 0) + 1;
        if (t.failures >= 2) {
          this.authFailures++;
          this.emit('authfail', id);
        }
      }

      t.status = 'reconnecting';
      this.#touch(t);
      clearInterval(t.ka);
      // Exponential backoff. Only a connection that stayed up counts as healthy
      // enough to reset it; a flap keeps doubling, up to BACKOFF_MAX.
      const lasted = Date.now() - (t.openedAt || 0);
      if (t.openedAt && lasted >= STABLE_MS) t.backoff = BACKOFF_BASE;
      const delay = t.backoff || BACKOFF_BASE;
      t.backoff = Math.min(delay * 2, BACKOFF_MAX);
      this.emit('log', { level: 'warn', msg: 'reconnecting ' + id + ' in ' + delay + 'ms' });
      setTimeout(() => this.#connect(id, BOOTSTRAP), delay);
    });

    clearInterval(t.ka);
    t.ka = setInterval(() => {
      if (ws.readyState === 1 && channel) {
        ws.send('<ping channel="' + channel + '" time="' + Date.now() + '"/>');
      }
    }, 10000);
  }
}
