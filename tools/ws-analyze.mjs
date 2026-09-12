// Connect to one Pragmatic socket, record every frame in both directions, and
// emit a JSON analysis: text frames parsed as JSON where possible, binary frames
// parsed as ISO-BMFF (fMP4) box structure.
//
// Usage: node ws-analyze.mjs <wss url> [holdSeconds]

import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const URL_ = process.argv[2];
const HOLD = Number(process.argv[3] || 20);
const OUT = process.argv[4] || 'ws-analysis.json';
if (!URL_) { console.error('usage: node ws-analyze.mjs <wss url> [seconds] [out]'); process.exit(1); }

const ORIGIN = 'https://client.pragmaticplaylive.net';
const t0 = Date.now();
const frames = [];
const events = [];

const ascii = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// walk top-level ISO-BMFF boxes; recurse into container boxes
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'dinf']);
function boxes(buf, start = 0, end = buf.length, depth = 0) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    const type = ascii(buf, o + 4);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); hdr = 16; }
    else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) { out.push({ type, size, truncated: true }); break; }
    const box = { type, size };
    if (type === 'ftyp') {
      box.majorBrand = ascii(buf, o + 8);
      box.compatibleBrands = [];
      for (let p = o + 16; p + 4 <= o + size; p += 4) box.compatibleBrands.push(ascii(buf, p));
    }
    if (type === 'mfhd') box.sequenceNumber = buf.readUInt32BE(o + 12);
    if (type === 'tfhd') box.trackId = buf.readUInt32BE(o + 12);
    if (type === 'tfdt') {
      const ver = buf[o + 8];
      box.baseMediaDecodeTime = ver === 1 ? Number(buf.readBigUInt64BE(o + 12)) : buf.readUInt32BE(o + 12);
    }
    if (type === 'trun') box.sampleCount = buf.readUInt32BE(o + 12);
    if (type === 'mdhd') { box.timescale = buf.readUInt32BE(o + 8 + 4 + 8); }
    if (type === 'hdlr') box.handler = ascii(buf, o + 16);
    if (type === 'mdat') box.payloadBytes = size - hdr;
    if (CONTAINERS.has(type) && depth < 4) box.children = boxes(buf, o + hdr, o + size, depth + 1);
    out.push(box);
    o += size;
  }
  return out;
}

const ws = new WebSocket(URL_, { origin: ORIGIN });

function record(dir, data, isBinary) {
  const f = { i: frames.length, tMs: Date.now() - t0, dir, bytes: isBinary ? data.length : Buffer.byteLength(data) };
  if (isBinary) {
    f.kind = 'binary';
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    f.hexHead = b.subarray(0, 16).toString('hex');
    try { f.mp4 = boxes(b); } catch (e) { f.mp4Error = e.message; }
    if (f.mp4) f.topLevel = f.mp4.map((x) => x.type).join('+');
  } else {
    const s = String(data);
    f.kind = 'text';
    f.raw = s.length > 400 ? s.slice(0, 400) + '…' : s;
    try { f.json = JSON.parse(s); f.format = 'json'; }
    catch { f.format = /^</.test(s.trim()) ? 'xml' : 'plain'; }
  }
  frames.push(f);
}

ws.on('open', () => {
  events.push({ tMs: Date.now() - t0, event: 'open' });
  for (const m of ['iq0', 'quality0']) { ws.send(m); record('out', m, false); }
});
ws.on('upgrade', (res) => { events.push({ tMs: Date.now() - t0, event: 'upgrade', status: res.statusCode, headers: res.headers }); });
ws.on('message', (d, isBinary) => record('in', d, isBinary));
ws.on('error', (e) => events.push({ tMs: Date.now() - t0, event: 'error', message: e.message }));
ws.on('close', (c, r) => events.push({ tMs: Date.now() - t0, event: 'close', code: c, reason: String(r) }));

let counter = 0;
const ping = setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const m = JSON.stringify({ cmd: 'ping', counter: ++counter, clientTime: Date.now() });
  ws.send(m); record('out', m, false);
}, 2000);

setTimeout(() => {
  clearInterval(ping);
  try { ws.close(); } catch {}
  const bin = frames.filter((f) => f.kind === 'binary' && f.dir === 'in');
  const txt = frames.filter((f) => f.kind === 'text' && f.dir === 'in');
  const byShape = {};
  for (const f of bin) byShape[f.topLevel || '?'] = (byShape[f.topLevel || '?'] || 0) + 1;
  const textShapes = {};
  for (const f of txt) {
    const k = f.json ? Object.keys(f.json).join(',') : f.raw.slice(0, 24);
    textShapes[k] = (textShapes[k] || 0) + 1;
  }
  const report = {
    url: URL_.replace(/JSESSIONID=[^&]+/, 'JSESSIONID=<redacted>'),
    host: new URL(URL_).host,
    path: new URL(URL_).pathname,
    origin: ORIGIN,
    durationSec: HOLD,
    summary: {
      framesIn: frames.filter((f) => f.dir === 'in').length,
      framesOut: frames.filter((f) => f.dir === 'out').length,
      binaryIn: bin.length,
      textIn: txt.length,
      binaryBytesIn: bin.reduce((a, b) => a + b.bytes, 0),
      binaryShapes: byShape,
      textShapes,
    },
    events,
    frames,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, frames: undefined }, null, 2));
  console.log('\nfull per-frame JSON -> ' + OUT);
  process.exit(0);
}, HOLD * 1000);
