// Where the browser lives, and what it needs to start, on each platform.
//
// The mint chain needs a REAL browser (FINDINGS.md §6h): Cloudflare/DataDome answer
// headless Chrome with a 403, so on a VPS the browser runs headed against a virtual
// X display (Xvfb) rather than with --headless=new. That makes DISPLAY a hard
// dependency on Linux, and a missing one the most common "it works locally" failure,
// so it is checked explicitly and reported rather than left to Chrome's stderr.
//
// Override the binary with CHROME_PATH when it is somewhere unusual.

import { execFile } from 'node:child_process';
import fs from 'node:fs';

const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
};

// The browser binary, or null if none is installed. CHROME_PATH wins when set.
export function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env) return fs.existsSync(env) ? env : null;
  return (CANDIDATES[process.platform] || []).find((p) => fs.existsSync(p)) || null;
}

// Same, but throws with something actionable instead of returning null. Every call
// site used to print "no Chrome found", which on a fresh VPS says nothing useful.
export function requireChrome() {
  const bin = findChrome();
  if (bin) return bin;
  const hint = process.platform === 'linux'
    ? 'install it with:  sudo apt install -y ./google-chrome-stable_current_amd64.deb\n' +
      '  (or point CHROME_PATH at an existing binary)'
    : 'set CHROME_PATH to the chrome.exe you want used';
  throw new Error('no Chrome/Edge found — ' + hint);
}

// Flags the host itself demands, on top of whatever the caller passes.
//
//   --disable-dev-shm-usage : containers and small VPSes ship a 64MB /dev/shm, which
//                             Chrome exhausts and then dies mid-navigation.
//   --no-sandbox            : only when running as root, where the sandbox refuses to
//                             start at all. Prefer a non-root service user instead;
//                             this is a fallback, not a recommendation.
export function platformArgs() {
  if (process.platform !== 'linux') return [];
  const args = ['--disable-dev-shm-usage'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  return args;
}

// Why a headed Chrome will fail to start here, or null if it will be fine. Checked
// before spawning so the failure names the cause instead of timing out on CDP.
export function displayProblem() {
  if (process.platform !== 'linux') return null;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return null;
  return 'no DISPLAY is set, so a headed Chrome cannot start. Run the process under a ' +
    'virtual display:  xvfb-run -a node …  (or start Xvfb :99 and export DISPLAY=:99). ' +
    'SESSION_HEADLESS=1 avoids needing one, but the operator answers headless with 403.';
}

// Kill the browser and everything it spawned. Chrome forks a process tree; killing the
// launcher alone orphans the renderers, which then hold the user-data-dir lock and make
// the next launch fail with "profile appears to be in use".
//
// On POSIX this needs the child to have been spawned with `detached: true` so it leads
// its own process group and the negative-pid kill reaches the whole tree.
export function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill(); } catch {}
  }
}
