// Roulette group patterns — AGENT-BRIEF.md plus AGENT-BRIEF-ADDENDUM-1.md.
//
// Fourteen readings watch the same shape in the spin sequence: a run of numbers from one
// group, interrupted by the other group, and then one spin that decides what the
// interruption meant. They differ only by five numbers (§4), so there is ONE reducer
// and fourteen rows of data - never fourteen functions, and never a "swap the groups" wrapper,
// because two copies of this logic drifting apart is how a count that is not real gets
// reported (§1).
//
// The state machine is pure: state + number -> new state. No I/O, no clock, no
// randomness, so a stored history can be replayed through it and tested offline (§1.2).

// §2 — the fixed, arbitrary split. Not red/black, not odd/even. Zero is in group A.
export const GROUP_A = [0, 1, 2, 3, 6, 7, 8, 10, 13, 14, 17, 20, 23, 25, 26, 27, 28, 29];
export const GROUP_B = [4, 5, 9, 11, 12, 15, 16, 18, 19, 21, 22, 24, 30, 31, 32, 33, 34, 35, 36];
const A_SET = new Set(GROUP_A);

// Group C is a SEPARATE, overlapping split - not a third slice of A/B. Nine of these
// numbers are group A and six are group B, so a spin belongs to A or B *and* may also
// belong to C. It exists for the absence readings below, which care only about whether
// a number is in C.
export const GROUP_C = [0, 2, 3, 5, 8, 10, 17, 21, 23, 25, 26, 30, 32, 34, 35];
const C_SET = new Set(GROUP_C);

// Membership sets a streak reading can watch, by name. Kept out of the READINGS rows
// themselves so those stay plain JSON for the API and the page.
const MEMBERS = { A: A_SET, B: new Set(GROUP_B), C: C_SET };

export function inGroup(name, n) {
  const set = MEMBERS[name];
  if (!set) throw new RangeError('unknown group: ' + JSON.stringify(name));
  if (!Number.isInteger(n) || n < 0 || n > 36) {
    throw new RangeError('not a spin: ' + JSON.stringify(n));
  }
  return set.has(n);
}

// A number outside 0..36, or a non-integer, is not a spin. Reject it loudly - never
// coerce it and never let it fall silently into a group (§1.4).
export function groupOf(n) {
  if (!Number.isInteger(n) || n < 0 || n > 36) {
    throw new RangeError('not a spin: ' + JSON.stringify(n));
  }
  return A_SET.has(n) ? 'A' : 'B';
}

// Which group's arrival would BREAK this count - reset it to 0. It is the group to bet on
// if you are betting against the pattern, and the group the alert names.
//
// It is a property of the reading, not a strategy: the All in pair deepen when the
// original group returns, so what breaks them is the interruption carrying on; every
// other run reading is the reverse. A streak reading is broken by whatever ends the
// streak - the other group for Serie, a group-C number for Andreas Deluxe.
//
// Returns 'A' | 'B' | 'C', or null when the reading is not currently in a state that can
// be broken by one spin (a run reading that is not armed).
export function breakingGroup(reading, state) {
  if (!reading) return null;
  if (reading.kind === 'streak') {
    if (reading.deepensOn === 'out') return reading.group;        // a C number resets it
    return reading.group === 'A' ? 'B' : 'A';                     // the other group ends the run
  }
  if (!state || state.phase !== PHASE.INTERRUPTED) return null;
  return reading.deepensOnReturn ? state.runGroup : state.originGroup;
}

// The numbers in a group, by name.
export function groupNumbers(name) {
  if (name === 'A') return GROUP_A;
  if (name === 'B') return GROUP_B;
  if (name === 'C') return GROUP_C;
  return [];
}

export const PHASE = { BUILDING: 'BUILDING', INTERRUPTED: 'INTERRUPTED' };
export const EVENT = { NONE: 'NONE', ARMED: 'ARMED', COUNT: 'COUNT', RESET: 'RESET' };

// §4 — this table IS the specification. Everything else follows from it.
//
//   minRunToArm     how long a run must be before breaking it can arm anything
//   armsFrom        which group's run may arm; null = either (the All in pair)
//   armAfter        how long the interrupting run must get to count as armed
//   decideAfter     how long it must get for the interrupter carrying on to resolve
//   deepensOnReturn true: deepens when the ORIGINAL group returns
//                   false: deepens when the INTERRUPTING group carries on
//
// `label`/`needs` are for display only and never affect the count. `alertDepth` is the
// count at which this reading pushes a notification: each reading has its own, because a
// −6 means something quite different on a reading that arms every other spin than on one
// that arms every fortieth. ALERT_DEPTHS overrides these per reading at run time.
export const READINGS = [
  { id: 'allin1', label: 'All in 1', side: 'either',
    needs: 'run of 3+ · 1 opposite · the run’s group returns',
    minRunToArm: 3, armsFrom: null, armAfter: 1, decideAfter: 2, deepensOnReturn: true, alertDepth: 15, simDepth: 11 },
  { id: 'monada', label: 'Monada', side: 'A',
    needs: 'A-run · 1 B · another B',
    minRunToArm: 1, armsFrom: 'A', armAfter: 1, decideAfter: 2, deepensOnReturn: false, alertDepth: 14, simDepth: 12 },
  { id: 'diada', label: 'Diada', side: 'A',
    needs: 'A-run · 2 B · a third B',
    minRunToArm: 1, armsFrom: 'A', armAfter: 2, decideAfter: 3, deepensOnReturn: false, alertDepth: 13, simDepth: 10 },
  { id: 'triada', label: 'Triada', side: 'A',
    needs: 'A-run · 3 B · a fourth B',
    minRunToArm: 1, armsFrom: 'A', armAfter: 3, decideAfter: 4, deepensOnReturn: false, alertDepth: 11, simDepth: 8 },
  { id: 'tetrada', label: 'Tetrada', side: 'A',
    needs: 'A-run · 4 B · a fifth B',
    minRunToArm: 1, armsFrom: 'A', armAfter: 4, decideAfter: 5, deepensOnReturn: false },
  { id: 'pentada', label: 'Pentada', side: 'A',
    needs: 'A-run · 5 B · a sixth B',
    minRunToArm: 1, armsFrom: 'A', armAfter: 5, decideAfter: 6, deepensOnReturn: false },
  { id: 'enaduo', label: 'Ena/Duo', side: 'A',
    needs: 'A-run · armed from the 1st B · counts on the 3rd',
    minRunToArm: 1, armsFrom: 'A', armAfter: 1, decideAfter: 3, deepensOnReturn: false, alertDepth: 6 },
  { id: 'allin2', label: 'All in 2', side: 'either',
    needs: 'run of 3+ · 1 opposite · the opposite repeats',
    minRunToArm: 3, armsFrom: null, armAfter: 1, decideAfter: 2, deepensOnReturn: false, alertDepth: 15, simDepth: 11 },
  { id: 'monada2', label: 'Monada 2', side: 'B',
    needs: 'B-run · 1 A · another A',
    minRunToArm: 1, armsFrom: 'B', armAfter: 1, decideAfter: 2, deepensOnReturn: false, alertDepth: 14, simDepth: 12 },
  { id: 'diada2', label: 'Diada 2', side: 'B',
    needs: 'B-run · 2 A · a third A',
    minRunToArm: 1, armsFrom: 'B', armAfter: 2, decideAfter: 3, deepensOnReturn: false, alertDepth: 13, simDepth: 10 },
  { id: 'triada2', label: 'Triada 2', side: 'B',
    needs: 'B-run · 3 A · a fourth A',
    minRunToArm: 1, armsFrom: 'B', armAfter: 3, decideAfter: 4, deepensOnReturn: false, alertDepth: 11, simDepth: 8 },
  { id: 'tetrada2', label: 'Tetrada 2', side: 'B',
    needs: 'B-run · 4 A · a fifth A',
    minRunToArm: 1, armsFrom: 'B', armAfter: 4, decideAfter: 5, deepensOnReturn: false },
  { id: 'pentada2', label: 'Pentada 2', side: 'B',
    needs: 'B-run · 5 A · a sixth A',
    minRunToArm: 1, armsFrom: 'B', armAfter: 5, decideAfter: 6, deepensOnReturn: false },
  { id: 'enaduo2', label: 'Ena/Duo 2', side: 'B',
    needs: 'B-run · armed from the 1st A · counts on the 3rd',
    minRunToArm: 1, armsFrom: 'B', armAfter: 1, decideAfter: 3, deepensOnReturn: false, alertDepth: 6 },

  // An ABSENCE reading, and the only one so far: it watches for a group not turning up
  // rather than for a run being interrupted. Every spin outside group C takes the count
  // one deeper; any group-C number wipes it back to 0. There is no arming and no
  // decider, so `phase` stays BUILDING for it and `armed` never means anything.
  //
  // STREAK readings. These watch one membership rather than a run being interrupted:
  // every spin on the right side of it takes the count one deeper, and the first spin on
  // the wrong side wipes it to 0. `deepensOn` says which side counts - 'in' the group
  // (Serie) or 'out' of it (Andreas Deluxe). There is no arming and no decider, so
  // `phase` stays BUILDING for all of them and `armed` never means anything.
  { id: 'serie1', label: 'Serie 1', side: 'A', kind: 'streak', group: 'A', deepensOn: 'in',
    needs: 'consecutive Group A numbers · any Group B number resets it',
    alertDepth: 11 },
  { id: 'serie2', label: 'Serie 2', side: 'B', kind: 'streak', group: 'B', deepensOn: 'in',
    needs: 'consecutive Group B numbers · any Group A number resets it',
    alertDepth: 11 },

  // alertDepth is far deeper here than the arithmetic alone suggests, and deliberately:
  // group C holds 15 of 37 pockets, so a miss is 22/37 ≈ 59% likely and this count moves
  // constantly. Measured over 2M spins, −5 pushes every ~14 minutes per table (one every
  // 25 seconds across 33 armed tables, which drowns everything else); −8 is every ~66
  // minutes per table. ALERT_DEPTHS='andreas=N' tunes it without a code change.
  { id: 'andreas', label: 'Andreas Deluxe', side: 'C', kind: 'streak', group: 'C', deepensOn: 'out',
    needs: 'every spin outside Group C deepens it · any Group C number resets it',
    alertDepth: 8 },
];

export const READING_IDS = READINGS.map((r) => r.id);
const RULES = new Map(READINGS.map((r) => [r.id, r]));

// The two readings this app tracked before the other eight existed were the All in
// pair, as variant 1 and 2. Callers (and stored test vectors) may still say 1 or 2.
const ALIAS = { 1: 'allin1', 2: 'allin2' };

function rulesFor(reading) {
  const id = ALIAS[reading] || reading;
  const r = RULES.get(id);
  if (!r) throw new RangeError('unknown reading: ' + JSON.stringify(reading));
  return r;
}

export function createState() {
  return {
    count: 0,
    phase: PHASE.BUILDING,
    runGroup: null,
    runLength: 0,
    originGroup: null,
    // derived figures that cannot be recovered afterwards (§3)
    deepest: 0,
    resets: 0,
    spinsObserved: 0,
  };
}

// §5 — the whole of the pattern logic, for every reading. Returns { state, event };
// the input state is not mutated.
export function applySpin(prev, n, reading) {
  const g = groupOf(n);
  const rules = rulesFor(reading);
  const s = { ...prev };
  let event = EVENT.NONE;

  // A streak reading counts spins on one side of a membership, and nothing else: no run
  // to build, nothing to arm, no decider. It shares the state shape so every reading can
  // be stored, projected and displayed the same way.
  if (rules.kind === 'streak') {
    const member = inGroup(rules.group, n);
    const deepens = rules.deepensOn === 'in' ? member : !member;
    if (deepens) {
      s.count -= 1;
      s.runLength = -s.count;     // the current streak, for display
      event = EVENT.COUNT;
    } else {
      // only a standing count is a reset; breaking a streak of nothing is an ordinary
      // spin, and counting it would make the resets figure meaningless
      if (s.count < 0) { s.resets += 1; event = EVENT.RESET; }
      s.count = 0;
      s.runLength = 0;
    }
    s.phase = PHASE.BUILDING;
    s.runGroup = member ? rules.group : null;
    s.originGroup = null;
    if (s.count < s.deepest) s.deepest = s.count;
    return { state: s, event };
  }

  if (s.phase === PHASE.INTERRUPTED) {
    const returned = g === s.originGroup;

    if (!returned && s.runLength + 1 < rules.decideAfter) {
      // Armed, but the interruption is not yet long enough to be decided: it simply
      // lengthens and stays armed. Only the two Ena/Duo readings reach this.
      s.runLength += 1;
      event = EVENT.ARMED;
    } else {
      const deepens = rules.deepensOnReturn ? returned : !returned;

      if (deepens) { s.count -= 1; event = EVENT.COUNT; }
      else { s.count = 0; s.resets += 1; event = EVENT.RESET; }

      s.phase = PHASE.BUILDING;
      s.runGroup = g;
      // §5 the carry: the group that returned stands alone, the group that carried on
      // has been seen twice. Never depends on the reading.
      s.runLength = returned ? 1 : 2;
      s.originGroup = null;
    }
  } else {
    if (s.runGroup === null) {
      s.runGroup = g; s.runLength = 1;
    } else if (g === s.runGroup) {
      s.runLength += 1;
      // An interruption already under way, now long enough to arm. Only a reading with
      // armAfter > 1 reaches this; for the rest the interrupting spin arms below.
      if (s.originGroup !== null && s.runLength >= rules.armAfter) {
        s.phase = PHASE.INTERRUPTED; event = EVENT.ARMED;
      }
    } else if (s.runLength >= rules.minRunToArm &&
               (rules.armsFrom === null || s.runGroup === rules.armsFrom)) {
      // A qualifying run has been broken. originGroup is set HERE, the moment the run
      // breaks - not when something arms - because for the deeper readings it is what
      // remembers, across a half-built interruption, which group the decider is
      // measured against (§5).
      s.originGroup = s.runGroup;
      s.runGroup = g; s.runLength = 1;
      if (s.runLength >= rules.armAfter) {
        s.phase = PHASE.INTERRUPTED; event = EVENT.ARMED;
      }
    } else {
      // Deadzone - and an interruption that gave up before it armed is deadzone too,
      // not a reset: it fires no event and leaves a standing count exactly where it
      // was (§5, §9).
      s.originGroup = null;
      s.runGroup = g; s.runLength = 1;
    }
  }

  if (s.count < s.deepest) s.deepest = s.count;
  return { state: s, event };
}

// Replay a sequence OLDEST FIRST through a fresh state. Used for tests and for seeding.
export function replay(spins, reading, from = createState()) {
  let state = from;
  const events = [];
  for (const n of spins) {
    const r = applySpin(state, n, reading);
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

const freshReadings = () => {
  const out = {};
  for (const id of READING_IDS) out[id] = { state: createState(), lastEvent: EVENT.NONE };
  return out;
};

// Tracks every reading for many tables across repeated polls.
export class PatternTracker {
  // onSpin({ tableId, meta, n, states, events, observed }) is called once per spin fed
  // through, in order. The paper-betting book uses it to settle and place bets against
  // the same spins the wall shows; `observed` is false for a replay or a re-seed, which
  // must never move money (PATTERNS.md §8.3).
  constructor({ onSpin = null } = {}) {
    this.tables = new Map();
    this.onSpin = onSpin;
  }

  get(id) { return this.tables.get(id) || null; }
  all() { return [...this.tables.values()]; }

  // A feed reconnected, so an unknown number of spins happened while we were away.
  // §8.2 says never carry a count across that gap. We go further than §8.3's optional
  // re-seed and start genuinely clean: the numbers from before the reconnect are
  // dropped, every count goes to 0, and the next window is adopted only as a BASELINE -
  // it is not replayed - so counting begins with spins that arrive after the reconnect.
  markGap(match) {
    let n = 0;
    for (const t of this.tables.values()) {
      if (typeof match === 'function' ? !match(t) : false) continue;
      t.reads = freshReadings();
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
        reads: freshReadings(),
        desynced: false, seeded: false, awaitingBaseline: false,
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
      t.reads = freshReadings();
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

  // Every reading is advanced from this one loop, over the same spins, in the same
  // order (§8.5). observed=false for seeded/replayed spins: they restore the count but
  // must not inflate the statistics (§8.3).
  #feed(t, spinsOldestFirst, observed) {
    for (const s of spinsOldestFirst) {
      const states = {}, events = {};
      for (const id of READING_IDS) {
        const slot = t.reads[id];
        const r = applySpin(slot.state, s.n, id);
        slot.state = r.state;
        slot.lastEvent = r.event;
        if (observed) slot.state.spinsObserved += 1;
        else {
          // keep stats clean on a replay
          slot.state.resets = 0;
          slot.state.spinsObserved = 0;
        }
        states[id] = slot.state;
        events[id] = r.event;
      }
      if (this.onSpin) {
        try {
          this.onSpin({ tableId: t.id, meta: t.meta, n: s.n, states, events, observed });
        } catch {
          // a listener must never break the tracking it is watching
        }
      }
    }
  }
}
