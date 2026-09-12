// Generic protobuf wire-format decoder for the Playtech ielive gateway.
//
// Playtech's live socket (wss://ielive-gateway.ptielive.com/ws) speaks base64-encoded
// protobuf with no schema published. The wire format is self-describing enough to walk
// without a .proto: every field carries a number and a wire type, so we can recover the
// tree and guess strings/nested messages. Field 1 of the envelope is the service method
// name, e.g. "pt.live.user.init/InitRequest".
//
// Usage:
//   node tools/pt-decode.mjs methods            # list every method seen in the capture
//   node tools/pt-decode.mjs dump <substring>   # decode frames whose method matches

import fs from 'node:fs';
import readline from 'node:readline';

// ---------------------------------------------------------------- decoding ----
export function readVarint(buf, o) {
  let result = 0n, shift = 0n, pos = o;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
  return [result, pos];
}

const printable = (b) => {
  if (!b.length) return false;
  let ok = 0;
  for (const c of b) if ((c >= 0x20 && c < 0x7f) || c === 0x0a || c === 0x09) ok++;
  return ok / b.length > 0.9;
};

// Decode a protobuf message into {field, type, value} nodes. Length-delimited fields
// are tried as nested messages first, then as text, else kept as raw bytes.
export function decode(buf, depth = 0) {
  const out = [];
  let o = 0;
  while (o < buf.length) {
    let key, pos;
    try { [key, pos] = readVarint(buf, o); } catch { break; }
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (field === 0) break;
    o = pos;
    if (wire === 0) {
      let v; try { [v, o] = readVarint(buf, o); } catch { break; }
      out.push({ field, type: 'varint', value: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString() });
    } else if (wire === 2) {
      let len; try { [len, o] = readVarint(buf, o); } catch { break; }
      const n = Number(len);
      if (o + n > buf.length) break;
      const slice = buf.subarray(o, o + n); o += n;
      let nested = null;
      if (n > 1 && depth < 12) {
        try {
          const sub = decode(slice, depth + 1);
          // accept the nested reading only if it consumed sensibly
          if (sub.length && sub.every((x) => x.field > 0 && x.field < 2000)) nested = sub;
        } catch {}
      }
      if (printable(slice) && (!nested || slice.length < 64)) {
        out.push({ field, type: 'string', value: slice.toString('utf8'), nested });
      } else if (nested) {
        out.push({ field, type: 'message', value: nested });
      } else {
        out.push({ field, type: 'bytes', value: slice.toString('hex').slice(0, 120), len: n });
      }
    } else if (wire === 5) { out.push({ field, type: 'fixed32', value: buf.readUInt32LE(o) }); o += 4; }
    else if (wire === 1) { out.push({ field, type: 'fixed64', value: buf.readBigUInt64LE(o).toString() }); o += 8; }
    else break; // groups / unknown
  }
  return out;
}

export function render(nodes, indent = '  ') {
  const lines = [];
  for (const n of nodes) {
    if (n.type === 'message') {
      lines.push(indent + n.field + ': {');
      lines.push(...render(n.value, indent + '  '));
      lines.push(indent + '}');
    } else if (n.type === 'string') {
      lines.push(indent + n.field + ': "' + n.value.replace(/\n/g, '\\n').slice(0, 160) + '"');
      if (n.nested) { lines.push(indent + '   (also parses as message:)'); lines.push(...render(n.nested, indent + '     ')); }
    } else {
      lines.push(indent + n.field + ': ' + n.type + ' ' + n.value + (n.len ? ' (' + n.len + 'B)' : ''));
    }
  }
  return lines;
}

// method name = first string field of the envelope
export function methodOf(nodes) {
  const f1 = nodes.find((n) => n.field === 1 && n.type === 'string');
  return f1 ? f1.value : null;
}

// ------------------------------------------------------------------ capture ----
export async function* gatewayFrames(hostMatch = 'ielive-gateway') {
  const dir = 'capture';
  const files = fs.readdirSync(dir).filter((f) => /^session-.*\.jsonl$/.test(f)).sort();
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(dir + '/' + file) });
    for await (const line of rl) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'ws-sent' && o.type !== 'ws-recv') continue;
      if (!o.url || !o.url.includes(hostMatch)) continue;
      if (!o.payload) continue;
      let buf; try { buf = Buffer.from(o.payload, 'base64'); } catch { continue; }
      if (!buf.length) continue;
      yield { dir: o.type === 'ws-sent' ? 'out' : 'in', buf, file };
    }
  }
}

// --------------------------------------------------------------------- main ----
const cmd = process.argv[2] || 'methods';
if (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  if (cmd === 'methods') {
    const tally = new Map();
    for await (const f of gatewayFrames()) {
      let nodes; try { nodes = decode(f.buf); } catch { continue; }
      const m = methodOf(nodes) || '(no method string)';
      const k = f.dir + '  ' + m;
      tally.set(k, (tally.get(k) || 0) + 1);
    }
    console.log('=== Playtech gateway methods seen ===');
    for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log('  ' + String(n).padStart(4) + '  ' + k);
    }
  } else if (cmd === 'dump') {
    const needle = (process.argv[3] || '').toLowerCase();
    let shown = 0;
    for await (const f of gatewayFrames()) {
      let nodes; try { nodes = decode(f.buf); } catch { continue; }
      const m = methodOf(nodes) || '';
      if (needle && !m.toLowerCase().includes(needle)) continue;
      console.log('\n' + '='.repeat(80));
      console.log(f.dir.toUpperCase() + '  ' + m + '  (' + f.buf.length + ' bytes)');
      console.log(render(nodes).join('\n').slice(0, 4000));
      if (++shown >= Number(process.argv[4] || 6)) break;
    }
    if (!shown) console.log('no frames matched "' + needle + '"');
  }
}
