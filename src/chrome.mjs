// Where the browser lives, and what it needs to start, on each platform.
//
// The mint chain needs a REAL browser (FINDINGS.md §6h): Cloudflare/DataDome answer
// headless Chrome with a 403, so on a VPS the browser runs headed against a virtual
// X display (Xvfb) rather than with --headless=new. That makes DISPLAY a hard
// dependency on Linux, and a missing one the most common "it works locally" failure,
// so it is checked explicitly and reported rather than left to Chrome's stderr.
//
// Override the binary with CHROME_PATH when it is somewhere unusual.
//
// SESSION_PROXY=http://user:pass@host:port sends the browser's traffic through an
// upstream proxy (a VPS whose own IP the operator refuses). Chrome's --proxy-server
// cannot carry credentials, so a tiny forwarder on 127.0.0.1 adds them. Node's own
// requests (token checks, lobby, table sockets) go to the provider, not the operator,
// and stay on the host's IP.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';

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

const PROXY = parseProxy(process.env.SESSION_PROXY);
// Derived from the proxy setting, so a forwarder still running from an older setting
// (other credentials, or none) sits on a different port and is never reused by mistake.
const PROXY_LOCAL_PORT = Number(process.env.SESSION_PROXY_PORT) ||
  (PROXY ? 20000 + createHash('sha256').update(process.env.SESSION_PROXY).digest().readUInt16BE(0) % 10000 : 0);

function parseProxy(raw) {
  if (!raw) return null;
  const u = new URL(raw.includes('://') ? raw : 'http://' + raw);
  if (u.protocol !== 'http:') throw new Error('SESSION_PROXY must be an http:// proxy');
  const user = decodeURIComponent(u.username);
  return {
    host: u.hostname,
    port: Number(u.port || 80),
    auth: user ? 'Basic ' + Buffer.from(user + ':' + decodeURIComponent(u.password)).toString('base64') : null,
  };
}

// host:port of the upstream proxy, never the credentials; null when none is set.
export function proxySummary() {
  return PROXY ? PROXY.host + ':' + PROXY.port : null;
}

let forwarder = null;
const refusedSeen = new Set();

// Said once per host and status, on stderr (tools print tokens on stdout). The upstream's
// status line and any error headers ride along: providers say why a target is blocked there.
function refused(status, host, head) {
  const key = host + ' ' + status;
  if (refusedSeen.has(key)) return;
  refusedSeen.add(key);
  const detail = String(head || '').split(/\r?\n/)
    .filter((l, i) => i === 0 || /^x-|error|reason|message/i.test(l)).join(' | ').slice(0, 240);
  console.error('[warn] proxy ' + proxySummary() + ' refused ' + host + ' (HTTP ' + status + ')' +
    (status === 407 ? ' - the username/password in SESSION_PROXY is wrong or missing' : '') +
    (detail ? ' [' + detail + ']' : ''));
}

// Make sure this process serves the forwarder, even when it attaches to a Chrome that
// someone else launched: that Chrome still points at the forwarder's port, and would
// show "This site can't be reached" for every page if its original owner has exited.
export function startProxy() {
  ensureForwarder();
}

// Start the credential-adding forwarder once per process. Every Chrome-launching tool
// calls this, and a tool may exit while its browser lives on - so a process that finds
// the port taken keeps retrying, and takes over once the previous owner is gone.
function ensureForwarder() {
  if (!PROXY || forwarder) return;
  const authLine = PROXY.auth ? 'Proxy-Authorization: ' + PROXY.auth + '\r\n' : '';

  const server = http.createServer((req, res) => {
    // plain http: the request line already carries an absolute URL, which the
    // upstream proxy accepts as-is
    const headers = { ...req.headers };
    if (PROXY.auth) headers['proxy-authorization'] = PROXY.auth;
    const up = http.request({ host: PROXY.host, port: PROXY.port, method: req.method, path: req.url, headers },
      (upRes) => {
        if (upRes.statusCode === 407) {
          refused(407, req.url, '');
          upRes.resume();
          res.writeHead(502).end();
          return;
        }
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });

  // https: open the tunnel upstream, read its answer, then splice the sockets. The
  // answer is checked rather than passed through: a 407 reaching Chrome pops a
  // "127.0.0.1 requires a username and password" dialog that nobody is there to answer.
  server.on('connect', (req, client, head) => {
    const up = net.connect(PROXY.port, PROXY.host, () => {
      up.write('CONNECT ' + req.url + ' HTTP/1.1\r\nHost: ' + req.url + '\r\n' + authLine + '\r\n');
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 16384) { up.destroy(); client.destroy(); }
        return;
      }
      up.off('data', onData);
      const status = Number(buf.toString('latin1', 0, end).split(' ')[1]);
      if (status !== 200) {
        refused(status, req.url, buf.toString('latin1', 0, end));
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        up.destroy();
        return;
      }
      client.write(buf);
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    };
    up.on('data', onData);
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });

  server.on('error', (e) => {
    forwarder = null;
    if (e.code === 'EADDRINUSE') setTimeout(ensureForwarder, 2000).unref();
  });
  server.listen(PROXY_LOCAL_PORT, '127.0.0.1');
  server.unref(); // never the reason a tool stays alive
  forwarder = server;
}

// Flags the host itself demands, on top of whatever the caller passes.
//
//   --disable-dev-shm-usage : containers and small VPSes ship a 64MB /dev/shm, which
//                             Chrome exhausts and then dies mid-navigation.
//   --no-sandbox            : only when running as root, where the sandbox refuses to
//                             start at all. Prefer a non-root service user instead;
//                             this is a fallback, not a recommendation.
//   --proxy-server          : only with SESSION_PROXY. WebRTC is held to the proxy too,
//                             or it would reveal the host's own IP around it.
export function platformArgs() {
  const args = [];
  if (PROXY) {
    ensureForwarder();
    args.push('--proxy-server=http://127.0.0.1:' + PROXY_LOCAL_PORT,
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  }
  if (process.platform !== 'linux') return args;
  args.push('--disable-dev-shm-usage');
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

// A mint only needs the traffic that carries the token: the launch chain's own requests
// and the game client's bootstrap. The video stream, images and fonts are pure cost -
// and on a metered proxy that cost is measured in megabytes per mint. These patterns go
// to Network.setBlockedURLs on every target a mint opens. Trailing * because the real
// URLs carry query strings. Set MINT_LOAD_MEDIA=1 to load everything, which is worth
// doing once if a mint ever stops finding its token.
// Video and audio only, deliberately. Blocking images and fonts as well saved more, but
// a browser that renders a page while fetching no artwork at all is an odd-looking
// client, and the operator's bot protection is exactly what is watching. The stream is
// where the megabytes are anyway. MINT_BLOCK_IMAGES=1 restores the aggressive list.
const HEAVY_MEDIA = [
  '*.m3u8*', '*.mpd*', '*.ts?*', '*.m4s*', '*.mp4*', '*.webm*', '*.mov*',
  '*.mp3*', '*.aac*', '*.ogg*', '*.wav*',
];
const ARTWORK = [
  '*.jpg*', '*.jpeg*', '*.png*', '*.gif*', '*.webp*', '*.avif*', '*.svg*', '*.ico*',
  '*.woff*', '*.woff2*', '*.ttf*', '*.otf*', '*.eot*',
];
export const MINT_BLOCKED_URLS = process.env.MINT_LOAD_MEDIA === '1' ? []
  : process.env.MINT_BLOCK_IMAGES === '1' ? [...HEAVY_MEDIA, ...ARTWORK]
  : HEAVY_MEDIA;

// Where the browser window goes. By default far off-screen: the mint needs a real,
// rendered window, but nobody wants it stealing focus or covering the desktop. Set
// SESSION_VISIBLE=1 to keep it on-screen, which is how you watch what the app is doing
// over VNC or a remote desktop.
export function windowArgs() {
  return process.env.SESSION_VISIBLE === '1'
    ? ['--window-size=1280,900']
    : ['--window-position=-32000,-32000', '--window-size=1200,800'];
}

// Keep the last few meaningful lines of a launched Chrome's stderr, so a launch that
// never exposes CDP can say why ("Missing X server", "profile appears to be in use", …)
// instead of timing out silently. Spawn with stdio ['ignore', 'ignore', 'pipe'].
// Returns a function giving ": <reason>" (or "" when Chrome said nothing).
export function stderrTail(child, keep = 4) {
  const lines = [];
  let exit = null;
  child.on('exit', (code, signal) => { exit = signal || 'code ' + code; });
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const raw of chunk.split(/\r?\n/)) {
        // drop the [pid:tid:time:LEVEL:file] prefix, and dbus chatter a VPS always prints
        const line = raw.replace(/^\[[^\]]*\]\s*/, '').trim();
        if (line && !/dbus|bus\.cc|org\.freedesktop/i.test(raw)) lines.push(line);
      }
      lines.splice(0, Math.max(0, lines.length - keep));
    });
  }
  return () => {
    const parts = [];
    if (exit) parts.push('Chrome exited (' + exit + ')');
    if (lines.length) parts.push(lines.join(' | ').slice(-400));
    return parts.length ? ': ' + parts.join(' - ') : '';
  };
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
