// Paper betting on the patterns: the strategy, with no money and no I/O.
//
// One implementation, two users: the live book the server runs against real spins
// (toggled on and off from /sim), and tools/bet-sim.mjs, which drives the same class over
// a simulated wheel for a Monte Carlo. A second copy of these rules would eventually
// disagree with the first about what was bet and why.
//
// THE RULES, as asked for:
//
//   * A pattern's alert depth is the trigger (All in 1 at −11, Monada at −12, …).
//   * From then on, bet on the pattern BREAKING: `unit` on every number of the group
//     whose arrival resets the count, on each deciding spin.
//   * A loss doubles: 5, 10, 20, 40, 80, 160 per number - six steps.
//   * A win ends the sequence on that table. Six losses end it too.
//
// Which group resets a count is the reading's own rule, not a choice. For the All in pair
// the count deepens when the original group returns, so the reset is the interrupting
// group carrying on; for every other reading it is the original group coming back. Streak
// readings (Serie, Andreas Deluxe) have no decider to bet into and are skipped.
//
// A straight-up number pays 35 to 1, so `b` on each of |G| numbers returns 36b when one
// lands. On an 18-number group that is double the 18b staked, which is what makes
// doubling recover exactly. On a 19-number group it is less than double, so a win at step
// 5 or 6 still loses money - the book records that rather than hiding it.

import { READINGS, GROUP_A, GROUP_B, PHASE, groupOf } from './patterns.mjs';

const A_SET = new Set(GROUP_A);
const SIZE = { A: GROUP_A.length, B: GROUP_B.length };

// The readings this strategy CAN bet: the ones with a decider. The streak readings
// (Serie, Andreas Deluxe) have none - nothing arms, so there is no single spin to bet
// into - and are excluded everywhere.
export const BETTABLE = READINGS.filter((r) => r.kind !== 'streak').map((r) => r.id);

// What the simulation bets unless told otherwise: the ten asked for. Tetrada and Pentada
// are bettable and can be switched on from /sim, but they are not on by default.
export const DEFAULT_PATTERNS = [
  'allin1', 'allin2', 'monada', 'monada2', 'diada', 'diada2',
  'triada', 'triada2', 'enaduo', 'enaduo2',
].filter((id) => BETTABLE.includes(id));

export const DEFAULTS = {
  budget: 10000,
  unit: 5,
  steps: 6,
  afterWin: 'stop',      // stop | continue  (per table, per pattern)
  afterLoss: 'stop',
  patterns: DEFAULT_PATTERNS,
};

// Which group's arrival RESETS this count - what we are betting on.
export function resetGroup(rule, state) {
  if (!rule || rule.kind === 'streak') return null;
  return rule.deepensOnReturn ? state.runGroup : state.originGroup;
}

const blankPattern = (steps) => ({
  sequences: 0, wins: 0, losses: 0, skipped: 0, bets: 0,
  staked: 0, returned: 0, winsAtStep: Array(steps).fill(0),
});

export class PaperBook {
  constructor(opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    this.budget = cfg.budget;
    this.unit = cfg.unit;
    this.steps = cfg.steps;
    this.afterWin = cfg.afterWin;
    this.afterLoss = cfg.afterLoss;
    this.depths = cfg.depths || {};
    this.rules = new Map((cfg.readings || READINGS).map((r) => [r.id, r]));
    this.patterns = (cfg.patterns || BETTABLE).filter((id) => {
      const r = this.rules.get(id);
      return r && r.kind !== 'streak';
    });
    this.historyLimit = cfg.historyLimit || 120;
    this.spinsLimit = cfg.spinsLimit || 150;
    this.curveLimit = cfg.curveLimit || 400;
    this.running = !!cfg.start;
    this.reset({ keepRunning: true });
  }

  // stake per number at a step (1-based)
  stakeAt(step) { return this.unit * 2 ** (step - 1); }
  // what a whole failed sequence costs on a group of that size
  sequenceRisk(size) {
    let total = 0;
    for (let k = 1; k <= this.steps; k++) total += this.stakeAt(k) * size;
    return total;
  }
  depthFor(id) {
    const r = this.rules.get(id);
    return this.depths[id] || (r && r.alertDepth) || 4;
  }

  reset({ keepRunning = false } = {}) {
    this.cash = this.budget;
    this.low = this.budget;
    this.peak = this.budget;
    this.startedAt = Date.now();
    this.spinsSeen = 0;
    this.byPattern = {};
    for (const id of this.patterns) this.byPattern[id] = blankPattern(this.steps);
    this.tables = new Map();      // tableId -> { name, cycles: { [pattern]: … } }
    this.history = [];            // newest first, settled bets
    // The spins this book actually played: every spin where it staked or settled
    // something, newest first, each with the few spins that preceded it on that table so
    // the decision can be read back in context.
    this.spins = [];
    this.curve = [{ at: Date.now(), cash: this.budget }];
    if (!keepRunning) this.running = false;
  }

  start() { this.running = true; }
  stop() { this.running = false; }

  // Which patterns the simulation bets. Changing the set keeps the figures for the ones
  // that stay, starts the newcomers at zero, and voids anything staked on a pattern that
  // has just been switched off - its sequence will never be settled now.
  setPatterns(ids) {
    const want = (ids || []).filter((id) => {
      const r = this.rules.get(id);
      return r && r.kind !== 'streak';
    });
    const dropped = this.patterns.filter((id) => !want.includes(id));
    for (const t of this.tables.values()) {
      for (const id of dropped) {
        const bet = t.pending[id];
        if (bet) {
          this.cash += bet.total;                 // never resolved, so never lost
          this.byPattern[id].staked -= bet.total;
          this.byPattern[id].bets -= 1;
          t.pending[id] = null;
        }
        t.cycle[id] = null;
      }
    }
    this.patterns = want;
    for (const id of want) if (!this.byPattern[id]) this.byPattern[id] = blankPattern(this.steps);
    return this.patterns;
  }

  isOn(id) { return this.patterns.includes(id); }

  togglePattern(id, on) {
    const want = on === undefined ? !this.isOn(id) : !!on;
    const next = new Set(this.patterns);
    if (want) next.add(id); else next.delete(id);
    // keep them in the order the readings are declared, so the page is stable
    return this.setPatterns([...this.rules.keys()].filter((x) => next.has(x)));
  }

  #table(tableId, name) {
    let t = this.tables.get(tableId);
    if (!t) { t = { name, cycle: {}, pending: {}, recent: [] }; this.tables.set(tableId, t); }
    if (name) t.name = name;
    return t;
  }

  #record(entry) {
    this.history.unshift(entry);
    if (this.history.length > this.historyLimit) this.history.length = this.historyLimit;
    this.curve.push({ at: entry.at, cash: this.cash });
    if (this.curve.length > this.curveLimit) this.curve.shift();
    this.low = Math.min(this.low, this.cash);
    this.peak = Math.max(this.peak, this.cash);
  }

  // One observed spin on one table, with that table's reading states AFTER the spin.
  // `states` is { [readingId]: state }. Returns the settled/placed bets, for logging.
  feed(tableId, tableName, n, states) {
    if (!this.running) return [];
    if (!Number.isInteger(n) || n < 0 || n > 36) return [];
    const t = this.#table(tableId, tableName);
    const out = [];
    this.spinsSeen += 1;

    // 1. settle whatever was staked before this spin
    for (const id of this.patterns) {
      const bet = t.pending[id];
      if (!bet) continue;
      t.pending[id] = null;
      const st = this.byPattern[id];
      const won = bet.group === 'A' ? A_SET.has(n) : !A_SET.has(n);
      const entry = {
        at: Date.now(), tableId, table: t.name, pattern: id,
        label: (this.rules.get(id) || {}).label || id,
        group: bet.group, numbers: SIZE[bet.group], step: bet.step, per: bet.per,
        staked: bet.total, spin: n, won, returned: 0, pnl: -bet.total, cash: 0,
      };
      if (won) {
        const ret = 36 * bet.per;
        this.cash += ret;
        st.returned += ret;
        st.wins += 1;
        st.winsAtStep[bet.step - 1] += 1;
        entry.returned = ret;
        entry.pnl = ret - bet.total;
        t.cycle[id] = this.afterWin === 'stop' ? 'done' : null;
      } else if (bet.step >= this.steps) {
        st.losses += 1;
        t.cycle[id] = this.afterLoss === 'stop' ? 'done' : null;
      } else {
        t.cycle[id] = { step: bet.step + 1 };    // double, wait for the next decider
      }
      entry.cash = this.cash;
      entry.sequenceOver = t.cycle[id] === 'done' || t.cycle[id] === null;
      this.#record(entry);
      out.push(entry);
    }

    // 2. stake on the next decider, where the count is deep enough
    for (const id of this.patterns) {
      if (t.cycle[id] === 'done') continue;
      const s = states && states[id];
      if (!s || s.phase !== PHASE.INTERRUPTED) continue;      // no decider pending
      if (s.count > -this.depthFor(id)) continue;             // not deep enough
      const group = resetGroup(this.rules.get(id), s);
      if (!group) continue;

      const st = this.byPattern[id];
      const step = t.cycle[id] ? t.cycle[id].step : 1;
      const per = this.stakeAt(step);
      const total = per * SIZE[group];
      if (this.cash < total) {                                // cannot cover it
        st.skipped += 1;
        t.cycle[id] = 'done';
        continue;
      }
      if (step === 1) st.sequences += 1;
      this.cash -= total;
      st.staked += total;
      st.bets += 1;
      t.cycle[id] = { step };
      t.pending[id] = { group, per, step, total, placedAt: Date.now() };
      this.low = Math.min(this.low, this.cash);
      out.push({ placed: true, tableId, table: t.name, pattern: id, step, per, total, group });
    }

    // 3. keep the spin itself, with context, when the book did something with it
    t.recent.unshift(n);
    if (t.recent.length > 14) t.recent.length = 14;
    const actions = out.map((e) => (e.placed
      ? { kind: 'placed', pattern: e.pattern, label: (this.rules.get(e.pattern) || {}).label || e.pattern,
        step: e.step, per: e.per, staked: e.total, group: e.group, numbers: SIZE[e.group] }
      : { kind: e.won ? 'won' : 'lost', pattern: e.pattern, label: e.label, step: e.step,
        per: e.per, staked: e.staked, pnl: e.pnl, group: e.group, numbers: e.numbers,
        sequenceOver: e.sequenceOver }));
    if (actions.length) {
      this.spins.unshift({
        at: Date.now(), tableId, table: t.name, spin: n, group: groupOf(n),
        window: t.recent.slice(0, 10), cash: this.cash, actions,
      });
      if (this.spins.length > this.spinsLimit) this.spins.length = this.spinsLimit;
    }
    return out;
  }

  // A table reconnected and its counts were discarded: anything staked on it is void,
  // because the count it was betting against is no longer known to be real.
  voidTable(tableId) {
    const t = this.tables.get(tableId);
    if (!t) return 0;
    let refunded = 0;
    for (const id of this.patterns) {
      const bet = t.pending[id];
      if (!bet) continue;
      this.cash += bet.total;                 // never resolved, so never lost
      refunded += bet.total;
      this.byPattern[id].staked -= bet.total;
      this.byPattern[id].bets -= 1;
      t.pending[id] = null;
      t.cycle[id] = null;
    }
    return refunded;
  }

  openBets() {
    const out = [];
    for (const [tableId, t] of this.tables) {
      for (const id of this.patterns) {
        const bet = t.pending[id];
        if (!bet) continue;
        out.push({
          tableId, table: t.name, pattern: id,
          label: (this.rules.get(id) || {}).label || id,
          group: bet.group, numbers: SIZE[bet.group], step: bet.step,
          per: bet.per, total: bet.total, placedAt: bet.placedAt,
        });
      }
    }
    return out.sort((a, b) => b.placedAt - a.placedAt);
  }

  snapshot({ history = 40, spins = 60 } = {}) {
    const open = this.openBets();
    const atRisk = open.reduce((a, b) => a + b.total, 0);
    const perPattern = this.patterns.map((id) => {
      const s = this.byPattern[id];
      const settled = s.wins + s.losses;
      return {
        pattern: id,
        label: (this.rules.get(id) || {}).label || id,
        depth: this.depthFor(id),
        ...s,
        settled,
        winRate: settled ? s.wins / settled : null,
        pnl: s.returned - s.staked,
      };
    });
    return {
      running: this.running,
      budget: this.budget,
      cash: this.cash,
      atRisk,
      equity: this.cash + atRisk,
      pnl: this.cash + atRisk - this.budget,
      low: this.low,
      peak: this.peak,
      drawdown: this.peak - this.cash,
      startedAt: this.startedAt,
      spinsSeen: this.spinsSeen,
      unit: this.unit,
      steps: this.steps,
      stakes: Array.from({ length: this.steps }, (_, i) => this.stakeAt(i + 1)),
      risk18: this.sequenceRisk(18),
      risk19: this.sequenceRisk(19),
      patterns: perPattern,
      totals: perPattern.reduce((a, p) => ({
        sequences: a.sequences + p.sequences,
        wins: a.wins + p.wins,
        losses: a.losses + p.losses,
        skipped: a.skipped + p.skipped,
        bets: a.bets + p.bets,
        staked: a.staked + p.staked,
        returned: a.returned + p.returned,
      }), { sequences: 0, wins: 0, losses: 0, skipped: 0, bets: 0, staked: 0, returned: 0 }),
      open,
      history: this.history.slice(0, history),
      spins: this.spins.slice(0, spins),
      curve: this.curve,
    };
  }

  // for data/sim.json: enough to carry the ledger across a restart
  toJSON() {
    return {
      running: this.running,
      budget: this.budget, unit: this.unit, steps: this.steps,
      cash: this.cash, low: this.low, peak: this.peak,
      startedAt: this.startedAt, spinsSeen: this.spinsSeen,
      byPattern: this.byPattern,
      history: this.history.slice(0, this.historyLimit),
      spins: this.spins.slice(0, this.spinsLimit),
      curve: this.curve,
    };
  }

  // Restore a saved ledger. Open bets are deliberately NOT restored: the spin that would
  // have settled them happened while the server was down, so the honest thing is to let
  // them lapse rather than guess.
  load(saved) {
    if (!saved || typeof saved !== 'object') return;
    if (saved.budget === this.budget && saved.unit === this.unit && saved.steps === this.steps) {
      if (Number.isFinite(saved.cash)) this.cash = saved.cash;
      if (Number.isFinite(saved.low)) this.low = saved.low;
      if (Number.isFinite(saved.peak)) this.peak = saved.peak;
      if (Number.isFinite(saved.startedAt)) this.startedAt = saved.startedAt;
      if (Number.isFinite(saved.spinsSeen)) this.spinsSeen = saved.spinsSeen;
      if (saved.byPattern) {
        for (const id of this.patterns) {
          if (saved.byPattern[id]) this.byPattern[id] = { ...blankPattern(this.steps), ...saved.byPattern[id] };
        }
      }
      if (Array.isArray(saved.history)) this.history = saved.history.slice(0, this.historyLimit);
      if (Array.isArray(saved.spins)) this.spins = saved.spins.slice(0, this.spinsLimit);
      if (Array.isArray(saved.curve) && saved.curve.length) this.curve = saved.curve.slice(-this.curveLimit);
    }
    this.running = !!saved.running;
  }
}
