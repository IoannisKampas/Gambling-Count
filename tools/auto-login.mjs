// Sign the Chrome profile back in to an operator, without a human.
//
//   node tools/auto-login.mjs [operator]      (default: stoiximan)
//
// Credentials come from the DPAPI-encrypted store (src/credentials.mjs) - never from
// argv, and never logged. The password is typed into the page through CDP, the same way
// a person would; it is not posted to any endpoint by this script.
//
// This is best-effort by nature. The operator sits behind Cloudflare/DataDome
// (FINDINGS.md §6h), so a CAPTCHA, a device check or 2FA can stop it - in which case it
// reports `needs-human` and you sign in once with `npm run login -- <operator>`.
//
// Exit codes: 0 signed in (or already were), 2 needs a human, 1 error.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as operators from '../src/operators.mjs';
import { getCredentials } from '../src/credentials.mjs';
import { requireChrome, platformArgs, displayProblem } from '../src/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.chrome-profile');
const PORT = Number(process.env.CDP_PORT || 9222);
const OP = (process.argv[2] || 'stoiximan').toLowerCase();
const VERBOSE = !process.argv.includes('--quiet');
const say = (m) => VERBOSE && console.error(m);

const cfg = operators.get(OP);
if (!cfg) { console.error('unknown operator: ' + OP); process.exit(1); }

const creds = await getCredentials(OP);
if (!creds) {
  console.error('no stored credentials for ' + OP + ' — run:  npm run creds');
  process.exit(2);
}

let CHROME;
try { CHROME = requireChrome(); } catch (e) { console.error(e.message); process.exit(1); }
const displayIssue = displayProblem();
if (displayIssue) { console.error(displayIssue); process.exit(1); }

// ------------------------------------------------------------------ browser ----
async function cdpVersion() {
  try { return await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch { return null; }
}
let ver = await cdpVersion();
let spawned = null;
if (!ver) {
  say('launching the profile off-screen');
  spawned = spawn(CHROME, [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', ...platformArgs(),
    '--window-position=-32000,-32000', '--window-size=1280,900',
    'about:blank',
  ], { detached: false, stdio: 'ignore' });
  for (let i = 0; i < 60 && !ver; i++) { await new Promise((r) => setTimeout(r, 500)); ver = await cdpVersion(); }
  if (!ver) { try { spawned.kill(); } catch {} console.error('Chrome never exposed CDP'); process.exit(1); }
}

const ws = new WebSocket(ver.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let id = 1; const pend = new Map();
ws.on('message', (m) => {
  let o; try { o = JSON.parse(m.toString()); } catch { return; }
  if (o.id && pend.has(o.id)) {
    const p = pend.get(o.id); pend.delete(o.id);
    o.error ? p.j(new Error(o.error.message)) : p.r(o.result);
  }
});
const cmd = (method, params = {}, sessionId) => new Promise((r, j) => {
  const i = id++; pend.set(i, { r, j });
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); j(new Error(method + ' timed out')); } }, 45000);
});

const { targetId } = await cmd('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cmd('Target.attachToTarget', { targetId, flatten: true });
await cmd('Page.enable', {}, sessionId);
await cmd('Runtime.enable', {}, sessionId);

// A page mid-navigation makes evaluate hang or throw; that is expected right after a
// login submit, so callers treat a failure as "not yet" rather than an error.
const evaluate = async (expression, awaitPromise = true) => {
  try {
    const r = await cmd('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
    return r && r.result ? r.result.value : null;
  } catch { return null; }
};
const goto = async (url, waitMs = 3500) => {
  try { await cmd('Page.navigate', { url }, sessionId); } catch {}
  await new Promise((r) => setTimeout(r, waitMs));
};

async function finish(code, msg) {
  say(msg);
  try { await cmd('Target.closeTarget', { targetId }); } catch {}
  if (spawned) {
    try { await cmd('Browser.close'); } catch {}          // releases the profile lock
    await new Promise((r) => setTimeout(r, 900));
    try { spawned.kill(); } catch {}
  }
  try { ws.close(); } catch {}
  console.log(code === 0 ? 'signed-in' : code === 2 ? 'needs-human' : 'error');
  process.exit(code);
}

// Definitive signed-in test for stoiximan: the launch endpoint only returns a URL for a
// logged-in player (FINDINGS §3). Falls back to a DOM check for other operators.
// `navigate` is only needed for the very first check, when the tab is still on
// about:blank. After submitting we are already on the operator's origin, and navigating
// again just races the probe against a half-loaded page - which is what made this report
// "sign-in did not take" even though the login had succeeded.
async function isSignedIn({ navigate = false } = {}) {
  if (navigate) await goto(cfg.origin + '/casino/live/', 3500);
  if (cfg.mint === 'launchApi' && cfg.gameId) {
    const probe = "(async()=>{try{" +
      "const r=await fetch('/casino/games/launch/live?gameId=" + cfg.gameId + "'," +
      "{credentials:'include',headers:{'X-Requested-With':'json','Accept':'application/json'}});" +
      "if(!(r.headers.get('content-type')||'').includes('json'))return 'no';" +
      "const j=await r.json();return (j.game&&j.game.url)?'yes':'no';" +
      "}catch(e){return 'no'}})()";
    return (await evaluate(probe)) === 'yes';
  }
  const dom = "(()=>{const t=document.body?document.body.innerText:'';" +
    "return /log ?out|αποσύνδεση|my account|ο λογαριασμός/i.test(t)?'yes':'no';})()";
  return (await evaluate(dom, false)) === 'yes';
}

if (await isSignedIn({ navigate: true })) await finish(0, 'already signed in');

// ---------------------------------------------------------------- sign in ------
say('signing in to ' + cfg.label + '…');
// /login renders the real form inside a same-origin iframe (/myaccount/login), so the
// password field is not in the top document. Loading that iframe URL directly hangs,
// hence: open /login and reach into the frame via contentDocument.
await goto(cfg.origin + '/login', 7000);

const fill = `(() => {
  const vis = (e) => e && e.offsetParent !== null;
  // the form lives in a same-origin iframe, so search every document we can touch
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch {}
  }
  let doc = null, pw = null;
  for (const d of docs) {
    const p = [...d.querySelectorAll('input[type=password]')].find(vis);
    if (p) { doc = d; pw = p; break; }
  }
  if (!pw) return 'no-form';
  const inputs = [...doc.querySelectorAll('input')].filter(vis);
  const user = inputs.slice(0, inputs.indexOf(pw)).reverse()
    .find((e) => /text|email|tel/i.test(e.type) || !e.type);
  if (!user) return 'no-user-field';
  const set = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // blur matters: the form validates on it, and that is what enables the submit button
  user.focus(); set(user, ${JSON.stringify(creds.username)});
  user.dispatchEvent(new Event('blur', { bubbles: true }));
  pw.focus();   set(pw,   ${JSON.stringify(creds.password)});
  pw.dispatchEvent(new Event('blur', { bubbles: true }));
  return 'filled';
})()`;

// Clicking is a SEPARATE step. The submit button is disabled until the form revalidates
// after the input events, and clicking a disabled button is a silent no-op that looks
// like a successful submit - which is exactly why this used to report success and never
// sign in. So: fill, let the framework re-render, then click only once it is enabled.
const clickSubmit = `(() => {
  const vis = (e) => e && e.offsetParent !== null;
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch (x) {}
  }
  for (const d of docs) {
    const pw = [...d.querySelectorAll('input[type=password]')].find(vis);
    if (!pw) continue;
    const form = pw.closest('form');
    const btn = form
      ? [...form.querySelectorAll('button,input[type=submit]')].filter(vis).pop()
      : [...d.querySelectorAll('button')].filter(vis)
          .find((b) => /login|sign ?in|σύνδεση|συνδεση/i.test(b.innerText || ''));
    if (btn) {
      if (btn.disabled) return 'disabled';
      btn.click();
      return 'clicked';
    }
    if (form) { form.submit(); return 'submitted-form'; }
  }
  return 'no-submit';
})()`;

const outcome = await evaluate(fill, false);
say('  form: ' + outcome);
if (outcome === 'no-form' || outcome === 'no-user-field') {
  await finish(2, 'could not find the login form (layout changed, or a device check is in the way)');
}

// Give the form time to revalidate and enable its button, retrying a few times.
let clicked = null;
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 700));
  clicked = await evaluate(clickSubmit, false);
  if (clicked !== 'disabled') break;
}
say('  submit: ' + clicked);
if (clicked === 'disabled') {
  await finish(2, 'the sign-in button stayed disabled (the form rejected the credentials before submitting)');
}
if (clicked === 'no-submit') await finish(2, 'could not find the sign-in button');

// Submitting kicks off a navigation, so the session takes a few seconds to settle and
// evaluate may fail meanwhile. Poll rather than judging on one early look.
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  if (await isSignedIn()) await finish(0, 'signed in' + (i ? ' (after ' + (i + 1) + ' checks)' : ''));
}

// Still not in: say which of the two likely reasons it is.
const challenged = await evaluate(
  "(()=>{const docs=[document];" +
  "for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument);}catch{}}" +
  "const t=docs.map(d=>d.body?d.body.innerText:'').join(' ');" +
  "const f=[...document.querySelectorAll('iframe')].map(i=>i.src||'').join(' ');" +
  "return /captcha|recaptcha|hcaptcha|datadome|verify you|are you human|επαλήθευ|one-time|otp/i" +
  ".test(t+' '+f)?'yes':'no';})()", false);
if (challenged === 'yes') await finish(2, 'a CAPTCHA / verification step is blocking automated sign-in');
await finish(2, 'sign-in did not take (wrong credentials, or an extra step is required)');
