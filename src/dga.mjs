// DGA lobby feed — every table's occupancy/status on ONE unauthenticated socket.
//
// This is the socket the live-casino lobby iframe uses (FINDINGS §6k). It connects to
// wss://dga-lc.pragmaticplaylive.net/ws with NO JSESSIONID and streams, for a casinoId:
//
//   {globalStats:{playerCount,crashPlayerCount}}
//   {tableKey:[...]}                              every table's key (operatorGameId)
//   {seat1..seat7,totalSeatedPlayers,availableSeats,playerCount,dealer,tableId,tableName,
//    tableType,tableVariant,onFireSeatCount,tableOpen,relativeSnapPath,...}   snapshot on subscribe
//   {tableId,...changed fields}                   occupancy deltas thereafter
//
// It carries NO cards — the client's own parser handles only globalStats/tableKey/tableId/
// pongTime. So this is the all-tables *radar* (who is sitting where, dealer, open/closed,
// the provider's onFireSeatCount), used to choose which six tables to point a real card
// socket at. It costs none of the 6-socket game budget and needs no login.
//
// Read-only: it sends only subscribe/statistics/ping, never a wagering command.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const URL_ = 'wss://dga-lc.pragmaticplaylive.net/ws';
const ORIGIN = 'https://client.pragmaticplaylive.net';
const BACKOFF_BASE = 2000;
const BACKOFF_MAX = 60000;
const PING_MS = 5000;
const STATS_MS = 15000;
// Several hundred tables are subscribed on one socket, so occupancy updates arrive
// constantly. This much silence means the socket has gone quiet without closing - the
// failure that leaves `connected` true, the status reading "live", and no data flowing.
const STALE_MS = 90000;

// "assets/snaps/sobj027blackjack/poster.jpg" -> "sobj027blackjack": the DGA snapshot
// carries the lobby id (what the game socket wants) inside the snap path, while its own
// `tableId` field is the operatorGameId. This is the join between the two id spaces.
export function tableIdFromSnap(path) {
  const m = /snaps\/([a-z0-9]+)\//i.exec(path || '');
  return m ? m[1] : null;
}

// Roulette results arrive as a full last20Results window on the snapshot, then deltas
// that may carry only the new spin. Merge by gameId so history accumulates instead of
// being overwritten by a short delta, newest first, capped at 20.
// NEVER sort these by `time`. The subscribe snapshot and the live deltas timestamp in
// different zones and formats - a snapshot entry reads "Sep 9, 2026 10:12:30 AM" while
// the delta for a newer spin reads "Sep 09, 2026 09:10:12 AM", an hour EARLIER. Sorting
// by time therefore pushed every new spin below the existing 20 and slice() dropped it,
// which is why the wall's numbers sat frozen while the socket was healthy.
// Arrival order is the truth: a delta is by definition the newest spin.
export function mergeResults(prev, incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return prev || null;
  if (!Array.isArray(prev) || !prev.length) return incoming.slice(0, 20);
  const key = (r) => (r ? (r.gameId || r.time + ':' + r.result) : null);
  const known = new Set(prev.map(key));
  const fresh = incoming.filter((r) => key(r) != null && !known.has(key(r)));
  if (!fresh.length) return prev;
  return [...fresh, ...prev].slice(0, 20);   // newest first, order preserved
}

export class DgaLobby extends EventEmitter {
  // keys: operatorGameId strings to subscribe (the blackjack tables we care about).
  // keyToId: optional Map(operatorGameId -> lobby tableId) so occupancy is keyed by the
  //          same id the rest of the app uses even before a snapshot's snap path arrives.
  constructor({ casinoId, currency = 'EUR', keys = [], keyToId = new Map(), operator = null }) {
    super();
    if (!casinoId) throw new Error('casinoId required');
    this.casinoId = casinoId;
    this.currency = currency;
    this.keys = new Set(keys.map(String));
    this.keyToId = keyToId;                 // operatorGameId -> lobby tableId
    this.operator = operator;
    this.tables = new Map();                // lobby tableId (or key) -> occupancy snapshot
    this.globalStats = null;
    this.availableKeys = [];                // everything the casino offers (from tableKey)
    this.stopped = false;
    this.backoff = BACKOFF_BASE;
    this.ws = null;
    this.connected = false;   // surfaced as provider status in the UI
    this.lastDataAt = 0;
  }

  start() { this.#connect(); return this; }

  stop() {
    this.stopped = true;
    this.#clearTimers();
    clearTimeout(this.retry);
    try { this.ws && this.ws.close(); } catch {}
    this.tables.clear();
  }

  snapshot() { return [...this.tables.values()]; }
  get(id) { return this.tables.get(id) || null; }

  // Add more tables to watch after connect (e.g. the catalogue grew).
  subscribe(keys) {
    let added = false;
    for (const k of keys.map(String)) if (!this.keys.has(k)) { this.keys.add(k); added = true; if (this.#open()) this.#send({ type: 'subscribe', isDeltaEnabled: true, casinoId: this.casinoId, key: k, currency: this.currency }); }
    return added;
  }

  #open() { return this.ws && this.ws.readyState === WebSocket.OPEN; }
  #send(o) { if (this.#open()) { try { this.ws.send(JSON.stringify(o)); } catch {} } }

  #connect() {
    if (this.stopped) return;
    const ws = new WebSocket(URL_, { origin: ORIGIN, perMessageDeflate: true });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = BACKOFF_BASE;
      this.connected = true;
      this.#send({ type: 'statistics' });
      this.#send({ type: 'available', casinoId: this.casinoId });
      for (const k of this.keys) this.#send({ type: 'subscribe', isDeltaEnabled: true, casinoId: this.casinoId, key: k, currency: this.currency });
      this.emit('open');
    });

    ws.on('message', (buf) => {
      let j; try { j = JSON.parse(buf.toString()); } catch { return; }
      if (j.pongTime) return;
      if (j.globalStats) { this.globalStats = j.globalStats; this.emit('stats', j.globalStats); return; }
      if (j.tableKey) { this.availableKeys = j.tableKey; this.emit('keys', j.tableKey); return; }
      if (j.tableId != null) { this.lastDataAt = Date.now(); this.#table(j); }
    });

    ws.on('error', () => {});   // close handler drives reconnect
    ws.on('close', () => {
      this.#clearTimers();
      this.connected = false;
      if (this.stopped) return;
      const delay = this.backoff;
      this.backoff = Math.min(delay * 2, BACKOFF_MAX);
      this.emit('reconnect', delay);
      this.retry = setTimeout(() => this.#connect(), delay);
    });

    this.#clearTimers();
    this.lastDataAt = Date.now();   // don't judge staleness before the first data lands
    this.ping = setInterval(() => this.#send({ type: 'ping', pingTime: Date.now() }), PING_MS);
    this.stats = setInterval(() => this.#send({ type: 'statistics' }), STATS_MS);
    // A quiet-but-open socket never fires 'close', so nothing would ever reconnect.
    // Dropping it ourselves is what turns a silently dead feed back into a live one.
    this.watch = setInterval(() => {
      const quiet = Date.now() - this.lastDataAt;
      if (quiet > STALE_MS) {
        this.emit('log', { level: 'warn', msg: 'dga stale for ' + Math.round(quiet / 1000) + 's — reconnecting' });
        this.#clearTimers();
        try { this.ws && this.ws.close(); } catch {}
      }
    }, 20000);
  }

  #clearTimers() {
    clearInterval(this.ping); clearInterval(this.stats); clearInterval(this.watch);
    this.ping = this.stats = this.watch = null;
  }

  // Fold a snapshot or delta into occupancy, keyed by the lobby tableId when known.
  #table(msg) {
    const key = String(msg.tableId);                    // operatorGameId
    const lobbyId = tableIdFromSnap(msg.relativeSnapPath || msg.tableImage) || this.keyToId.get(key) || key;
    const prev = this.tables.get(lobbyId) || { key, id: lobbyId, operator: this.operator };
    const seatsTaken = [];
    for (let i = 1; i <= 7; i++) if (msg['seat' + i] === true) seatsTaken.push(i);
    const hadSeatField = [1, 2, 3, 4, 5, 6, 7].some((i) => ('seat' + i) in msg);

    const cur = {
      ...prev,
      key,
      id: lobbyId,
      operator: this.operator,
      name: msg.tableName ?? prev.name ?? null,
      type: msg.tableType ?? prev.type ?? null,
      variant: msg.tableVariant ?? prev.variant ?? null,
      dealer: (msg.dealer && msg.dealer.name) ?? prev.dealer ?? null,
      seated: msg.totalSeatedPlayers ?? prev.seated ?? (hadSeatField ? seatsTaken.length : 0),
      available: msg.availableSeats ?? prev.available ?? null,
      players: msg.playerCount ?? prev.players ?? null,
      onFire: msg.onFireSeatCount ?? prev.onFire ?? 0,
      seatsTaken: hadSeatField ? seatsTaken : (prev.seatsTaken || []),
      open: msg.tableOpen ?? prev.open ?? true,
      // roulette tables carry their recent spins here: [{time,result,color,gameId,slots?}]
      // merged by gameId so a single-spin delta extends history rather than replacing it
      results: 'last20Results' in msg ? mergeResults(prev.results, msg.last20Results) : (prev.results ?? null),
      updatedAt: Date.now(),
    };
    this.tables.set(lobbyId, cur);
    this.emit('table', cur);
  }
}
