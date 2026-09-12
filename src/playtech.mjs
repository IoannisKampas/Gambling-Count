// Playtech live-lobby feed — all tables and their results over one protobuf socket.
//
// Reversed from the game client (see tools/pt-decode.mjs / pt-proto.mjs). The gateway
// wss://ielive-gateway.ptielive.com/ws speaks base64-free binary protobuf with no
// published schema; the three frames below are the real client's own Init, login and
// lobby-subscribe messages, replayed with a fresh context id and session token.
//
//   InitRequest                    -> InitResponse carries a context id (field 4)
//   loginRequest{3.103.1 = token}  -> loginResponse authenticates the socket
//   lobby/subscribeRequest         -> tablesUpdateNotification stream
//
// Results are encoded as number + 100 (verified: a table showing field 12 = "33" reports
// field 58.1.2 = 133). The lobby sends the LAST result per table reliably and only a
// short history for some, so history is accumulated here as spins arrive - the same
// approach used for the Pragmatic feed.
//
// Unlike Pragmatic's DGA this socket requires an authenticated player session, and the
// token lives ~5 minutes, so a mintToken() callback is required and is called again on
// every reconnect. Read-only: nothing here ever places a bet.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { parseRaw, getField, str, buildLogin, retarget, readVarint } from '../tools/pt-proto.mjs';

const URL_ = 'wss://ielive-gateway.ptielive.com/ws';
const ORIGIN = 'https://ielive.ptielive.com';
const RESULT_BASE = 100;      // results are stored as number + 100
const HISTORY = 20;           // keep the last 20 spins per table, like the Pragmatic wall
const BACKOFF_BASE = Number(process.env.PT_BACKOFF_MS || 2000);
const BACKOFF_MAX = 60000;

// The real client's frames, captured verbatim.
const FRAME = {
  init: Buffer.from('Ch1wdC5saXZlLnVzZXIuaW5pdC9Jbml0UmVxdWVzdBIBMBoAMABgAQ==', 'base64'),
  login: Buffer.from('Ch1wdC5saXZlLnVzZXIvbG9naW5SZXF1ZXN0LzEuMBIBMxqZAwoKIgEwMN7z5Y2INFoIcGlrYWdpcmxqCXN0b2l4aW1hbnIJc3RvaXhpbWFuggECZWyIAQSSAQgyNi42LjYuMaoBBzYyLjEzLjCyAbABCgdXaW5kb3dzEgIxMBoDTi9BMgkxOTIweDEwODA6BWVuLVVTQgI0Z0oGQ2hyb21lUgkxNTIuMC4wLjBgAmpvTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE1Mi4wLjAuMCBTYWZhcmkvNTM3LjM2cAHAAQDKAQZjYXNpbm/QAQDYAQCCAgoxMjUwNTEzMzExkgIDcm9smgIUcm9sX3JvdWxldHRlaXRhbGlhbmGoAgC6BloKWHMtQ0xWV2xlemNVZkc5cDFQc3NZeWpHTWl5cG01T2R1MFhoNGN0cXBfdDByUjRtUHNVcVlaWGdZVEs0Q1dHMWlmOUFKRk1wQzM4NHh3d3VBMUt3STliN3ciElgwQ216WHROdGlZS2YyUWY5dTAAYAE=', 'base64'),
  subscribe: Buffer.from('Ch5wdC5saXZlLmxvYmJ5L3N1YnNjcmliZVJlcXVlc3QSAjI3GrABCBMIFAgjCAMIYAgLCFcIAggPCBoIHggdCCUIPQhBCFEIUAhjCFoIZAhoCAgICggkCAQICQgYCDIIFwgGCAUILwgBCBYIIghZCCYIJwgoCCwIXQg0CDEINwhFCEgISQhfCAwIOghWCGYIEQgwCBIIHwgVCBAIGwgqCBwIIAgpCCsILQguCDUINgg5CDsIPAg/CEAIQwhECEcIRghKCEsITAhNCFMIWwhVCFIIXAhiCGEiElgwQ216WHROdGlZS2YyUWY5dTAAYAE=', 'base64'),
  // The real client asks for lobby settings and favourites before subscribing; sending
  // subscribe on its own is answered with "not authenticated".
  lobbySettings: Buffer.from('CiVwdC5saXZlLmxvYmJ5L2dldExvYmJ5U2V0dGluZ3NSZXF1ZXN0EgE4GgAiElgwQ216WHROdGlZS2YyUWY5dTAAYAE=', 'base64'),
  favorites: Buffer.from('CiFwdC5saXZlLmxvYmJ5L2dldEZhdm9yaXRlc1JlcXVlc3QSAjE4GgAiElgwQ216WHROdGlZS2YyUWY5dTAAYAE=', 'base64'),
  // The real client's heartbeat. Without it the gateway can stop delivering while the
  // TCP socket stays open, so 'close' never fires and nothing ever re-mints.
  time: Buffer.from('ChxwdC5saXZlLnVzZXIvdGltZVJlcXVlc3QvMS4wEgIxNhoTCgoiATAwzvvljYg0WM775Y2INCISWDBDbXpYdE50aVlLZjJRZjl1MABgAQ==', 'base64'),
};

const PING_MS = 25000;    // heartbeat cadence
// Shortest plausible gap between two genuine spins on one wheel. Below this, an
// identical number means the same frame arrived twice, not a back-to-back repeat.
const MIN_SPIN_GAP_MS = Number(process.env.PT_MIN_SPIN_GAP_MS || 8000);
// A lobby of ~80 wheels produces updates constantly, so silence this long means the
// feed is dead even though the socket looks fine (cf. PATTERNS.md §8.4).
const STALE_MS = Number(process.env.PT_STALE_MS || 120000);
// The heartbeat goes out every 25s, so three unanswered means the socket is gone.
const PONG_STALE_MS = Number(process.env.PT_PONG_STALE_MS || 90000);

// Game-type codes seen in the lobby (field 106). Anything ending "rol"/"rodzl" is a wheel.
export const isRoulette = (t) => /ro(l|fl|dzl)$/.test(t || '') || /rol$/.test(t || '');

const vint = (raw) => { const [v] = readVarint(raw, 0); return Number(v); };

// Merge a newest-first run of results into the stored newest-first history.
// The incoming list usually overlaps what we already hold, so find where it rejoins and
// prepend only the genuinely new spins - taking just incoming[0] loses any spin that
// landed between two updates, which is what made numbers appear to be skipped.
export function spliceHistory(prev, incoming, cap = HISTORY) {
  if (!incoming || !incoming.length) return prev;
  if (!prev || !prev.length) return incoming.slice(0, cap);
  for (let k = 0; k < incoming.length; k++) {
    const tail = incoming.slice(k);
    // does incoming[k..] line up with the front of what we already have?
    if (tail.every((v, i) => prev[i] === v)) {
      return k === 0 ? prev.slice(0, cap) : [...incoming.slice(0, k), ...prev].slice(0, cap);
    }
  }
  // no overlap at all - we were away long enough that the runs do not touch
  return [...incoming, ...prev].slice(0, cap);
}
// the envelope's method name is field 1
const methodOf = (buf) => { try { return str(getField(parseRaw(buf), 1)); } catch { return null; } };

export class PlaytechLobby extends EventEmitter {
  // mintToken: async () => 's-…' (5-minute token; called again on every reconnect)
  constructor({ mintToken, casino = 'stoiximan' }) {
    super();
    if (typeof mintToken !== 'function') throw new Error('mintToken callback required');
    this.mintToken = mintToken;
    this.casino = casino;
    this.tables = new Map();   // tableId -> {id, type, last, history[], updatedAt}
    this.stopped = false;
    this.backoff = BACKOFF_BASE;
    this.ctx = null;
    this.req = 20;
    // surfaced in the UI so a feed that quietly stopped is visible rather than
    // looking like a quiet lobby
    this.state = 'idle';       // idle|minting|connecting|live|reconnecting|error|stopped
    this.lastError = null;
    // Two separate clocks, deliberately. lastDataAt is TABLE data only; lastPongAt is
    // the heartbeat. Letting the heartbeat touch lastDataAt made the watchdog
    // un-fireable - our own ping kept it fresh while the feed was dead, and the status
    // kept reading "live".
    this.lastDataAt = 0;
    this.lastPongAt = 0;
    this.since = 0;            // when it went live
  }

  status() {
    return {
      state: this.state,
      tables: this.roulettes().filter((t) => t.last != null).length,
      allTables: this.tables.size,
      lastDataAt: this.lastDataAt,
      lastError: this.lastError,
      since: this.since,
    };
  }

  snapshot() { return [...this.tables.values()]; }
  roulettes() { return this.snapshot().filter((t) => isRoulette(t.type)); }

  start() { this.#connect(); return this; }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.#clearTimers();
    try { this.ws && this.ws.close(); } catch {}
  }

  async #connect() {
    if (this.stopped) return;
    let token;
    this.state = 'minting';
    try {
      token = await this.mintToken();
      if (!token) throw new Error('mintToken returned nothing');
      this.lastError = null;
    } catch (e) {
      this.state = 'error';
      this.lastError = e.message;
      this.emit('log', { level: 'warn', msg: 'playtech token mint failed: ' + e.message });
      return this.#requeue();
    }
    this.state = 'connecting';

    const ws = new WebSocket(URL_, {
      origin: ORIGIN,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0 Safari/537.36' },
    });
    this.ws = ws;
    this.ctx = null;

    ws.on('open', () => { try { ws.send(FRAME.init); } catch {} });
    ws.on('message', (b) => this.#onFrame(Buffer.isBuffer(b) ? b : Buffer.from(b), token));
    ws.on('error', (e) => this.emit('log', { level: 'warn', msg: 'playtech ws: ' + e.message }));
    ws.on('close', () => {
      this.#clearTimers();
      if (this.state === 'live') this.state = 'reconnecting';
      if (!this.stopped) this.#requeue(); else this.state = 'stopped';
    });
  }

  #clearTimers() { clearInterval(this.hb); clearInterval(this.watch); this.hb = this.watch = null; }

  // Drop the socket so the close handler reconnects - and, because #connect mints
  // first, that is what actually refreshes the token.
  #recycle(why) {
    this.emit('log', { level: 'warn', msg: 'playtech recycling: ' + why });
    this.#clearTimers();
    // We are dropping a socket we believe is healthy-but-quiet, not recovering from a
    // failure - so do not inherit the escalating backoff (which reaches minutes and is
    // what makes a re-mint feel slow). A mint itself takes about five seconds.
    this.backoff = BACKOFF_BASE;
    try { this.ws && this.ws.close(); } catch {}
  }

  // Started once the socket is authenticated.
  #startKeepalive() {
    this.#clearTimers();
    this.lastDataAt = Date.now();
    this.lastPongAt = Date.now();
    this.hb = setInterval(() => {
      if (!this.ctx) return;
      this.#send(retarget(FRAME.time, { contextId: this.ctx, requestId: String(this.req++) }));
    }, PING_MS);
    this.watch = setInterval(() => {
      const quietData = Date.now() - this.lastDataAt;
      const quietPong = Date.now() - this.lastPongAt;
      // Table data drying up is the real failure; an unanswered heartbeat means the
      // socket itself is gone. Judge them separately - a pong must never be taken as
      // evidence that the feed is alive.
      if (quietData > STALE_MS) {
        this.#recycle('no table data for ' + Math.round(quietData / 1000) + 's');
      } else if (quietPong > PONG_STALE_MS) {
        this.#recycle('heartbeat unanswered for ' + Math.round(quietPong / 1000) + 's');
      }
    }, 30000);
  }

  #requeue() {
    clearTimeout(this.retry);
    const delay = this.backoff;
    this.backoff = Math.min(delay * 2, BACKOFF_MAX);
    this.emit('log', { level: 'warn', msg: 'playtech reconnecting in ' + delay + 'ms' });
    this.retry = setTimeout(() => this.#connect(), delay);
  }

  #send(buf) { if (this.ws && this.ws.readyState === WebSocket.OPEN) { try { this.ws.send(buf); } catch {} } }

  #onFrame(buf, token) {
    const m = methodOf(buf) || '';

    if (!this.ctx && /InitResponse/.test(m)) {
      this.ctx = str(getField(parseRaw(buf), 4));
      this.#send(buildLogin(FRAME.login, { token, contextId: this.ctx, requestId: String(this.req++) }));
      return;
    }
    if (/loginResponse/.test(m)) {
      // A real login echoes the player's own details; anything short is a rejection.
      const real = buf.length > 500 && !/not authenticated|Invalid/i.test(buf.toString('utf8'));
      this.emit('log', { level: real ? 'info' : 'warn', msg: 'playtech loginResponse ' + buf.length + 'B ' + (real ? 'accepted' : 'REJECTED') });
      if (!real) {
        this.state = 'error';
        this.lastError = 'login rejected (token stale or already used)';
        try { this.ws.close(); } catch {} return;
      }
      // A reconnect means an unknown number of spins happened while we were away, and
      // Playtech results carry no stable id, so no amount of diffing can recover the
      // gap. Throw the accumulated history away and let the fresh snapshot re-seed it;
      // `gap` tells the pattern tracker to discard its counts too (PATTERNS.md §8.2).
      if (this.everLive) {
        for (const t of this.tables.values()) { t.history = []; t.last = null; t.lastSpinAt = 0; }
        this.emit('gap', { reason: 'reconnected' });
      }
      this.everLive = true;
      this.state = 'live';
      this.since = Date.now();
      this.lastError = null;
      this.backoff = BACKOFF_BASE;             // a real login proves the chain is healthy
      // Same order the real client uses - settings and favourites first, then subscribe.
      this.#send(retarget(FRAME.lobbySettings, { contextId: this.ctx, requestId: String(this.req++) }));
      this.#send(retarget(FRAME.favorites, { contextId: this.ctx, requestId: String(this.req++) }));
      this.#send(retarget(FRAME.subscribe, { contextId: this.ctx, requestId: String(this.req++) }));
      this.#startKeepalive();
      this.emit('ready');
      return;
    }
    if (/systemError/.test(m)) {
      const text = buf.toString('utf8').replace(/[^\x20-\x7e]/g, ' ').trim();
      this.emit('log', { level: 'warn', msg: 'playtech: ' + text.slice(0, 120) });
      // The session went away underneath us - only a fresh token fixes that.
      if (/not authenticated|Invalid context|session/i.test(text)) this.#recycle('session rejected');
      return;
    }
    if (/timeResponse/.test(m)) { this.lastPongAt = Date.now(); return; }   // NOT lastDataAt
    // The subscribe snapshot and the live notifications carry the same entry shape but
    // under different container fields: the snapshot repeats 10/11/13, the notification
    // repeats 2. The snapshot is the richer one - it alone carries table names and the
    // full results history.
    if (/subscribeResponse/.test(m)) {
      this.lastDataAt = Date.now();
      const p = getField(parseRaw(buf), 3);
      if (p) this.#harvest(p.raw, [10, 11, 13], true);
      this.emit('log', { level: 'info', msg: 'playtech snapshot: ' + this.tables.size + ' tables' });
      return;
    }
    if (/tablesUpdateNotification/.test(m)) {
      this.lastDataAt = Date.now();
      const p = getField(parseRaw(buf), 3);
      if (p) this.#harvest(p.raw, [2]);
      return;
    }
  }

  // Walk a lobby payload's repeated table entries and fold names/dealers/results in.
  // entryFields says which container field numbers hold the entries.
  #harvest(payloadRaw, entryFields = [2], isSnapshot = false) {
    let changed = 0;
    for (const entry of parseRaw(payloadRaw).filter((x) => entryFields.includes(x.field) && x.wire === 2)) {
      const f = parseRaw(entry.raw);
      const idF = f.find((x) => x.field === 25);
      if (!idF) continue;
      const id = vint(idF.raw);
      const prev = this.tables.get(id) ||
        { id, name: null, type: '?', alias: null, last: null, history: [], sid: 0, lastSpinAt: 0, updatedAt: 0 };

      const typeF = f.find((x) => x.field === 106);
      if (typeF) prev.type = typeF.raw.toString('utf8');
      // 4 = table name, 104 = launch alias, 16 = dealer, 3 = players (snapshot only for 4/104)
      const nameF = f.find((x) => x.field === 4);
      if (nameF) prev.name = nameF.raw.toString('utf8');
      const aliasF = f.find((x) => x.field === 104);
      if (aliasF) prev.alias = aliasF.raw.toString('utf8');
      const dealerF = f.find((x) => x.field === 16);
      if (dealerF) prev.dealer = dealerF.raw.toString('utf8');
      const playersF = f.find((x) => x.field === 3);
      if (playersF) prev.players = vint(playersF.raw);

      let last = null;
      const f58 = f.find((x) => x.field === 58);
      if (f58) {
        const inner = parseRaw(f58.raw).find((x) => x.field === 1);
        if (inner) {
          const g = parseRaw(inner.raw);
          const lastF = g.find((x) => x.field === 2);
          if (lastF) last = vint(lastF.raw) - RESULT_BASE;
          // Field 58's repeated `7` block is a PRIOR-results list that excludes the
          // current spin (observed: last=30 alongside [29,7,28,12,35]). It used to
          // replace our history whenever it was longer, which spliced old numbers into
          // a live sequence - the phantom "extra number in between" - and undid the
          // clean slate after a reconnect. Only 12 / 58.last describe a new spin, so
          // this block is deliberately ignored.
        }
      }
      // Field 12 is the result as a decimal string, newest first.
      const t12 = f.filter((x) => x.field === 12)
        .map((x) => parseInt(x.raw.toString('utf8'), 10))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 36);

      if (isSnapshot) {
        // The subscribe snapshot carries the whole recent window at once - a history,
        // not a run of individual spins.
        const win = t12.length ? t12 : (last != null ? [last] : []);
        if (win.length) {
          const merged = spliceHistory(prev.history.map((h) => h.n), win);
          if (merged.length !== prev.history.length || merged[0] !== (prev.history[0] || {}).n) {
            prev.history = merged.map((n) => ({ n, sid: ++prev.sid }));
            prev.last = merged[0];
            changed++;
          }
        }
      } else {
        // A live notification is exactly ONE spin. Measured on the wire: a wheel emits
        // one result notification per cycle (~30s apart) and never re-sends the current
        // result. So the number is appended unconditionally - that is what makes a
        // back-to-back repeat count as two spins instead of being swallowed.
        const n = t12.length ? t12[0] : last;
        if (n != null && Number.isFinite(n) && n >= 0 && n <= 36) {
          const now = Date.now();
          // Only guard against the same frame arriving twice: a real repeat is a whole
          // spin cycle apart, a duplicate delivery is near-instant.
          const dupFrame = prev.history.length && prev.history[0].n === n &&
            now - (prev.lastSpinAt || 0) < MIN_SPIN_GAP_MS;
          if (!dupFrame) {
            prev.history = [{ n, sid: ++prev.sid }, ...prev.history].slice(0, HISTORY);
            prev.last = n;
            prev.lastSpinAt = now;
            prev.updatedAt = now;
            changed++;
          }
        }
      }
      this.tables.set(id, prev);
    }
    if (changed) this.emit('update', changed);
  }
}
