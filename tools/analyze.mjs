// Summarises a capture log: hosts, XHR endpoints, websockets, frame shapes.
// Usage: node tools/analyze.mjs [session file] [--frames <substr>] [--host <substr>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'capture');

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf('--' + n);
  return i === -1 ? null : args[i + 1];
};
let file = args.find((a) => !a.startsWith('--') && a.endsWith('.jsonl'));
if (!file) {
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(OUT_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  file = files[0];
}
if (!file) {
  console.error('no capture file');
  process.exit(1);
}

const rows = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

console.log('file:', file, '-', rows.length, 'events\n');

const frameFilter = flag('frames');
const hostFilter = flag('host');

// ---- websockets -----------------------------------------------------------
const wsByUrl = new Map();
for (const r of rows) {
  if (!r.type.startsWith('ws-')) continue;
  const url = r.url || '(unknown)';
  if (!wsByUrl.has(url)) wsByUrl.set(url, { sent: [], recv: [], open: 0 });
  const e = wsByUrl.get(url);
  if (r.type === 'ws-open') e.open++;
  if (r.type === 'ws-sent' && r.payload) e.sent.push(r.payload);
  if (r.type === 'ws-recv' && r.payload) e.recv.push(r.payload);
}

console.log('=== WEBSOCKETS ===');
for (const [url, e] of wsByUrl) {
  console.log('\n' + url);
  console.log('   opens=' + e.open + '  sent=' + e.sent.length + '  recv=' + e.recv.length);
  const keys = new Map();
  for (const p of e.recv) {
    let k;
    try {
      const j = JSON.parse(p);
      k = Object.keys(j).sort().join(',');
    } catch {
      k = p.slice(0, 40);
    }
    if (!keys.has(k)) keys.set(k, { n: 0, sample: p });
    keys.get(k).n++;
  }
  const top = [...keys.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25);
  for (const [k, v] of top) {
    console.log('   [' + String(v.n).padStart(4) + '] ' + k);
    console.log('          ' + v.sample.slice(0, 300));
  }
}

// ---- http -----------------------------------------------------------------
const hosts = new Map();
const endpoints = new Map();
for (const r of rows) {
  if (r.type !== 'req') continue;
  let u;
  try {
    u = new URL(r.url);
  } catch {
    continue;
  }
  hosts.set(u.host, (hosts.get(u.host) || 0) + 1);
  if (r.resourceType === 'XHR' || r.resourceType === 'Fetch' || /\.json/i.test(u.pathname)) {
    const key = r.method + ' ' + u.host + u.pathname;
    if (!endpoints.has(key)) endpoints.set(key, { n: 0, sample: r.url, post: r.postData });
    endpoints.get(key).n++;
  }
}

console.log('\n=== HOSTS ===');
for (const [h, n] of [...hosts.entries()].sort((a, b) => b[1] - a[1])) {
  if (hostFilter && !h.includes(hostFilter)) continue;
  console.log(String(n).padStart(5), h);
}

console.log('\n=== XHR / FETCH / JSON ENDPOINTS ===');
for (const [k, v] of [...endpoints.entries()].sort((a, b) => b[1].n - a[1].n)) {
  if (hostFilter && !k.includes(hostFilter)) continue;
  console.log('[' + String(v.n).padStart(3) + '] ' + k);
  console.log('       ' + v.sample.slice(0, 240));
  if (v.post) console.log('       POST: ' + v.post.slice(0, 240));
}

// ---- optional raw frame dump ---------------------------------------------
if (frameFilter) {
  console.log('\n=== FRAMES matching "' + frameFilter + '" ===');
  for (const r of rows) {
    if (r.type !== 'ws-recv' && r.type !== 'ws-sent') continue;
    if (!r.payload || !r.payload.includes(frameFilter)) continue;
    console.log(
      new Date(r.t).toISOString().slice(11, 23),
      r.type === 'ws-sent' ? '>>' : '<<',
      r.payload.slice(0, 600),
    );
  }
}
