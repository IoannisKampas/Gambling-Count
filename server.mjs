// Local dev server for the Blackjack monitor.
// Serves the dashboard and streams table state over SSE. Read-only throughout.
//
// Pragmatic caps concurrent game sockets at 6 per account, so the wall runs one
// authorized operator session per account the user actually holds (Stoiximá,
// Winmasters, Betsson, …) and routes each pinned table to one of them. Capacity is
// 6 x number of live sessions; nothing here tries to exceed a single account's 6.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MultiFeed, MAX_CONCURRENT } from './src/multifeed.mjs';
import { DgaLobby, mergeResults } from './src/dga.mjs';
import { PlaytechLobby, isRoulette as isPtRoulette } from './src/playtech.mjs';
import { PatternTracker, GROUP_A, GROUP_B } from './src/patterns.mjs';
import { SessionProvider } from './src/session.mjs';
import * as operators from './src/operators.mjs';
import { createLogger } from './src/logger.mjs';
import { attachRecorder } from './src/recorder.mjs';

const log = createLogger(process.env.LOG_FILE || 'scraper.log');
const RECORD_DIR = process.env.RECORD_DIR || null; // set to record all messages

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
// Bind address. Defaults to every interface, which is what you want behind a reverse
// proxy on a private network - but note there is no auth in this server, so on a
// public box set HOST=127.0.0.1 and put nginx (with a password) in front.
const HOST = process.env.HOST || '0.0.0.0';

// Operators that carry Pragmatic Play live blackjack, and how each mints a token.
// See src/operators.mjs. Each needs its own authorized login (the user's own
// account); each then gets its own independent 6-table cap.
const DEFAULT_OPERATOR = 'stoiximan';
// how often to check each token is still alive and re-mint it if not
const SESSION_CHECK_MS = Number(process.env.SESSION_CHECK_MS || 4 * 60 * 1000);

// ---------------------------------------------------------------- catalogue ----
// Each operator's lobby returns only the tables that operator carries, so the wall
// shows the union and remembers which sessions can actually open each table.
const catByOp = new Map();     // operator -> raw table rows from its lobby
let catalogue = [];            // merged view, each row tagged with .operators[]
const names = new Map();       // id -> display name; MUTATED IN PLACE (feeds hold it)
let catalogueAt = 0;

// DGA radar state (see the DGA section below for how it is driven).
const RADAR_GAMES = new Set(['blackjack', 'roulette']); // games the radar subscribes
const casinoIds = new Map();   // operator -> casinoId (from that operator's lobby response)
const dgaByOp = new Map();     // operator -> DgaLobby
const dgaState = new Map();    // lobby tableId -> latest occupancy (shared across operators)

const cacheFile = (op) => path.join(ROOT, 'data/lobby-' + op + '.json');
const LEGACY_CACHE = path.join(ROOT, 'data/lobby-tables.json');

function normalise(lobby) {
  return (lobby.tables || []).map((t) => ({
    id: t.id,
    name: (t.title && t.title.key) || t.id,
    game: t.game,
    variant: t.gameLoaderKey || '',
    // operatorGameId is the "key" the DGA lobby socket subscribes by (§6k); the game
    // socket keys by `id`, so both are kept and the maps below join the two id spaces.
    key: t.operatorGameId != null ? String(t.operatorGameId) : null,
    dealer: (t.dealer && t.dealer.name) || '',
    categories: t.tableCategoryIds || [],
    open: t.open,
    min: t.limits && t.limits.min,
    max: t.limits && t.limits.max,
  }));
}

// Merge every operator's catalogue into one list. `operators` is the set of sessions
// that list the table as open, i.e. the sessions allowed to carry it. Bet limits are
// taken from the first operator seen; they can differ slightly between casinos.
function rebuildUnion() {
  const merged = new Map();
  for (const [op, rows] of catByOp) {
    for (const t of rows) {
      const cur = merged.get(t.id);
      if (!cur) {
        merged.set(t.id, { ...t, operators: t.open ? [op] : [] });
      } else {
        if (t.open && !cur.operators.includes(op)) cur.operators.push(op);
        cur.open = cur.open || t.open; // open anywhere is pinnable somewhere
        if (!cur.dealer && t.dealer) cur.dealer = t.dealer;
        // Casinos brand the same table differently; name it the way the primary
        // casino does, so a table keeps one identity across both walls.
        if (op === DEFAULT_OPERATOR && t.name) cur.name = t.name;
      }
    }
  }
  catalogue = [...merged.values()];
  names.clear();
  for (const t of catalogue) names.set(t.id, t.name);
  catalogueAt = Date.now();
}

// Pull one operator's live table list with its own session token.
async function refreshCatalogue(op) {
  const provider = sessions.get(op);
  const token = provider && provider.jsessionid;
  if (!token) return null;
  const r = await fetch(
    'https://games.pragmaticplaylive.net/api/lobby/tables?JSESSIONID=' + encodeURIComponent(token),
    { headers: { Origin: 'https://client.pragmaticplaylive.net', Referer: 'https://client.pragmaticplaylive.net/' } },
  );
  if (!r.ok) throw new Error('lobby API HTTP ' + r.status);
  const lobby = await r.json();
  if (!Array.isArray(lobby.tables)) throw new Error('unexpected lobby payload');
  catByOp.set(op, normalise(lobby));
  if (lobby.casinoId) casinoIds.set(op, lobby.casinoId);
  try { fs.writeFileSync(cacheFile(op), JSON.stringify(lobby, null, 1)); } catch {}
  rebuildUnion();
  ensureDga(op); // start/extend the all-tables radar for this operator
  const bj = catalogue.filter((t) => t.game === 'blackjack');
  log.info('catalogue refreshed via ' + op + ': ' + catalogue.length + ' tables, ' +
    bj.filter((t) => t.open).length + ' open blackjack across ' + catByOp.size + ' session(s)');
  scheduleBroadcast();
  return catalogue.length;
}

async function refreshAll() {
  for (const op of sessions.keys()) {
    await refreshCatalogue(op).catch((e) => log.warn('catalogue ' + op + ': ' + e.message));
  }
}

// Warm start from whatever was cached last run, so the wall is populated before any
// session exists.
for (const op of Object.keys(operators.all())) {
  const file = fs.existsSync(cacheFile(op)) ? cacheFile(op)
    : (op === DEFAULT_OPERATOR && fs.existsSync(LEGACY_CACHE)) ? LEGACY_CACHE : null;
  if (!file) continue;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    catByOp.set(op, normalise(raw));
    if (raw.casinoId) casinoIds.set(op, raw.casinoId);
  } catch {}
}
if (catByOp.size) rebuildUnion();
else log.warn('no cached catalogue yet - will fetch on first session');
// The radar needs no login, so bring it up from the cached catalogue immediately -
// the wall shows live occupancy for every table before any session exists.
for (const op of casinoIds.keys()) ensureDga(op);

// ---------------------------------------------------------------------- DGA ----
// The all-tables radar (FINDINGS §6k). One unauthenticated lobby socket per operator
// casinoId streams every table's occupancy / dealer / open-closed / onFireSeatCount —
// no session, no 6-socket cost. It never carries cards; it is what we use to CHOOSE
// which six (per account) to point a real card feed at.
// (casinoIds / dgaByOp / dgaState are declared with the catalogue state above.)

// Subscribe keys for one operator (blackjack for the counting wall, roulette for the
// results wall), plus the key->id join map. DGA carries occupancy for both and, for
// roulette, each table's recent spins in last20Results.
// Playtech reports only the number, so colour it with the standard European wheel
// (Pragmatic sends the colour itself, so this is only used for the Playtech feed).
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const rouletteColour = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');

// The name most casinos use for a wheel - the un-branded one, since operator-specific
// names ("Betsson Spanish Roulette") are usually the minority against the generic one.
function commonName(t) {
  const names = Object.values(t.namesByOp || {});
  if (!names.length) return null;
  const tally = new Map();
  for (const n of names) tally.set(n, (tally.get(n) || 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function radarKeys(op) {
  const rows = (catByOp.get(op) || []).filter((t) => RADAR_GAMES.has(t.game) && t.key);
  const keyToId = new Map(rows.map((t) => [t.key, t.id]));
  return { keys: rows.map((t) => t.key), keyToId };
}

// Start (or update) the DGA radar for an operator once its casinoId is known. Safe to
// call repeatedly; it only grows the subscription set.
function ensureDga(op) {
  const casinoId = casinoIds.get(op);
  if (!casinoId) return;
  const { keys, keyToId } = radarKeys(op);
  if (!keys.length) return;
  let d = dgaByOp.get(op);
  if (!d) {
    d = new DgaLobby({ casinoId, currency: 'EUR', keys, keyToId, operator: op });
    // Occupancy deltas are frequent across hundreds of tables, so state updates
    // silently and a periodic tick (see startup) flushes it to clients - never a
    // broadcast per seat change.
    //
    // dgaState is keyed by the PHYSICAL table id and every operator that carries that
    // table reports it on its own socket. So accumulate the set of operators rather
    // than letting the last writer win - otherwise a table flips owner between deltas
    // and disappears from an operator-filtered view.
    d.on('table', (t) => {
      const prev = dgaState.get(t.id);
      const ops = new Set(prev ? prev.operators || [] : []);
      ops.add(t.operator);
      // Each casino BRANDS the same physical table differently - one wheel is
      // "Roulette Latina" on Stoiximá and "Betsson Spanish Roulette" on Betsson. The
      // snap path correctly resolves both to one table, so the name must be kept per
      // operator; letting the last writer win shows one casino's branding under
      // another's filter.
      const namesByOp = { ...(prev && prev.namesByOp) };
      if (t.name) namesByOp[t.operator] = t.name;
      dgaState.set(t.id, {
        ...prev, ...t,
        operators: [...ops],
        namesByOp,
        // same physical table, so keep the fullest spin history seen from any operator
        results: mergeResults(prev && prev.results, t.results),
      });
    });
    d.on('reconnect', (ms) => log.warn('dga[' + op + '] reconnecting in ' + ms + 'ms'));
    d.on('log', (e) => (e.level === 'warn' ? log.warn : log.info).call(log, 'dga[' + op + '] ' + e.msg));
    d.on('open', () => log.info('dga[' + op + '] radar live (' + d.keys.size + ' tables)'));
    dgaByOp.set(op, d);
    d.start();
    log.info('dga[' + op + '] started for casino ' + casinoId + ', ' + keys.length + ' tables (blackjack + roulette)');
  } else {
    d.keyToId = keyToId;
    d.subscribe(keys);
  }
}

// ------------------------------------------------------------------- helpers ----
const runNode = async (args, timeout = 150000) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return promisify(execFile)('node', args, { cwd: ROOT, timeout });
};

async function mintPlaytech() {
  try {
    const { stdout } = await runNode(['tools/pt-mint.mjs']);
    const tok = stdout.trim();
    if (!tok) throw new Error('no token minted');
    return tok;
  } catch (e) {
    // pt-mint explains itself on stderr ("is the profile signed in…"); a bare
    // "Command failed" in the log sends you looking in the wrong place.
    const why = String(e.stderr || '').trim().split('\n').pop() || e.message;
    throw new Error(why);
  }
}

// Sign the Chrome profile back in from stored credentials. Best effort: a CAPTCHA or
// 2FA will stop it, and it says so rather than retrying forever.
async function autoLogin(op) {
  log.info('attempting auto-login for ' + op);
  try {
    const { stdout, stderr } = await runNode(['tools/auto-login.mjs', op, '--quiet'], 180000);
    if (String(stdout).includes('signed-in')) { log.info(op + ' auto-login succeeded'); return true; }
    log.warn(op + ' auto-login: ' + (String(stderr).trim().split('\n').pop() || stdout.trim()));
    return false;
  } catch (e) {
    const why = String(e.stdout || '').trim() || String(e.stderr || '').trim().split('\n').pop() || e.message;
    log.warn(op + ' auto-login failed: ' + why.slice(0, 160));
    return false;
  }
}

// ----------------------------------------------------------------- playtech ----
// Second provider for the roulette wall. Playtech's gateway needs an authenticated
// player session and its token lives ~5 minutes, so the mint drives the real launch in
// the signed-in Chrome profile (tools/pt-mint.mjs) and is re-run on every reconnect.
// On by default; set PLAYTECH=0 to disable (minting briefly opens a browser tab).
let playtech = null;
if (process.env.PLAYTECH !== '0') {
  playtech = new PlaytechLobby({
    mintToken: async () => {
      try {
        return await mintPlaytech();
      } catch (e) {
        // The usual cause is the profile having been signed out. Try to sign it back in
        // once, then retry - anything else (CAPTCHA, 2FA, bad password) surfaces as-is.
        if (!/signed in|no token minted/i.test(e.message)) throw e;
        const ok = await autoLogin(DEFAULT_OPERATOR);
        if (!ok) throw new Error(e.message + ' (auto-login could not fix it)');
        return await mintPlaytech();
      }
    },
  });
  playtech.on('log', (e) => (e.level === 'warn' ? log.warn : log.info).call(log, e.msg));
  playtech.on('ready', () => log.info('playtech lobby authenticated; ' + playtech.snapshot().length + ' tables'));
  // Reconnected after a token re-mint: spins were missed and Playtech results have no
  // stable id, so the counts cannot be continued honestly across the gap.
  playtech.on('gap', () => {
    const n = patterns.markGap((t) => t.meta && t.meta.provider === 'playtech');
    log.warn('playtech reconnected — pattern counts reset for ' + n + ' tables (missed spins)');
  });
  playtech.start();
  log.info('playtech feed enabled');
}

// ------------------------------------------------------------------ sessions ----
const sessions = new Map(); // operator -> SessionProvider
const feeds = new MultiFeed({ names });
const clients = new Set();

feeds.on('update', () => scheduleBroadcast());
feeds.on('log', (e) => (e.level === 'warn' ? log.warn : log.info).call(log, 'feed: ' + e.msg));
if (RECORD_DIR) {
  attachRecorder(feeds, RECORD_DIR);
  log.info('recording all messages to ' + RECORD_DIR);
}

// An expired session shows up as sockets that connect and close without data. Only
// that operator's session is refreshed; the other accounts keep streaming.
feeds.on('authfail', async ({ operator, id }) => {
  const provider = sessions.get(operator);
  if (!provider || provider.status().refreshing) return;
  log.warn('auth failure on ' + id + ' (' + operator + ') - session looks dead, refreshing');
  try {
    const fresh = await provider.refresh();
    feeds.setSession(operator, fresh);
    log.info(operator + ' session refreshed, tables reconnecting');
  } catch (e) {
    log.error(operator + ' session refresh failed: ' + e.message);
  }
  scheduleBroadcast();
});

function provider(op) {
  if (sessions.has(op)) return sessions.get(op);
  const cfg = operators.get(op);
  if (!cfg) throw new Error('unknown operator: ' + op);
  const p = new SessionProvider({
    id: op,
    label: cfg.label,
    origin: cfg.origin,
    mint: cfg.mint,
    gameId: cfg.gameId,
    gameUrl: cfg.gameUrl,
    // a new token for this operator: give it to that feed, refresh its catalogue
    onChange: (token) => {
      feeds.ensure(op, token); // creates the feed (no sockets until a table is pinned)
      scheduleBroadcast();
      refreshCatalogue(op).catch(() => {});
    },
    // SessionProvider masks tokens before they reach here; the logger scrubs again
    logger: (m) => log.info(op + ': ' + m),
  });
  sessions.set(op, p);
  return p;
}

// Keep every session alive on its own. Each operator's token is checked against the
// provider, and a dead one is re-minted from that casino's already-signed-in profile
// - no password is involved, and no other operator is disturbed.
async function checkSessions() {
  for (const [op, p] of sessions) {
    if (p.status().refreshing) continue;

    // Operator signed in and configured but holding no token yet (first run after a
    // login, or a mint that failed earlier): provision it unattended.
    if (!p.jsessionid) {
      if (!p.mintReady) continue;
      try {
        const s = await p.refresh();
        feeds.setSession(op, s);
        log.info(op + ' session provisioned automatically; capacity now ' + feeds.capacity());
      } catch (e) {
        log.warn(op + ' could not provision: ' + e.message);
      }
      continue;
    }

    // Holding a token: keep it alive, and replace it the moment it stops working.
    if (await p.validate(p.jsessionid)) continue;
    log.warn(op + ' token is no longer valid — re-minting');
    try {
      const fresh = await p.refresh();
      feeds.setSession(op, fresh);
      log.info(op + ' token refreshed automatically');
    } catch (e) {
      log.error(op + ' auto-refresh failed: ' + e.message);
    }
  }
  scheduleBroadcast();
}

// Bring one operator's session back to life if it can be: reuse a still-valid token,
// otherwise mint a fresh one (only possible for operators with a launch chain or a
// configured game page). Returns true if the operator ends with a usable session.
// Operators that need a hand-pasted token cannot be revived here and return false.
async function reviveSession(op) {
  const p = sessions.get(op);
  if (!p) return false;
  if (p.jsessionid && await p.validate(p.jsessionid)) return true; // already good
  if (!p.canMint) return false;                                    // needs a manual token
  try {
    const s = await p.refresh(); // coalesces if a mint is already in flight; respects cooldown
    feeds.setSession(op, s);
    log.info(op + ' session revived for auto-fill');
    return true;
  } catch (e) {
    log.warn(op + ' could not be revived: ' + e.message);
    return false;
  }
}

function sessionStates() {
  return [...sessions.values()].map((p) => ({
    ...p.status(),
    live: feeds.liveOn(p.id),   // tables this account is carrying
    slots: MAX_CONCURRENT,      // and its hard per-account ceiling
  }));
}

// Compact per-table occupancy for the wall: only the fields the UI shows, keyed by
// the same lobby tableId the catalogue uses.
function dgaCompact() {
  const out = {};
  for (const t of dgaState.values()) {
    out[t.id] = { seated: t.seated, available: t.available, players: t.players,
      onFire: t.onFire, open: t.open, dealer: t.dealer };
  }
  return out;
}

function broadcast() {
  const payload = 'data: ' + JSON.stringify({
    live: feeds.snapshot(),
    sessions: sessionStates(),
    dga: dgaCompact(),
    max: feeds.capacity(),
    catalogueAt, // UI re-fetches /api/catalogue when this changes
  }) + '\n\n';
  for (const res of clients) res.write(payload);
}

let pending = false;
function scheduleBroadcast() {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; broadcast(); }, 250); // coalesce bursts
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const c of req) body += c;
  return JSON.parse(body);
}

// ------------------------------------------------------------------- routing ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/') {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (url.pathname === '/roulette') {
    const html = fs.readFileSync(path.join(ROOT, 'public/roulette.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (url.pathname === '/settings') {
    const html = fs.readFileSync(path.join(ROOT, 'public/settings.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (url.pathname === '/patterns') {
    const html = fs.readFileSync(path.join(ROOT, 'public/patterns.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // Static assets from public/ (the shared shell stylesheet). Resolved and checked to
  // stay inside public/, so a crafted path cannot walk out of it.
  if (/^\/[\w.-]+\.(css|js|svg|png|ico)$/.test(url.pathname)) {
    const file = path.resolve(path.join(ROOT, 'public'), '.' + url.pathname);
    if (file.startsWith(path.join(ROOT, 'public')) && fs.existsSync(file)) {
      const type = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml',
        png: 'image/png', ico: 'image/x-icon' }[url.pathname.split('.').pop()];
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(file));
    }
    return res.writeHead(404).end('not found');
  }

  if (url.pathname === '/api/catalogue') {
    return json(res, 200, {
      tables: catalogue,
      max: feeds.capacity(),
      perSession: MAX_CONCURRENT,
      operators: operators.all(),
      at: catalogueAt,
    });
  }

  if (url.pathname === '/api/roulette') {
    return json(res, 200, {
      tables: rouletteTables(url.searchParams.get('operator')),
      operators: operators.all(),
      providers: providerStatus(),
      at: Date.now(),
    });
  }

  // Pull the current table list from every operator session we hold.
  if (url.pathname === '/api/catalogue/refresh' && req.method === 'POST') {
    if (!sessions.size) return json(res, 409, { error: 'no session yet — add one first' });
    try {
      await refreshAll();
      return json(res, 200, { ok: true, count: catalogue.length });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (url.pathname === '/api/status') {
    return json(res, 200, {
      live: feeds.snapshot(),
      sessions: sessionStates(),
      dga: dgaCompact(),
      max: feeds.capacity(),
      perSession: MAX_CONCURRENT,
    });
  }

  // ---- everything below this point continues the same request handler ----
  return routeRest(req, res, url);
});

// Health of each results feed, so a provider that quietly stopped is visible in the UI
// instead of looking like a lobby that happens to be idle.
function providerStatus() {
  const dgas = [...dgaByOp.values()];
  const up = dgas.filter((d) => d.connected).length;
  const rouletteCount = [...dgaState.values()]
    .filter((t) => t.type === 'ROULETTE' || Array.isArray(t.results)).length;
  const lastAt = dgas.reduce((m, d) => Math.max(m, d.lastDataAt || 0), 0);

  return {
    pragmatic: {
      // "live" must mean data is flowing, not merely that a socket is open - a quiet
      // socket reading live is exactly what hides a dead feed.
      state: !dgas.length ? 'off'
        : !up ? 'reconnecting'
        : (lastAt && Date.now() - lastAt > 90000) ? 'stale'
        : 'live',
      tables: rouletteCount,
      feeds: up, ofFeeds: dgas.length,
      lastDataAt: lastAt,
      lastError: null,
      note: 'DGA lobby socket · no session needed',
    },
    playtech: playtech
      ? (() => {
          const s = playtech.status();
          // same rule as pragmatic: "live" has to mean data is arriving
          if (s.state === 'live' && s.lastDataAt && Date.now() - s.lastDataAt > 120000) s.state = 'stale';
          return { ...s, note: 'protobuf gateway · token minted in browser' };
        })()
      : { state: 'off', tables: 0, lastDataAt: 0, lastError: null, note: 'disabled (PLAYTECH=0)' },
  };
}

// Roulette tables from both providers, in one shape. Used by /api/roulette and by the
// pattern tracker, so the wall and the counts can never be reading different data.
function rouletteTables(want) {
  const ops = operators.all();
  const tables = [...dgaState.values()]
      // a table is offered by every operator in t.operators, so filter by membership -
      // not by a single "owner", which flips as different operators' deltas arrive
      .filter((t) => (t.type === 'ROULETTE' || Array.isArray(t.results)) &&
        (!want || (t.operators || []).includes(want)))
      .map((t) => ({
        id: t.id,
        // Name every wheel the way the primary casino does, whichever casino is being
        // viewed - the same table is branded differently per operator ("Roulette
        // Latina" vs "Betsson Spanish Roulette"), and renaming it on a casino switch
        // makes a familiar table unrecognisable. Falls back to the viewed casino's own
        // name for wheels the primary casino does not carry.
        name: (t.namesByOp && t.namesByOp[DEFAULT_OPERATOR])
          || (want && t.namesByOp && t.namesByOp[want])
          || commonName(t) || t.name || t.id,
        namesByOp: t.namesByOp || {},
        operators: t.operators || [],
        operatorLabel: (t.operators || []).map((o) => (ops[o] || {}).label || o).join(' · '),
        variant: t.variant || '',
        dealer: t.dealer || '',
        seated: t.seated ?? null,
        open: t.open !== false,
        results: (t.results || []).map((r) => ({
          n: Number(r.result), color: r.color, time: r.time, gameId: r.gameId,
        })),
        provider: 'pragmatic',
        updatedAt: t.updatedAt,
      }));

    // Playtech wheels, from the reversed protobuf gateway (src/playtech.mjs). The lobby
    // snapshot carries the real table name, dealer and results history; live
    // notifications keep them current.
    if (playtech && (!want || want === DEFAULT_OPERATOR)) {
      for (const t of playtech.roulettes()) {
        if (t.last == null) continue;
        tables.push({
          id: 'pt-' + t.id,
          name: t.name || ('Playtech ' + t.type.toUpperCase() + ' ' + t.id),
          operators: [DEFAULT_OPERATOR],
          operatorLabel: (ops[DEFAULT_OPERATOR] || {}).label || DEFAULT_OPERATOR,
          variant: t.type,
          dealer: t.dealer || '',
          seated: t.players ?? null,
          open: true,
          provider: 'playtech',
          // sid is a per-table sequence the feed assigns to every spin it records, so
          // the pattern tracker can diff by id instead of matching values - which is
          // what lets a back-to-back repeat count as two spins.
          results: (t.history || []).map((h) => ({
            n: h.n, color: rouletteColour(h.n), time: null, gameId: 'pt-' + t.id + '-' + h.sid,
          })),
          updatedAt: t.updatedAt,
        });
      }
  }
  return tables;
}

// ------------------------------------------------------------------- patterns ----
// PATTERNS.md. Both patterns are advanced from the same loop, over the same spins, in
// the same order (§8.5) - a second history fetch would eventually disagree with itself.
const patterns = new PatternTracker();

function patternTick() {
  for (const t of rouletteTables(null)) {
    // results arrive NEWEST FIRST; the tracker reverses before replaying (§5, §8.1)
    patterns.ingest(t.id, {
      name: t.name, provider: t.provider, dealer: t.dealer,
      operators: t.operators, variant: t.variant, open: t.open,
    }, (t.results || []).map((r) => ({ n: r.n, id: r.gameId ?? null })));
  }
}

function patternRows(want) {
  const out = [];
  for (const t of patterns.all()) {
    if (want && !(t.meta.operators || []).includes(want)) continue;
    const strip = (t.strip || []).slice(0, 24);
    out.push({
      id: t.id,
      name: t.meta.name,
      provider: t.meta.provider,
      dealer: t.meta.dealer,
      operators: t.meta.operators || [],
      variant: t.meta.variant || '',
      open: t.meta.open !== false,
      desynced: t.desynced,
      spins: strip,                       // newest first, for the strip
      p1: projectState(t.p1, t.lastEvent1),
      p2: projectState(t.p2, t.lastEvent2),
      updatedAt: t.updatedAt,
    });
  }
  return out;
}

const projectState = (s, lastEvent) => ({
  count: s.count, phase: s.phase, runGroup: s.runGroup, runLength: s.runLength,
  originGroup: s.originGroup, deepest: s.deepest, resets: s.resets,
  spinsObserved: s.spinsObserved, lastEvent,
});

// Continuation of the request handler (split only to keep the roulette assembly above
// out of the routing table).
async function routeRest(req, res, url) {

  // Pattern tracking (PATTERNS.md). Counts are advanced server-side from the same
  // roulette feed the wall reads, so a browser reload or a closed tab never loses one.
  if (url.pathname === '/api/patterns') {
    return json(res, 200, {
      tables: patternRows(url.searchParams.get('operator')),
      groups: { A: GROUP_A, B: GROUP_B },
      at: Date.now(),
    });
  }

  // Supply a JSESSIONID for one operator, copied from that casino's signed-in
  // browser session. No Chrome is launched. Validated, used, and persisted to the
  // per-user DPAPI store under that operator's own entry.
  if (url.pathname === '/api/session/set' && req.method === 'POST') {
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'bad json' }); }
    const op = body.operator || DEFAULT_OPERATOR;
    if (!operators.has(op)) return json(res, 400, { error: 'unknown operator: ' + op });
    try {
      const p = provider(op);
      await p.setToken(body.jsessionid);
      return json(res, 200, { ok: true, sessions: sessionStates(), max: feeds.capacity() });
    } catch (e) {
      return json(res, 400, { error: e.message, sessions: sessionStates() });
    }
  }

  // Mint a session on demand (stoiximan only - the others have no launch chain wired).
  if (url.pathname === '/api/session/refresh' && req.method === 'POST') {
    let body = {};
    try { body = await readJson(req); } catch {}
    const op = body.operator || DEFAULT_OPERATOR;
    if (!operators.has(op)) return json(res, 400, { error: 'unknown operator: ' + op });
    try {
      const p = provider(op);
      const s = await p.refresh({ force: true }); // user asked; ignore any cooldown
      feeds.setSession(op, s);
      log.info(op + ' session minted on request');
      return json(res, 200, { ok: true, sessions: sessionStates(), max: feeds.capacity() });
    } catch (e) {
      log.error('mint ' + op + ': ' + e.message);
      return json(res, 502, { error: e.message, sessions: sessionStates() });
    }
  }

  // Drop one operator session and everything it was carrying.
  if (url.pathname === '/api/session/remove' && req.method === 'POST') {
    let body = {};
    try { body = await readJson(req); } catch {}
    const op = body.operator;
    if (!sessions.has(op)) return json(res, 400, { error: 'no such session' });
    feeds.stopOperator(op);
    sessions.delete(op);
    catByOp.delete(op);
    rebuildUnion();
    log.info('removed ' + op + ' session; capacity now ' + feeds.capacity());
    scheduleBroadcast();
    return json(res, 200, { ok: true, sessions: sessionStates(), max: feeds.capacity() });
  }

  // Set the blackjack game-page URL an operator re-mints from. Stored in plain
  // config (data/operators.json) - it is a public page URL, not a secret. Once set,
  // that operator can refresh its own token indefinitely from the signed-in profile.
  if (url.pathname === '/api/session/config' && req.method === 'POST') {
    let body = {};
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'bad json' }); }
    const op = body.operator;
    if (!operators.has(op)) return json(res, 400, { error: 'unknown operator: ' + op });
    try {
      const href = operators.setGameUrl(op, body.gameUrl);
      // teach a provider that already exists about the new URL
      const p = sessions.get(op);
      if (p) { p.gameUrl = href; p.lastError = null; }
      log.info('set ' + op + ' game page for auto-refresh');
      scheduleBroadcast();
      return json(res, 200, { ok: true, operators: operators.all(), sessions: sessionStates() });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // Pin or unpin one table's live card feed. The wall shows every table; this
  // controls which of them stream real cards. A pin is routed to an operator whose
  // catalogue carries the table and whose own 6 slots are not full.
  if (url.pathname === '/api/live/toggle' && req.method === 'POST') {
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'bad json' }); }
    const { id, on } = body;
    const meta = catalogue.find((t) => t.id === id);
    if (!id || !meta) return json(res, 400, { error: 'unknown table' });

    try {
      if (on) {
        if (meta.game !== 'blackjack') return json(res, 400, { error: 'not a blackjack table' });
        if (!meta.open) return json(res, 400, { error: 'table is closed' });
        if (!sessions.size) return json(res, 409, { error: 'no session — add an operator login first' });

        // candidates: sessions that both offer this table and have a free slot
        const offering = (meta.operators || []).filter((op) => feeds.has(op));
        const chosen = body.operator && offering.includes(body.operator) && feeds.free(body.operator) > 0
          ? body.operator
          : feeds.pick(offering);

        if (!chosen) {
          const full = offering.length > 0;
          return json(res, 409, {
            error: full
              ? 'every session carrying this table is at its ' + MAX_CONCURRENT +
                '-table limit — unpin one, or add another operator login'
              : 'no signed-in session carries this table',
          });
        }
        const got = feeds.addTable(chosen, id);
        if (!got) return json(res, 409, { error: 'could not place the table on a session' });
        log.info('assigned table ' + id + ' (' + meta.name + ') to ' + got + '; ' +
          feeds.liveCount() + '/' + feeds.capacity() + ' live');
      } else {
        const was = feeds.removeTable(id);
        if (was) log.info('released table ' + id + ' from ' + was + '; ' +
          feeds.liveCount() + '/' + feeds.capacity() + ' live');
      }
      scheduleBroadcast();
      return json(res, 200, {
        ok: true, live: feeds.snapshot(), sessions: sessionStates(), max: feeds.capacity(),
      });
    } catch (e) {
      log.error('toggle ' + id + ': ' + e.message);
      return json(res, 502, { error: e.message });
    }
  }

  // Unpin everything, keeping the sessions themselves.
  if (url.pathname === '/api/live/clear' && req.method === 'POST') {
    feeds.clear();
    scheduleBroadcast();
    return json(res, 200, { ok: true });
  }

  // Auto-fill every session's free slots with the most promising open blackjack
  // tables, ranked by the DGA radar (§6k): tables that are actually dealing (players
  // seated) build a count fastest, with onFireSeatCount as a tiebreak. This is the
  // radar-picks-the-six workflow - metadata chooses, the six card sockets count.
  if (url.pathname === '/api/live/auto' && req.method === 'POST') {
    let body = {};
    try { body = await readJson(req); } catch {}

    // First, revive every operator that can be revived (reuse a live token, or mint a
    // fresh one where a launch chain / game page is configured), so one click both
    // refreshes dead sessions and fills to capacity. Operators that need a hand-pasted
    // token cannot be revived unattended and are reported back for the user to fix.
    const revive = body.revive !== false;
    if (revive && sessions.size) {
      await Promise.all([...sessions.keys()].map((op) => reviveSession(op)));
    }
    // Every known operator that still has no live session after the revive pass - these
    // are the accounts blocking full capacity; the user must paste a token or configure
    // a game page for each (auto-mint can't reach them unattended).
    const needLogin = Object.keys(operators.all()).filter((op) => !feeds.has(op));

    if (!feeds.operators().length) {
      return json(res, 409, {
        error: 'no live session — sign in to an operator, or paste a token',
        needLogin,
      });
    }
    if (body.replace) feeds.clear();

    // rank: known-active first (seated desc), then onFire, then any open table
    const occ = (id) => dgaState.get(id);
    const score = (id) => {
      const o = occ(id);
      if (!o) return 0;                          // unknown occupancy - still pinnable, low
      if (o.open === false) return -1;
      return (o.seated || 0) * 10 + (o.onFire || 0) * 3 + Math.min(9, o.players || 0);
    };

    const pinned = [];
    const exhausted = new Set(); // operators with free slots but nothing left to offer
    // Fill the emptiest sessions first so pins spread across accounts. Each pass places
    // one table on the emptiest operator that still has a candidate; stop when no
    // operator can place anything more.
    for (let guard = 0; guard < 200; guard++) {
      const open = feeds.operators().filter((o) => feeds.free(o) > 0 && !exhausted.has(o));
      const op = feeds.pick(open);
      if (!op) break;
      const taken = new Set(feeds.snapshot().map((r) => r.id));
      const best = catalogue
        .filter((t) => t.game === 'blackjack' && t.open && (t.operators || []).includes(op) && !taken.has(t.id))
        .sort((a, b) => score(b.id) - score(a.id) || a.name.localeCompare(b.name))[0];
      if (!best) { exhausted.add(op); continue; }   // this account has no more tables to offer
      if (feeds.addTable(op, best.id)) pinned.push({ id: best.id, name: best.name, operator: op });
      else exhausted.add(op);
    }
    if (pinned.length) log.info('auto-pick placed ' + pinned.length + ' tables: ' +
      pinned.map((p) => p.name + '(' + p.operator + ')').join(', '));
    scheduleBroadcast();
    return json(res, 200, {
      ok: true, pinned, needLogin,
      live: feeds.snapshot(), sessions: sessionStates(), max: feeds.capacity(),
    });
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    res.write('data: ' + JSON.stringify({
      live: feeds.snapshot(),
      sessions: sessionStates(),
      dga: dgaCompact(),
      max: feeds.capacity(),
      catalogueAt,
    }) + '\n\n');
    req.on('close', () => clients.delete(res));
    return;
  }

  res.writeHead(404).end('not found');
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('port ' + PORT + ' is in use - try  PORT=3002 npm run dev');
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, async () => {
  console.log('\n  Blackjack monitor  ->  http://localhost:' + PORT + '\n');
  if (HOST === '0.0.0.0') {
    console.log('  bound to every interface, and this server has no auth -');
    console.log('  set HOST=127.0.0.1 and front it with a password-protected proxy.');
  }
  console.log('  ' + catalogue.length + ' tables in the catalogue');
  console.log('  read-only; ' + MAX_CONCURRENT + ' concurrent tables per operator account');
  console.log('  logging to ' + log.path + (RECORD_DIR ? '; recording to ' + RECORD_DIR : '') + '\n');
  log.info('server started on :' + PORT);

  // Restore every operator session persisted from a previous run, so a restart comes
  // back with all accounts live. Env JSESSIONID still seeds the default operator.
  for (const op of Object.keys(operators.all())) {
    try {
      if (op === DEFAULT_OPERATOR && process.env.JSESSIONID) {
        await provider(op).setToken(process.env.JSESSIONID);
      } else {
        const p = provider(op);
        // No stored token? Keep the operator registered only if it can provision
        // itself (signed-in profile + a known game page); the watchdog will mint it
        // shortly. Otherwise drop it, so unconfigured casinos do not clutter the UI.
        if (!(await p.init()) && !p.canMint) sessions.delete(op);
      }
    } catch (e) {
      log.error('startup session ' + op + ': ' + e.message);
      if (!sessions.get(op)?.jsessionid) sessions.delete(op);
    }
  }
  log.info('sessions live: ' + (feeds.operators().join(', ') || 'none') +
    '; capacity ' + feeds.capacity() + ' tables');

  await refreshAll();
  setInterval(() => refreshAll().catch(() => {}), 3 * 60 * 1000);
  // Provision any configured-but-tokenless operator right away (off the startup
  // path, so a slow mint never delays the server), then keep every token alive.
  setTimeout(() => checkSessions().catch((e) => log.error('session check: ' + e.message)), 2000);
  setInterval(() => checkSessions().catch((e) => log.error('session check: ' + e.message)), SESSION_CHECK_MS);
  // Flush DGA occupancy to any connected clients on a steady tick (the radar updates
  // silently to avoid a broadcast per seat change).
  setInterval(() => { if (clients.size) broadcast(); }, 2000);
  // Advance both patterns off the shared roulette feed. Poll no faster than tables
  // produce spins (§8.4) - a wheel is one spin per 30-90s, so 3s is already generous.
  // Playtech's lobby only flushes every ~29s, so every second we add is a second of
  // avoidable staleness on top of a delay we cannot control.
  setInterval(() => { try { patternTick(); } catch (e) { log.warn('pattern tick: ' + e.message); } }, 1000);
  scheduleBroadcast();
});
