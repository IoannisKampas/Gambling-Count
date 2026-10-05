// Which deep counts are worth pushing, and when.
//
// Pure, like the pattern engine itself: state + the current table rows -> the alerts to
// send. No I/O, no clock, no network, so the rules below can be tested offline and the
// sending lives entirely in src/telegram.mjs.
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
//   readings the READINGS metadata, for labels
//   only     Set/array of reading ids to alert on, or null for all ten
export function scan(state, tables, { depth = DEFAULT_DEPTH, readings = [], only = null } = {}) {
  const want = only ? new Set(only) : null;
  const labels = new Map(readings.map((r) => [r.id, r.label]));
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
        alerts.push({
          tableId: t.id,
          table: t.name,
          provider: t.provider,
          reading: id,
          label: labels.get(id) || id,
          count,
          previous: prev,
          spins: (t.spins || []).slice(0, 6),
          armed: p.phase === 'INTERRUPTED',
        });
      }
      state.set(key, count);
    }
  }
  return alerts;
}

// One alert as a single line of a Telegram message. Plain text on purpose: table names
// come from the operators and would otherwise need HTML escaping to be safe.
export function formatAlert(a) {
  return '−' + Math.abs(a.count) + '  ' + a.label + '  ·  ' + a.table +
    (a.provider ? ' (' + a.provider + ')' : '') +
    (a.spins.length ? '  ·  last: ' + a.spins.join(' ') : '');
}

// The whole message for one flush.
export function formatBatch(lines, depth = DEFAULT_DEPTH) {
  const head = lines.length === 1
    ? 'Pattern alert · −' + depth + ' or deeper'
    : lines.length + ' pattern alerts · −' + depth + ' or deeper';
  return head + '\n\n' + lines.join('\n');
}
