// Which deep counts are worth pushing, when, and how they read to somebody in the
// group who has never seen PATTERNS.md.
//
// The deciding half is pure, like the pattern engine itself: state + the current table
// rows -> the alerts to send. No I/O, no clock, no network, so the rules below can be
// tested offline and the sending lives entirely in src/telegram.mjs.
//
// Two rules come straight from PATTERNS.md and are the whole reason this is not a
// one-line "count <= -4" check:
//
//   §8.3  Nothing replayed may notify anybody. A table whose count was restored by
//         replaying its result window starts ALREADY LATCHED, so the alert fires on the
//         next live spin that deepens it rather than on history somebody else watched.
//         That is why a table's first appearance only records its count and says
//         nothing, however deep it already is.
//
//   §8.2  A desynced table's counts are discarded rather than guessed. Those are not
//         real counts, so they are re-baselined silently and never alerted on.
//
// PATTERNS.md §8.5 recommends letting only ONE reading alert (All in 1), on the grounds
// that ten readings alerting on the same table at different moments is noise. This
// module can do either: `only` restricts it to a set of readings, and the default is
// every reading, which is what the operator of this app asked for.

import { groupOf } from './patterns.mjs';

export const DEFAULT_DEPTH = 4;

// key -> the count we last accounted for on that table/reading
export function createAlertState() { return new Map(); }

const keyOf = (tableId, readingId) => tableId + '|' + readingId;

// Returns the alerts to send, and updates `state` in place. Deliberately mutating:
// every caller wants the two to move together, and a stale state means a repeat push.
//
//   tables   rows as /api/patterns serves them: { id, name, provider, spins, desynced,
//            reads: { <readingId>: { count, phase, spinsObserved, … } } }
//   depth    alert at this depth or deeper, as a positive number (4 means −4)
//   readings the READINGS metadata, carried into each alert for the message text
//   only     Set/array of reading ids to alert on, or null for all ten
export function scan(state, tables, { depth = DEFAULT_DEPTH, readings = [], only = null } = {}) {
  const want = only ? new Set(only) : null;
  const byId = new Map(readings.map((r) => [r.id, r]));
  const alerts = [];

  for (const t of tables || []) {
    if (!t || !t.reads) continue;
    for (const [id, p] of Object.entries(t.reads)) {
      if (want && !want.has(id)) continue;
      const key = keyOf(t.id, id);
      const prev = state.get(key);
      const count = p.count;

      // §8.2 — a desynced table's counts are not real; re-baseline, never alert
      if (t.desynced) { state.set(key, count); continue; }

      // §8.3 — first sight of this table/reading: latch silently, however deep
      if (prev === undefined) { state.set(key, count); continue; }

      // nothing has been watched live yet, so nothing here was earned in front of us
      if (!p.spinsObserved) { state.set(key, count); continue; }

      if (count <= -depth && count < prev) {
        const rule = byId.get(id) || null;
        alerts.push({
          tableId: t.id,
          table: t.name,
          provider: t.provider,
          reading: id,
          label: (rule && rule.label) || id,
          rule,
          count,
          previous: prev,
          spins: (t.spins || []).slice(0, 8),   // newest first, as the feed delivers
          armed: p.phase === 'INTERRUPTED',
        });
      }
      state.set(key, count);
    }
  }
  return alerts;
}

// ------------------------------------------------------------------- messages ----
// Written for a phone screen in a group whose members already know the readings, so
// there is nothing explaining what a pattern is: the work here is legibility. The
// depth, the table and the group of every recent spin should be readable at a glance,
// without reading a word.
//
// Telegram HTML is used for emphasis only, so everything interpolated is escaped -
// table names come from the operators and will eventually contain an & or a <.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Group A is blue and group B orange everywhere in this app (PATTERNS.md §2.1); the
// same two colours carry into the message, so a spin strip reads the same on a phone
// as on the wall. The number is always shown as well, so nothing rests on colour.
const DOT = { A: '🔵', B: '🟠' };

// spins arrive newest first; people read a pattern left to right, oldest first
export function spinStrip(spins = []) {
  return spins.slice().reverse().map((n) => {
    try { return DOT[groupOf(n)] + n; } catch { return String(n); }
  }).join(' ');
}

// One alert, as a small block: reading and depth, the table, the spins.
export function formatAlertBlock(a) {
  const side = a.rule && a.rule.side;
  const dot = side === 'A' ? DOT.A : side === 'B' ? DOT.B : '⚪';
  const lines = [
    dot + ' <b>' + esc(a.label) + '</b>   <b>−' + Math.abs(a.count) + '</b>',
    '<b>' + esc(a.table) + '</b>' + (a.provider ? '  ·  ' + esc(a.provider) : ''),
  ];
  if (a.spins && a.spins.length) lines.push(spinStrip(a.spins));
  if (a.armed) lines.push('⏳ next spin decides');
  return lines.join('\n');
}

// One alert on a single line, for when a burst would otherwise be a wall of text.
export function formatAlertLine(a) {
  const side = a.rule && a.rule.side;
  const dot = side === 'A' ? DOT.A : side === 'B' ? DOT.B : '⚪';
  return dot + ' <b>' + esc(a.label) + ' −' + Math.abs(a.count) + '</b> · ' + esc(a.table) +
    (a.spins && a.spins.length ? ' · ' + spinStrip(a.spins.slice(0, 6)) : '');
}

// Kept for the one-line log/plain-text use and for anything already holding strings.
export function formatAlert(a) {
  if (typeof a === 'string') return a;
  return '−' + Math.abs(a.count) + '  ' + a.label + '  ·  ' + a.table +
    (a.provider ? ' (' + a.provider + ')' : '') +
    ((a.spins || []).length ? '  ·  last: ' + a.spins.join(' ') : '');
}

const clock = (tz) => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', timeZone: tz,
    }).format(new Date());
  } catch { return ''; }
};

// The whole message for one flush. Blocks while there are few, one line each when a
// burst arrives - five full blocks is already a long message on a phone.
export function formatBatch(items, depth = DEFAULT_DEPTH, { tz = 'Europe/Athens', link = '' } = {}) {
  const objects = items.filter((i) => typeof i !== 'string');
  const strings = items.filter((i) => typeof i === 'string');
  const at = clock(tz);
  const head = '🎯 <b>−' + depth + ' or deeper</b>' +
    (items.length > 1 ? '  ·  ' + items.length + ' tables' : '') +
    (at ? '  ·  ' + at : '');

  // Blocks while there are few; one line each when a burst arrives, since five full
  // blocks is already more than a phone shows at once.
  const body = objects.length > 4
    ? objects.map(formatAlertLine).join('\n')
    : objects.map(formatAlertBlock).join('\n\n');

  const parts = [head, ''];
  if (body) parts.push(body);
  if (strings.length) parts.push(strings.join('\n'));
  if (link) { parts.push(''); parts.push('📊 ' + esc(link)); }
  return parts.join('\n');
}
