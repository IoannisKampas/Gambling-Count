// Opens the monitor's Chrome profile so you can sign in once, per casino.
//
//   npm run login                 -> stoiximan
//   npm run login -- winmasters
//   npm run login -- betsson
//
// Sign in by hand in the window that opens, then close it. The session cookie stays
// in this profile, and from then on the app mints its own JSESSIONID from it
// whenever the old one expires - no password is stored and no login form is ever
// submitted by the app.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as operators from '../src/operators.mjs';
import { requireChrome, platformArgs, displayProblem, proxySummary, stderrTail } from '../src/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.chrome-profile');
const PORT = Number(process.env.CDP_PORT || 9222);

const id = (process.argv[2] || 'stoiximan').toLowerCase();
const cfg = operators.get(id);
if (!cfg) {
  console.error('unknown operator: ' + id);
  console.error('known: ' + Object.keys(operators.all()).join(', '));
  process.exit(1);
}

let bin;
try { bin = requireChrome(); } catch (e) { console.error(e.message); process.exit(1); }
const displayIssue = displayProblem();
if (displayIssue) { console.error(displayIssue); process.exit(1); }

// land on the game page if one is configured, otherwise the live-casino lobby
const target = cfg.gameUrl || cfg.origin + '/casino/live/';

console.log('\n  ' + cfg.label + ' — sign in in the window that opens, then close it.');
console.log('  profile: ' + PROFILE);
if (cfg.mint === 'gamePage' && !cfg.gameUrl) {
  console.log('\n  Then open any Pragmatic blackjack table and copy its page URL into');
  console.log('  the app (+ Session -> ' + cfg.label + ') so it can auto-refresh.');
}
console.log('');

// Chrome refuses a second instance on the same user-data-dir: it hands the URL to the
// instance already running and exits at once, which from here looks exactly like
// "Chrome never opened". The instance already running is usually the server's own mint
// window, parked off-screen where nothing becomes visible. Say so instead.
const running = await fetch('http://127.0.0.1:' + PORT + '/json/version')
  .then((r) => r.json()).catch(() => null);
if (running) {
  console.error('  a Chrome is already using this profile (' + (running.Browser || 'unknown') + '),');
  console.error('  so this window would be handed to it and nothing would appear.');
  console.error('  Stop it first, then run this again:');
  console.error('    pkill -f "node server.mjs"            # or Ctrl+C in its window');
  console.error('    pkill -f "user-data-dir=' + PROFILE + '"');
  process.exit(1);
}

const child = spawn(bin, [
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  '--no-first-run',
  '--no-default-browser-check',
  ...platformArgs(),
  target,
], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });

// Chrome's own reason for dying, kept so an immediate exit is not silent.
const why = stderrTail(child);
let exited = null;
child.on('exit', (code, signal) => { exited = signal || 'code ' + code; });

await new Promise((r) => setTimeout(r, 3000));

if (exited !== null) {
  console.error('  Chrome did not stay open' + why());
  console.error('');
  console.error('  Usual causes: an orphaned Chrome still holds this profile, the profile');
  console.error('  lock was left behind by a crash, or the display is not reachable.');
  console.error('    pgrep -af "user-data-dir=' + PROFILE + '"');
  console.error('    rm -f "' + PROFILE + '/SingletonLock"');
  console.error('    echo $DISPLAY   # and:  ls /tmp/.X11-unix/');
  process.exit(1);
}

// With SESSION_PROXY the browser's route out runs inside this process, so stay up
// until the window is closed; otherwise hand the shell straight back.
if (proxySummary()) {
  console.log('  via proxy ' + proxySummary() + ' - leave this running until you close the window.\n');
  child.on('exit', () => process.exit(0));
} else {
  child.stderr.destroy();
  child.unref();
}
