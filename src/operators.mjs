// Operator registry: which casinos the wall can hold a session on, and how each one
// mints a Pragmatic JSESSIONID.
//
// Every operator needs its own authorized login (the user's own account), and each
// then gets its own independent 6-table cap. Two mint strategies:
//
//   launchApi - call the operator's own game-launch endpoint, as traced for
//               stoiximan in FINDINGS.md §3. No extra configuration needed.
//   gamePage  - just open one of the operator's normal blackjack game pages in the
//               signed-in profile and read the token off the traffic it generates.
//               Works on any casino without reverse-engineering it; needs only the
//               URL of a blackjack table page, set once by the user.
//
// Neither strategy submits a login form or stores a password. Signing in happens
// once, by hand, in the app's Chrome profile (`npm run login -- <operator>`); the
// cookie persists there and the token is re-minted from it whenever it expires.
//
// gameUrl values live in data/operators.json - a plain config file, not a secret.
// Session tokens themselves never go here; those stay DPAPI-encrypted (secret-store).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'data/operators.json');

const DEFAULTS = {
  stoiximan: {
    label: 'Stoiximá',
    origin: 'https://www.stoiximan.gr',
    mint: 'launchApi',
    gameId: '35927',
    gameUrl: null,
  },
  winmasters: {
    label: 'Winmasters',
    origin: 'https://www.winmasters.gr',
    mint: 'gamePage',
    gameUrl: null, // set once from the UI or data/operators.json
  },
  betsson: {
    label: 'Betsson',
    origin: 'https://www.betsson.gr',
    mint: 'gamePage',
    gameUrl: null,
  },
};

// Per-operator overrides from the environment, e.g. WINMASTERS_GAME_URL.
function fromEnv(id) {
  const key = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const out = {};
  if (process.env[key + '_GAME_URL']) out.gameUrl = process.env[key + '_GAME_URL'];
  if (process.env[key + '_ORIGIN']) out.origin = process.env[key + '_ORIGIN'];
  return out;
}

let saved = {};
try { saved = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}

// defaults <- saved file <- environment
export function all() {
  const out = {};
  for (const id of Object.keys(DEFAULTS)) {
    out[id] = { ...DEFAULTS[id], ...(saved[id] || {}), ...fromEnv(id), id };
  }
  return out;
}

export function get(id) {
  return all()[id] || null;
}

export function has(id) {
  return !!DEFAULTS[id];
}

// Persist a game-page URL so auto-refresh survives restarts. Rejects anything that
// is not an http(s) URL on that operator's own origin, so a stray paste (a wss game
// socket, say) cannot be stored as a navigation target.
export function setGameUrl(id, url) {
  if (!has(id)) throw new Error('unknown operator: ' + id);
  const cfg = get(id);
  let u;
  try { u = new URL(String(url).trim()); } catch { throw new Error('not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('needs an http(s) page URL, not ' + u.protocol);
  const host = u.hostname.replace(/^www\./, '');
  const own = new URL(cfg.origin).hostname.replace(/^www\./, '');
  if (host !== own && !host.endsWith('.' + own)) {
    throw new Error('that URL is on ' + u.hostname + ', not ' + cfg.origin);
  }
  // The homepage loads no game, so no token is ever issued there. Catching it here
  // turns a confusing "signed out?" mint failure into an answerable message.
  if (u.pathname.replace(/\/+$/, '') === '' && !u.search && !u.hash) {
    throw new Error(
      'that is the ' + cfg.label + ' homepage — open an actual Pragmatic blackjack ' +
      'table and copy the URL of that table page');
  }
  saved[id] = { ...(saved[id] || {}), gameUrl: u.href };
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(saved, null, 2));
  return u.href;
}

export const CONFIG_PATH = CONFIG;
