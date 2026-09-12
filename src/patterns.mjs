// Roulette pattern tracking — PATTERNS.md §2–§5, §8.
//
// Two patterns watch the same shape in the spin sequence: a run of 3+ from one group,
// interrupted by one spin of the other group, then a single deciding spin. Pattern 1
// counts when the origin group RETURNS; Pattern 2 counts when the interrupter REPEATS.
// That swap is the only difference between them (§4).
//
// The state machine is pure: state + number -> new state. No I/O, no clock, no
// randomness, so a stored history can be replayed through it and tested offline (§5).
// Both patterns are the same function with a variant flag, so there is one
// implementation to get right rather than two that drift.

// §2 — the fixed, arbitrary split. Not red/black, not odd/even. Zero is in group A.
export const GROUP_A = [0, 1, 2, 3, 6, 7, 8, 10, 13, 14, 17, 20, 23, 25, 26, 27, 28, 29];
export const GROUP_B = [4, 5, 9, 11, 12, 15, 16, 18, 19, 21, 22, 24, 30, 31, 32, 33, 34, 35, 36];
const A_SET = new Set(GROUP_A);
const B_SET = new Set(GROUP_B);

// A number outside 0..36, or a non-integer, is not a spin. Reject it loudly - never
// coerce it and never let it fall silently into a group (§2).
export function groupOf(n) {
  if (!Number.isInteger(n) || n < 0 || n > 36) {
    throw new RangeError('not a spin: ' + JSON.stringify(n));
  }
  return A_SET.has(n) ? 'A' : 'B';
}

export const PHASE = { BUILDING: 'BUILDING', INTERRUPTED: 'INTERRUPTED' };
export const EVENT = { NONE: 'NONE', ARMED: 'ARMED', COUNT: 'COUNT', RESET: 'RESET' };

export function createState() {
  return {
    count: 0,
    phase: PHASE.BUILDING,
    runGroup: null,
    runLength: 0,
    originGroup: null,
    // derived figures that cannot be recovered afterwards (§5)
    deepest: 0,
    resets: 0,
    spinsObserved: 0,
  };
}

// §5 — the whole of the pattern logic. `variant` is 1 or 2.
// Returns { state, event }; the input state is not mutated.
export function applySpin(prev, n, variant) {
  const g = groupOf(n);
  const s = { ...prev };
  let event = EVENT.NONE;

  if (s.phase === PHASE.INTERRUPTED) {
    const returned = g === s.originGroup;
    // The entire difference between the two patterns, and the only one.
    const deepens = variant === 1 ? returned : !returned;

    if (deepens) { s.count -= 1; event = EVENT.COUNT; }
    else { s.count = 0; s.resets += 1; event = EVENT.RESET; }

    s.phase = PHASE.BUILDING;
    s.runGroup = g;
    // §3.4 the carry: a return stands alone, a repeat is already the second of its run.
    // Never depends on the variant.
    s.runLength = returned ? 1 : 2;
    s.originGroup = null;
  } else {
    if (s.runGroup === null) {
      s.runGroup = g; s.runLength = 1;
    } else if (g === s.runGroup) {
      s.runLength += 1;
    } else if (s.runLength >= 3) {
      s.phase = PHASE.INTERRUPTED;
      s.originGroup = s.runGroup;
      s.runGroup = g; s.runLength = 1;
      event = EVENT.ARMED;
    } else {
      // §3.2 deadzone: chop never arms anything and never resets a count either.
      s.runGroup = g; s.runLength = 1;
    }
  }

  if (s.count < s.deepest) s.deepest = s.count;
  return { state: s, event };
}

// Replay a sequence OLDEST FIRST through a fresh state. Used for tests and for seeding.
export function replay(spins, variant, from = createState()) {
  let state = from;
  const events = [];
  for (const n of spins) {
    const r = applySpin(state, n, variant);
    state = r.state;
    events.push(r.event);
  }
  return { state, events };
}

// ---------------------------------------------------------------------------------
// §8 — feeding it from a scraper. This is where implementations actually go wrong.
// ---------------------------------------------------------------------------------

// Work out which entries of a freshly fetched window (NEWEST FIRST) are new, given what
// we already knew (NEWEST FIRST). Returns { fresh, status } where `fresh` is newest
// first and status is 'ok' | 'seed' | 'desync'.
//
// Ids are the only reliable method (§8.1). Without them we match by value overlap and
// refuse to guess when the alignment is ambiguous or absent (§8.2) - a missed spin
// produces a plausible count that is silently wrong forever, so we would rather lose
// the count than report a false one.
const MIN_OVERLAP = 4;

export function detectNew(known, fetched) {
  if (!fetched.length) return { fresh: [], status: 'ok' };
  if (!known.length) return { fresh: fetched, status: 'seed' };

  const haveIds = fetched.every((x) => x.id != null) && known.every((x) => x.id != null);
  if (haveIds) {
    const k = fetched.findIndex((x) => x.id === known[0].id);
    if (k === -1) return { fresh: [], status: 'desync' }; // newest known id fell off the window
    return { fresh: fetched.slice(0, k), status: 'ok' };
  }

  // value-overlap matching, with the ambiguity guard
  const matches = [];
  for (let k = 0; k < fetched.length; k++) {
    const len = Math.min(fetched.length - k, known.length);
    if (len < Math.min(MIN_OVERLAP, known.length)) break; // too little left to be sure
    let same = true;
    for (let i = 0; i < len; i++) {
      if (fetched[k + i].n !== known[i].n) { same = false; break; }
    }
    if (same) matches.push(k);
  }
  if (matches.length !== 1) return { fresh: [], status: 'desync' }; // none, or ambiguous
  return { fresh: fetched.slice(0, matches[0]), status: 'ok' };
}

const KEEP = 60;   // how much of each table's window we remember for the next diff
const STRIP = 40;  // how many numbers we keep for display

// Tracks both patterns for many tables across repeated polls.
export class PatternTracker {
  constructor() { this.tables = new Map(); }

  get(id) { return this.tables.get(id) || null; }
  all() { return [...this.tables.values()]; }

  // A feed reconnected, so an unknown number of spins happened while we were away.
  // §8.2 says never carry a count across that gap. We go further than §8.3's optional
  // re-seed and start genuinely clean: the numbers from before the reconnect are
  // dropped, both counts go to 0, and the next window is adopted only as a BASELINE -
  // it is not replayed - so counting begins with spins that arrive after the reconnect.
  markGap(match) {
    let n = 0;
    for (const t of this.tables.values()) {
      if (typeof match === 'function' ? !match(t) : false) continue;
      t.p1 = createState();
      t.p2 = createState();
      t.known = [];
      t.strip = [];              // the displayed numbers go too
      t.awaitingBaseline = true; // next window marks the starting point, unreplayed
      t.desynced = true;
      t.seeded = false;
      n++;
    }
    return n;
  }

  // window: results NEWEST FIRST, entries { n, id? }
  ingest(id, meta, window) {
    const clean = (window || [])
      .filter((r) => Number.isInteger(r.n) && r.n >= 0 && r.n <= 36)
      .map((r) => ({ n: r.n, id: r.id ?? null }));

    let t = this.tables.get(id);
    if (!t) {
      t = {
        id, meta,
        known: [],
        strip: [],              // numbers to display, newest first
        p1: createState(), p2: createState(),
        desynced: false, seeded: false, awaitingBaseline: false,
        lastEvent1: EVENT.NONE, lastEvent2: EVENT.NONE,
        updatedAt: 0,
      };
      this.tables.set(id, t);
    }
    t.meta = meta;
    if (!clean.length) return t;

    // First window after a reconnect: take it purely as a starting marker. Nothing is
    // replayed and nothing is displayed, so the table truly begins from zero.
    if (t.awaitingBaseline) {
      t.known = clean.slice(0, KEEP);
      t.awaitingBaseline = false;
      t.updatedAt = Date.now();
      return t;
    }

    const { fresh, status } = detectNew(t.known, clean);

    if (status === 'desync') {
      // §8.2 - discard the count rather than carry a plausible-but-wrong one
      t.desynced = true;
      t.p1 = createState(); t.p2 = createState();
      t.known = clean.slice(0, KEEP);
      t.strip = clean.map((s) => s.n).slice(0, STRIP);
      t.seeded = true;
      // re-seed from the window we can see, oldest first
      this.#feed(t, clean.slice().reverse(), false);
      t.updatedAt = Date.now();
      return t;
    }

    if (status === 'seed') {
      // §8.3 - replay to start from a true count, but do not count these as observed
      t.seeded = true;
      this.#feed(t, clean.slice().reverse(), false);
      t.known = clean.slice(0, KEEP);
      t.strip = clean.map((s) => s.n).slice(0, STRIP);
      t.updatedAt = Date.now();
      return t;
    }

    if (fresh.length) {
      t.desynced = false;
      this.#feed(t, fresh.slice().reverse(), true);  // oldest first
      t.known = clean.slice(0, KEEP);
      // newest first; after a reconnect this grows from empty, one live spin at a time
      t.strip = [...fresh.map((s) => s.n), ...t.strip].slice(0, STRIP);
      t.updatedAt = Date.now();
    }
    return t;
  }

  // observed=false for seeded/replayed spins: they restore the count but must not
  // inflate the statistics (§8.3).
  #feed(t, spinsOldestFirst, observed) {
    for (const s of spinsOldestFirst) {
      const r1 = applySpin(t.p1, s.n, 1);
      const r2 = applySpin(t.p2, s.n, 2);
      t.p1 = r1.state; t.p2 = r2.state;
      t.lastEvent1 = r1.event; t.lastEvent2 = r2.event;
      if (observed) { t.p1.spinsObserved += 1; t.p2.spinsObserved += 1; }
      else {
        // keep stats clean on a replay
        t.p1.resets = 0; t.p2.resets = 0;
        t.p1.spinsObserved = 0; t.p2.spinsObserved = 0;
      }
    }
  }
}
