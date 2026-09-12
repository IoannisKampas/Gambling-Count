// Lossless protobuf wire parse/encode for the Playtech gateway.
//
// The decoder in pt-decode.mjs guesses whether a length-delimited field is text or a
// nested message, which is fine for reading but unsafe to re-encode from. This module
// keeps every field's raw bytes, so a frame can be taken apart, one leaf changed, and
// put back together byte-identically apart from the edit.
//
// Used to rebuild pt.live.user/loginRequest/1.0 with a freshly minted session token
// (field 3.103.1) and the current context id (field 4) - the token's length differs
// every time, so the enclosing message lengths have to be recomputed.

export function encodeVarint(n) {
  const out = [];
  let v = BigInt(n);
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 0x80; out.push(b); } while (v > 0n);
  return Buffer.from(out);
}

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

// Parse into a flat list of {field, wire, raw} preserving order and bytes.
export function parseRaw(buf) {
  const out = [];
  let o = 0;
  while (o < buf.length) {
    const start = o;
    let key; [key, o] = readVarint(buf, o);
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (field === 0) break;
    if (wire === 0) { let v; const s = o; [v, o] = readVarint(buf, o); out.push({ field, wire, raw: buf.subarray(s, o) }); }
    else if (wire === 2) {
      let len; [len, o] = readVarint(buf, o);
      const n = Number(len);
      if (o + n > buf.length) { o = start; break; }
      out.push({ field, wire, raw: buf.subarray(o, o + n) });
      o += n;
    } else if (wire === 5) { out.push({ field, wire, raw: buf.subarray(o, o + 4) }); o += 4; }
    else if (wire === 1) { out.push({ field, wire, raw: buf.subarray(o, o + 8) }); o += 8; }
    else { o = start; break; }
  }
  return out;
}

export function encodeRaw(fields) {
  const parts = [];
  for (const f of fields) {
    parts.push(encodeVarint((f.field << 3) | f.wire));
    if (f.wire === 2) parts.push(encodeVarint(f.raw.length));
    parts.push(f.raw);
  }
  return Buffer.concat(parts);
}

// --- convenience accessors -------------------------------------------------
export const getField = (fields, n) => fields.find((f) => f.field === n) || null;
export const getAll = (fields, n) => fields.filter((f) => f.field === n);
export const str = (f) => (f ? f.raw.toString('utf8') : null);

// Replace (or insert) a length-delimited field's raw bytes, preserving position.
export function setField(fields, n, raw) {
  const copy = fields.slice();
  const i = copy.findIndex((f) => f.field === n);
  if (i === -1) copy.push({ field: n, wire: 2, raw });
  else copy[i] = { ...copy[i], wire: 2, raw };
  return copy;
}

// Walk a nested path of length-delimited fields, apply fn to the leaf list, re-encode.
// path is a list of field numbers, e.g. [3, 103] then edit that message's field 1.
export function editNested(buf, path, fn) {
  if (!path.length) return encodeRaw(fn(parseRaw(buf)));
  const fields = parseRaw(buf);
  const i = fields.findIndex((f) => f.field === path[0] && f.wire === 2);
  if (i === -1) throw new Error('field ' + path[0] + ' not found');
  const inner = editNested(fields[i].raw, path.slice(1), fn);
  const copy = fields.slice();
  copy[i] = { ...copy[i], raw: inner };
  return encodeRaw(copy);
}

// --- the thing we actually need --------------------------------------------
// Rebuild a captured loginRequest with a new session token, context id and request id.
export function buildLogin(capturedLoginFrame, { token, contextId, requestId = '3' }) {
  // 3.103.1 = session token
  let out = editNested(capturedLoginFrame, [3, 103], (leaf) =>
    setField(leaf, 1, Buffer.from(token, 'utf8')));
  // top-level 4 = context id, 2 = request id
  const top = parseRaw(out);
  let patched = setField(top, 4, Buffer.from(contextId, 'utf8'));
  patched = setField(patched, 2, Buffer.from(String(requestId), 'utf8'));
  return encodeRaw(patched);
}

// Rebuild any captured frame with a fresh context id / request id (no token change).
export function retarget(frame, { contextId, requestId }) {
  let f = parseRaw(frame);
  if (contextId) f = setField(f, 4, Buffer.from(contextId, 'utf8'));
  if (requestId != null) f = setField(f, 2, Buffer.from(String(requestId), 'utf8'));
  return encodeRaw(f);
}
