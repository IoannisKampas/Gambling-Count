// Automatic JSESSIONID acquisition.
//
// The session is minted by the operator's game-launch chain (FINDINGS.md §3):
//
//   /casino/games/launch/live?gameId=<id>   -> JWT launch URL
//     -> gaming-launch-gr.betano.com/Game/Launch/<JWT>
//       -> …/gs2c/playGame.do?…token=<ppToken>
//         -> games.pragmaticplaylive.net/api/secure/GameLaunch2 -> JSESSIONID
//
// That chain sits behind Cloudflare and DataDome, so it is driven in a real
// browser using the logged-in profile rather than replayed with fetch. We attach
// to a Chrome already running with the profile, or launch one, run the chain in a
// throwaway tab, read the JSESSIONID off the network traffic, and close the tab.
//
// Read-only: it launches a game the way opening the page does, and takes nothing
// but the session token.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { saveSecret, loadSecret } from './secret-store.mjs';
import { requireChrome, platformArgs, displayProblem, killTree, stderrTail } from './chrome.mjs';

// base name of the DPAPI-encrypted token in the per-user secret store. Each operator
// gets its own entry so three logins can be persisted side by side; the historical
// stoiximan token keeps the bare name for backward compatibility.
const SECRET_BASE = 'pragmatic-session';
const secretNameFor = (id) => (id === 'stoiximan' || id === 'default' ? SECRET_BASE : SECRET_BASE + '-' + id);
// short prefix only, for logs - never the whole token
const mask = (t) => (t ? t.slice(0, 6) + '…(' + t.length + ')' : 'none');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.chrome-profile');
const PORT = Number(process.env.CDP_PORT || 9222);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// how long to leave an operator alone after a failed mint
const MINT_COOLDOWN_MS = Number(process.env.MINT_COOLDOWN_MS || 15 * 60 * 1000);

async function endpoint() {
  const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
  return (await r.json()).webSocketDebuggerUrl;
}

async function endpointReady(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { return await endpoint(); } catch {}
    await sleep(500);
  }
  return null;
}

// Minimal flat-session CDP client.
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.ready = new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ws.on('message', (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        return m.error ? p.reject(new Error(p.method + ': ' + m.error.message + (m.error.data ? ' - ' + m.error.data : ''))) : p.resolve(m.result);
      }
      for (const h of this.handlers) h(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  close() { try { this.ws.close(); } catch {} }
}

export class SessionProvider {
  // id       - operator key ('stoiximan', 'winmasters', 'betsson', …); names the secret entry
  // label    - display name for the UI
  // origin   - operator site origin
  // mint     - 'launchApi' (call the operator's own launch endpoint, traced for
  //            stoiximan in FINDINGS.md §3) or 'gamePage' (just open the operator's
  //            normal game page and read the token off the traffic it generates).
  //            'gamePage' needs no per-operator reverse engineering, only a gameUrl.
  // gameId   - a live-blackjack gameId on that operator, for 'launchApi'
  // gameUrl  - direct URL of a Pragmatic blackjack table page, for 'gamePage'
  constructor({ id = 'stoiximan', label, origin, mint = 'launchApi', gameId, gameUrl, onChange, logger } = {}) {
    this.id = id;
    this.label = label || id;
    this.secretName = secretNameFor(id);
    this.origin = origin || process.env.OPERATOR_ORIGIN || 'https://www.stoiximan.gr';
    this.lobby = this.origin + '/casino/live/';
    this.mint = mint;
    this.gameId = gameId || process.env.OPERATOR_GAME_ID || '35927';
    this.gameUrl = gameUrl || null;
    this.jsessionid = null;
    this.acquiredAt = 0;
    this.restored = false; // true if the current token came from the secret store
    this.supplied = false; // true if the current token was supplied from outside
    this.onChange = onChange || (() => {});
    this.log = logger || (() => {});
    this.inflight = null;
    this.chrome = null;
    this.lastError = null;
    // After a failed mint, wait before trying again. A signed-out casino would
    // otherwise relaunch Chrome on every watchdog tick and fail slowly each time.
    this.cooldownUntil = 0;
  }

  // Auto-minting works when the operator has a launch path we can drive inside the
  // signed-in profile: either its traced launch API, or any game page URL.
  get canMint() {
    if (process.env.SESSION_AUTO_MINT === '0') return false;
    return this.mint === 'launchApi' ? !!this.gameId : !!this.gameUrl;
  }

  status() {
    return {
      operator: this.id,
      label: this.label,
      canMint: this.canMint,
      hasSession: !!this.jsessionid,
      acquiredAt: this.acquiredAt || null,
      ageSeconds: this.acquiredAt ? Math.round((Date.now() - this.acquiredAt) / 1000) : null,
      restored: this.restored,
      supplied: this.supplied,
      autoMint: this.canMint && process.env.SESSION_AUTO_MINT !== '0',
      refreshing: !!this.inflight,
      error: this.lastError,
      retryInSeconds: this.cooldownUntil > Date.now()
        ? Math.round((this.cooldownUntil - Date.now()) / 1000) : null,
    };
  }

  // Is this token still accepted by the provider? A cheap authenticated REST call
  // stands in for opening a game socket. Never logs the token itself.
  async validate(token) {
    if (!token) return false;
    try {
      const r = await fetch(
        'https://games.pragmaticplaylive.net/api/wallet/balance?JSESSIONID=' + encodeURIComponent(token),
        { headers: { Origin: 'https://client.pragmaticplaylive.net', Referer: 'https://client.pragmaticplaylive.net/' } },
      );
      if (!r.ok) return false;
      const body = await r.text();
      let j;
      try { j = JSON.parse(body); } catch { return false; }
      // a dead token comes back as an error envelope, not a balance
      return !(j.errorCode && String(j.errorCode) !== '0') && !/logout|not.*login|unauth/i.test(body);
    } catch {
      return false;
    }
  }

  // On startup: load the DPAPI-stored token and reuse it if still valid, so a
  // restart does not need a fresh launch. Returns true if a valid token was restored.
  async init() {
    const stored = await loadSecret(this.secretName);
    if (!stored) { this.log('no stored session'); return false; }
    if (await this.validate(stored)) {
      this.jsessionid = stored;
      this.acquiredAt = Date.now(); // true mint time is unknown; treat as fresh
      this.restored = true;
      this.lastError = null;
      this.log('restored stored session ' + mask(stored));
      this.onChange(stored);
      return true;
    }
    this.log('stored session expired, will re-mint on demand');
    return false;
  }

  // Use a token supplied from outside (env var, API, a session copied from a real
  // browser). No Chrome is launched. Validated first so a bad paste is rejected
  // rather than silently failing every socket.
  async setToken(token, { persist = true } = {}) {
    token = (token || '').trim();
    if (!token) throw new Error('empty token');
    if (!(await this.validate(token))) throw new Error('supplied session is not valid (expired or wrong casino)');
    this.jsessionid = token;
    this.acquiredAt = Date.now();
    this.restored = false;
    this.supplied = true;
    this.lastError = null;
    if (persist) { try { await saveSecret(this.secretName, token); } catch (e) { this.log('could not persist: ' + e.message); } }
    this.log('using supplied session ' + mask(token));
    this.onChange(token);
    return token;
  }

  // Coalesce concurrent refreshes so a burst of dead sockets mints one session.
  // Is an automatic (unattended) mint worth attempting right now?
  get mintReady() {
    return this.canMint && Date.now() >= this.cooldownUntil;
  }

  // force:true is a user-initiated refresh and ignores the cooldown.
  refresh({ force = false } = {}) {
    // Only stoiximan has the Chrome launch chain wired. For every other operator,
    // and when auto-mint is disabled, an expired session is surfaced for the user to
    // replace by pasting a fresh token rather than launching a browser.
    if (!this.canMint) {
      this.lastError = process.env.SESSION_AUTO_MINT === '0'
        ? 'auto-mint is off — paste a new JSESSIONID for ' + this.label
        : 'set a blackjack game-page URL for ' + this.label + ' to enable auto-refresh';
      this.log(this.lastError);
      return Promise.reject(new Error(this.lastError));
    }
    if (!force && Date.now() < this.cooldownUntil) {
      const mins = Math.ceil((this.cooldownUntil - Date.now()) / 60000);
      return Promise.reject(new Error(
        'last ' + this.label + ' mint failed; retrying in ~' + mins + ' min'));
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.#acquire()
      .then(async (s) => {
        this.jsessionid = s;
        this.acquiredAt = Date.now();
        this.restored = false;
        this.lastError = null;
        this.cooldownUntil = 0;
        try { await saveSecret(this.secretName, s); } catch (e) { this.log('could not persist session: ' + e.message); }
        this.log('minted new session ' + mask(s));
        this.onChange(s);
        return s;
      })
      .catch((e) => {
        this.lastError = e.message;
        this.cooldownUntil = Date.now() + MINT_COOLDOWN_MS;
        throw e;
      })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async get() {
    if (this.jsessionid) return this.jsessionid;
    if (await this.init()) return this.jsessionid; // reuse a persisted token first
    return this.refresh();
  }

  async #browser() {
    const existing = await endpointReady(0).catch(() => null);
    if (existing) return existing;

    const bin = requireChrome();
    // No visible window by default: a real Chrome window parked far off-screen.
    // This is invisible to the user AND passes the operator's bot detection. On a
    // headless host that window still needs an X server to be parked on - Xvfb is
    // enough, and off-screen coordinates are meaningless there but harmless.
    //
    // True process-headless (--headless=new) is DETECTED and BLOCKED here: the
    // Stoiximan launch chain returns HTTP 403 to a headless browser. Opt in with
    // SESSION_HEADLESS=1 only on a display-less host where you accept it will fail
    // until/unless the operator stops blocking headless.
    const headless = process.env.SESSION_HEADLESS === '1';
    if (!headless) {
      const problem = displayProblem();
      if (problem) throw new Error(problem);
    }
    this.chrome = spawn(bin, [
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + PROFILE,
      '--no-first-run',
      '--no-default-browser-check',
      ...platformArgs(),
      ...(headless
        ? ['--headless=new', '--disable-gpu']
        : ['--window-position=-32000,-32000']),
      'about:blank',
    ], {
      // stderr kept so a failed launch can report Chrome's own reason
      stdio: ['ignore', 'ignore', 'pipe'],
      // own process group, so #stopBrowser can take the whole tree down with it
      detached: process.platform !== 'win32',
    });
    const why = stderrTail(this.chrome);

    const url = await endpointReady(30000);
    if (!url) throw new Error('Chrome did not expose a CDP endpoint' + why());
    return url;
  }

  // Shut down a Chrome WE launched once the mint is done, so no browser is left
  // running between refreshes. A Chrome that was already up (the user's own, or one
  // started by `npm run login`) is left alone - we only attached to it.
  #stopBrowser() {
    const child = this.chrome;
    if (!child) return;
    this.chrome = null;
    // Chrome spawns a process tree; killing the launcher alone orphans the rest.
    killTree(child);
  }

  async #acquire() {
    const cdp = new Cdp(await this.#browser());
    await cdp.ready;
    let targetId = null;
    try {
      ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

      // watch every frame, including the provider's cross-origin game iframe
      const sessions = new Set([sessionId]);
      let found = null;
      const off = cdp.on((m) => {
        if (m.method === 'Target.attachedToTarget') {
          const sid = m.params.sessionId;
          sessions.add(sid);
          cdp.send('Network.enable', {}, sid).catch(() => {});
          cdp.send('Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => {});
          cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
        }
        if (!found && (m.method === 'Network.requestWillBeSent' || m.method === 'Network.responseReceived')) {
          const url = m.params.request ? m.params.request.url : m.params.response.url;
          const hit = /[?&]JSESSIONID=([^&"'\s]+)/.exec(url || '');
          if (hit) found = decodeURIComponent(hit[1]);
        }
      });

      await cdp.send('Network.enable', {}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);

      // Drive whichever launch path this operator uses. Either way the token is read
      // off the traffic the operator's own client generates. Nothing is typed, no
      // login form is submitted and no bot check is bypassed: the profile is already
      // signed in because a human signed in once, and this only re-opens a game the
      // same way clicking it in the lobby does.
      if (this.mint === 'gamePage') await this.#launchGamePage(cdp, sessionId);
      else await this.#launchViaApi(cdp, sessionId);

      const until = Date.now() + 45000;
      while (!found && Date.now() < until) await sleep(250);
      off();
      if (!found) {
        // Two different causes for a gamePage mint, and guessing wrong wastes time:
        // either nothing is signed in, or the configured URL loads no game.
        throw new Error(this.mint === 'gamePage'
          ? 'no JSESSIONID appeared — either the profile is signed out of ' + this.label +
            ' (run:  npm run login -- ' + this.id + '), or ' + this.gameUrl +
            ' is not a page that opens a Pragmatic table'
          : 'no JSESSIONID appeared — the profile is probably signed out of ' +
            this.label + '. Run:  npm run login -- ' + this.id);
      }
      return found;
    } finally {
      if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      cdp.close();
      this.#stopBrowser(); // leave no browser running between refreshes
    }
  }

  // Generic path: open the operator's own blackjack game page. Works on any casino
  // without reverse-engineering its launch API - the page loads the Pragmatic client,
  // which is handed a JSESSIONID, and the watcher picks it up.
  async #launchGamePage(cdp, sessionId) {
    if (!this.gameUrl) throw new Error('no game-page URL configured for ' + this.label);
    await this.#navigate(cdp, sessionId, this.gameUrl, 45000);
  }

  // Stoiximan/Betano path: ask the operator for a launch URL exactly as the site
  // does, then follow it. The chain ends at GameLaunch2, which mints the session.
  async #launchViaApi(cdp, sessionId) {
    // get on the operator origin so the session cookies apply. Wait for the real
    // load event: about:blank already reports readyState "complete", so polling
    // readyState returns before the navigation lands.
    await this.#navigate(cdp, sessionId, this.lobby);

    // Returns a diagnostic envelope so a login redirect or a bot-check page is
    // reported as itself rather than surfacing as a JSON parse error.
    const probe =
        "(async()=>{try{" +
        // X-Requested-With: json is required - without it the operator serves the
        // HTML page instead of the launch JSON
        "const r=await fetch('/casino/games/launch/live?gameId=" + this.gameId + "'," +
        "{credentials:'include',headers:{'X-Requested-With':'json','Accept':'application/json'}});" +
        "const ct=r.headers.get('content-type')||'';const body=await r.text();" +
        "if(!ct.includes('json'))return JSON.stringify({ok:false,status:r.status,ct:ct,snippet:body.slice(0,160)});" +
        "const j=JSON.parse(body);" +
        // carry a snippet back when there is no url, so a signed-out response is
        // reported as itself instead of a bare "no launch URL"
        "return JSON.stringify({ok:true,url:(j.game&&j.game.url)||null," +
        "loggedIn:!!(j.loggedIn||j.isLoggedIn||j.user),snippet:body.slice(0,200)});" +
        "}catch(e){return JSON.stringify({ok:false,error:String(e)})}})()";

    const res = await cdp.send('Runtime.evaluate', {
      expression: probe, awaitPromise: true, returnByValue: true,
    }, sessionId);

    let info = {};
    try { info = JSON.parse(res.result.value); } catch {}

    // an exception makes result.value an object; only a real string is a URL
    if (!info.ok || typeof info.url !== 'string' || !info.url) {
      const why = info.error ? info.error
        : info.status ? 'HTTP ' + info.status + ' (' + info.ct + ') ' + (info.snippet || '').replace(/\s+/g, ' ')
        : 'the operator returned no launch URL — the profile is signed out of ' +
          this.label + '. Run:  npm run login -- ' + this.id +
          (info.snippet ? '  [' + info.snippet.replace(/\s+/g, ' ').slice(0, 120) + ']' : '');
      throw new Error('game launch failed - ' + why);
    }
    await cdp.send('Page.navigate', { url: info.url }, sessionId);
  }

  // Navigate and wait for the page's own load event, not for readyState.
  async #navigate(cdp, sessionId, url, ms = 30000) {
    let done = false;
    const off = cdp.on((m) => {
      if (m.sessionId === sessionId &&
          (m.method === 'Page.loadEventFired' || m.method === 'Page.frameStoppedLoading')) {
        done = true;
      }
    });
    try {
      await cdp.send('Page.navigate', { url }, sessionId);
      const until = Date.now() + ms;
      while (!done && Date.now() < until) await sleep(200);
      await sleep(600); // let the SPA's own boot requests settle
    } finally {
      off();
    }
  }
}
