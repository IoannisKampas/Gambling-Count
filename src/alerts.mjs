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
// that every reading alerting on the same table at different moments is noise. This
// module can do either: `only` restricts it to a set of readings, and the default is
// every reading, which is what the operator of this app asked for.

import { groupOf, inGroup, breakingGroup, breakingHint } from './patterns.mjs';

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
//   only     Set/array of reading ids to alert on, or null for every reading
//   onlyTables  Set/array of table ids that may push, or null for every table
//   allow       (tableId, readingId) => boolean, for a per-table-per-reading selection
//               ("Andreas Deluxe on this one wheel only"). Takes precedence over
//               `onlyTables`, which is the whole-table shorthand.
//
// A (table, reading) pair that is not allowed is skipped entirely rather than
// tracked-but-muted, so arming it later starts it latched like anything newly seen
// (§8.3) - you get its next live deepening, never a backlog from while it was off.
export function scan(state, tables, {
  depth = DEFAULT_DEPTH, readings = [], only = null, onlyTables = null, depths = null,
  allow = null,
} = {}) {
  const want = only ? new Set(only) : null;
  const wantTables = onlyTables ? new Set(onlyTables) : null;
  const byId = new Map(readings.map((r) => [r.id, r]));
  const alerts = [];

  for (const t of tables || []) {
    if (!t || !t.reads) continue;
    if (wantTables && !wantTables.has(t.id)) continue;
    for (const [id, p] of Object.entries(t.reads)) {
      if (want && !want.has(id)) continue;
      if (allow && !allow(t.id, id)) continue;
      const key = keyOf(t.id, id);
      const prev = state.get(key);
      const count = p.count;

      // §8.2 — a desynced table's counts are not real; re-baseline, never alert
      if (t.desynced) { state.set(key, count); continue; }

      // §8.3 — first sight of this table/reading: latch silently, however deep
      if (prev === undefined) { state.set(key, count); continue; }

      // nothing has been watched live yet, so nothing here was earned in front of us
      if (!p.spinsObserved) { state.set(key, count); continue; }

      // A reading may set its own threshold. Group C turns up on 15 of 37 pockets, so
      // Andreas Deluxe reaches −4 far more often than any run reading does; comparing
      // the two at one depth would drown the rest.
      const rule = byId.get(id) || null;
      const limit = (depths && depths[id]) || (rule && rule.alertDepth) || depth;

      if (count <= -limit && count < prev) {
        alerts.push({
          tableId: t.id,
          table: t.name,
          provider: t.provider,
          reading: id,
          label: (rule && rule.label) || id,
          rule,
          depth: limit,          // the threshold actually in force, overrides included
          // the group whose arrival would reset this count: what to bet against the
          // pattern, and what the message names
          bet: breakingGroup(rule, p),
          betHint: breakingGroup(rule, p) ? null : breakingHint(rule),
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
const DOT = { A: '🔵', B: '🟠', C: '🟣' };
const COLOUR = { A: 'Blue', B: 'Orange', C: 'Purple' };
// A group-C reading is about one membership that cuts across A and B, so its strip is
// marked by that instead: in the group, or not. A/B colours would say nothing about why
// that count moved. Serie 1 and 2 are group A and B themselves, so they keep the usual
// colours and need no special case.
const IN = '🟣', OUT = '⚪';

// Newest first, left to right - the order the feed delivers them and the order the wall
// shows them. Reversing it here read as the more natural direction for a pattern but
// made the two disagree, which is worse: the number everyone looks for first is the spin
// that just landed, and it belongs at the front.
export function spinStrip(spins = [], rule = null) {
  const byMembership = !!rule && rule.kind === 'streak' && rule.group === 'C';
  return spins.map((n) => {
    try {
      return byMembership ? (inGroup(rule.group, n) ? IN : OUT) + n : DOT[groupOf(n)] + n;
    } catch { return String(n); }
  }).join(' ');
}

// One alert: the table, the pattern and its count, the group to bet on, and the recent
// numbers - in that order, because that is the order they are acted on.
export function formatAlertBlock(a) {
  const lines = [
    '🎰 <b>' + esc(a.table) + '</b>' + (a.provider ? ' (' + esc(a.provider) + ')' : ''),
    '🎯 <b>' + esc(a.label) + '</b> : <b>−' + Math.abs(a.count) + '</b>',
  ];
  // The group and its colour, not its numbers: whoever reads this knows the groups, and
  // nineteen numbers wrap badly on a phone.
  if (a.bet) {
    lines.push('🎲 Bet on <b>Group ' + a.bet + '</b> ' + DOT[a.bet] + ' ' + COLOUR[a.bet]);
  } else if (a.betHint) {
    // the All in pair between arms: the group is not settled yet, so say the rule
    lines.push('🎲 Bet on ' + esc(a.betHint));
  }
  if (a.spins && a.spins.length) lines.push(spinStrip(a.spins, a.rule));
  return lines.join('\n');
}

// the reading's own marker: its group colour, or the membership marker for a group-C
// reading, so the strip below it reads in the same terms
function mark(a) {
  const rule = a.rule || {};
  if (rule.kind === 'streak' && rule.group === 'C') return IN;
  return rule.side === 'A' ? DOT.A : rule.side === 'B' ? DOT.B : '⚪';
}

// The same facts on one line, for when a burst would otherwise be a wall of text. The
// group's numbers are dropped here; the group and its colour are not.
export function formatAlertLine(a) {
  return '🎰 ' + esc(a.table) + ' · 🎯 <b>' + esc(a.label) + ' −' +
    Math.abs(a.count) + '</b>' +
    (a.bet ? ' · 🎲 <b>Group ' + a.bet + '</b> ' + DOT[a.bet]
      : a.betHint ? ' · 🎲 ' + esc(a.betHint) : '') +
    (a.spins && a.spins.length ? ' · ' + spinStrip(a.spins.slice(0, 6), a.rule) : '');
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
  // Telegram stamps the message with its own time, so there is no clock here. A single
  // alert is just its block; a batch gets one line saying how many, because otherwise
  // several tables run together on a phone.
  const head = items.length > 1 ? '⚠️ <b>' + items.length + ' alerts</b>' : '';

  // Blocks while there are few; one line each when a burst arrives, since three full
  // blocks with their number lists is already a long message.
  const body = objects.length > 3
    ? objects.map(formatAlertLine).join('\n')
    : objects.map(formatAlertBlock).join('\n\n');

  const parts = head ? [head, ''] : [];
  if (body) parts.push(body);
  if (strings.length) parts.push(strings.join('\n'));
  if (link) { parts.push(''); parts.push('📊 ' + esc(link)); }
  return parts.join('\n');
}
