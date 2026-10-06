// Monte Carlo for the paper-betting strategy.
//
//   npm run sim                                  the defaults below
//   npm run sim -- --runs 200 --spins 20160
//   npm run sim -- --patterns allin1,monada --mode per
//   npm run sim -- --replay spins.txt            real spins instead of a simulated wheel
//
// The strategy itself lives in src/paper.mjs and is the same code the server runs live on
// /sim: this tool only supplies spins and aggregates. A second copy of the rules would
// eventually disagree with the live one about what was bet and why.
//
//   * A pattern's alert depth is the trigger (All in 1 at -11, Monada at -12, ...).
//   * Then bet on the count BREAKING: `unit` on every number of the group that resets it.
//   * Double on a loss - 5/10/20/40 per number - and stop at a win, or after the fourth.
//
// WHAT TO EXPECT, before reading the output
//
// A straight-up number pays 35 to 1, so `b` on each of 18 numbers returns 36b against
// 18b staked: exactly double, which is what lets doubling recover a loss. On 19 numbers
// it returns 36b against 19b, so the progression no longer recovers - the deeper the step
// the worse a win is. Either way the wheel is memoryless, so no trigger changes what a spin
// pays; the house edge is 1/37 of everything staked. This run shows the SHAPE of that:
// how often a sequence completes, how deep it digs, and how often the budget is gone.

import fs from 'node:fs';
import { READINGS, createState, applySpin } from '../src/patterns.mjs';
import { PaperBook, BETTABLE } from '../src/paper.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : argv[i + 1];
};

const CFG = {
  budget: Number(flag('budget', 10000)),
  unit: Number(flag('unit', 5)),
  steps: Number(flag('steps', 4)),
  tables: Number(flag('tables', 33)),
  spins: Number(flag('spins', 10080)),     // a week at one spin a minute
  runs: Number(flag('runs', 60)),
  seed: Number(flag('seed', 20261006)),
  mode: flag('mode', 'both'),              // per | combined | both
  afterWin: flag('after-win', 'stop'),
  afterLoss: flag('after-loss', 'stop'),
  replay: flag('replay', null),
  patterns: String(flag('patterns',
    'allin1,allin2,monada,monada2,diada,diada2,triada,triada2,enaduo,enaduo2'))
    .split(',').map((s) => s.trim()).filter(Boolean),
  depths: {},
};
for (const pair of String(flag('depths', '')).split(',').filter(Boolean)) {
  const [id, n] = pair.split('=');
  if (id && Number(n) > 0) CFG.depths[id.trim()] = Number(n);
}
for (const id of CFG.patterns) {
  if (!BETTABLE.includes(id)) {
    console.error('cannot bet pattern: ' + id + '\nbettable: ' + BETTABLE.join(', '));
    process.exit(1);
  }
}
const LABEL = new Map(READINGS.map((r) => [r.id, r.label]));

// mulberry32: a weak generator's low bits would skew the group split, which is exactly
// what every pattern here turns on.
function wheel(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * 37) | 0;
  };
}

const REPLAY = CFG.replay ? (() => {
  const nums = fs.readFileSync(CFG.replay, 'utf8').split(/[^0-9]+/)
    .filter((x) => x !== '').map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 36);
  if (!nums.length) { console.error('no spins found in ' + CFG.replay); process.exit(1); }
  return nums;
})() : null;

const newBook = (patterns) => new PaperBook({
  budget: CFG.budget, unit: CFG.unit, steps: CFG.steps,
  afterWin: CFG.afterWin, afterLoss: CFG.afterLoss,
  depths: CFG.depths, patterns, readings: READINGS, start: true,
  historyLimit: 1, curveLimit: 2,          // the aggregate is what matters here
});

// One run: every table played in turn, through the live strategy class.
function play(patterns, seed) {
  const book = newBook(patterns);
  const next = CFG.replay ? null : wheel(seed);
  for (let t = 0; t < CFG.tables; t++) {
    const spins = CFG.replay ? REPLAY : Array.from({ length: CFG.spins }, next);
    const state = {};
    for (const id of patterns) state[id] = createState();
    const tableId = 'table-' + t;
    for (const n of spins) {
      for (const id of patterns) state[id] = applySpin(state[id], n, id).state;
      book.feed(tableId, tableId, n, state);
    }
  }
  return book;
}

const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const pct = (n) => (n * 100).toFixed(1) + '%';
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stakes = Array.from({ length: CFG.steps }, (_, i) => CFG.unit * 2 ** i);
const seqTotal = stakes.reduce((a, b) => a + b, 0);

console.log('');
console.log('Paper betting, Monte Carlo — ' + (CFG.replay
  ? 'replaying ' + REPLAY.length + ' real spins from ' + CFG.replay + ' on ' + CFG.tables + ' tables'
  : 'fair single-zero wheel, ' + CFG.tables + ' tables x ' + CFG.spins.toLocaleString('en-US') +
    ' spins x ' + CFG.runs + ' runs'));
console.log('budget ' + money(CFG.budget) + ' · ' + money(CFG.unit) + ' per number · ' +
  stakes.join('/') + ' · stop after a win' + (CFG.afterLoss === 'stop' ? ' or a full loss' : '') +
  ' on a table');
console.log('a full sequence risks ' + money(seqTotal * 18) + ' (18 numbers) / ' +
  money(seqTotal * 19) + ' (19 numbers)');
console.log('');

if (CFG.mode === 'per' || CFG.mode === 'both') {
  console.log('EACH PATTERN ON ITS OWN ' + money(CFG.budget) + ', per run:');
  console.log('');
  console.log('  pattern       at   sequences   won    median P/L    mean P/L    worst run   in profit  busted');
  for (const id of CFG.patterns) {
    const nets = [], lows = [];
    let seq = 0, wins = 0, losses = 0, staked = 0, returned = 0;
    for (let r = 0; r < CFG.runs; r++) {
      const book = play([id], CFG.seed + r * 7919);
      const s = book.snapshot({ history: 0 });
      const p = s.patterns[0];
      seq += p.sequences; wins += p.wins; losses += p.losses;
      staked += p.staked; returned += p.returned;
      nets.push(s.pnl);
      lows.push(s.low);
    }
    const settled = wins + losses;
    console.log('  ' + (LABEL.get(id) || id).padEnd(12) +
      ('-' + (CFG.depths[id] || READINGS.find((r) => r.id === id).alertDepth)).padStart(4) + '  ' +
      (seq / CFG.runs).toFixed(1).padStart(9) + '  ' +
      (settled ? pct(wins / settled) : '—').padStart(6) + '  ' +
      money(median(nets)).padStart(11) + '  ' +
      money(nets.reduce((a, b) => a + b, 0) / nets.length).padStart(10) + '  ' +
      money(Math.min(...nets)).padStart(11) + '  ' +
      pct(nets.filter((n) => n > 0).length / nets.length).padStart(9) + '  ' +
      pct(lows.filter((l) => l < stakes[0] * 18).length / lows.length).padStart(6));
  }
  console.log('');
}

if (CFG.mode === 'combined' || CFG.mode === 'both') {
  const nets = [], lows = [], ends = [];
  let seq = 0, wins = 0, losses = 0, skipped = 0, bets = 0, staked = 0;
  for (let r = 0; r < CFG.runs; r++) {
    const book = play(CFG.patterns, CFG.seed + r * 104729);
    const s = book.snapshot({ history: 0 });
    seq += s.totals.sequences; wins += s.totals.wins; losses += s.totals.losses;
    skipped += s.totals.skipped; bets += s.totals.bets; staked += s.totals.staked;
    nets.push(s.pnl); lows.push(s.low); ends.push(s.cash);
  }
  const settled = wins + losses;
  console.log('ALL ' + CFG.patterns.length + ' PATTERNS ON ONE ' + money(CFG.budget) + ' BUDGET, per run:');
  console.log('');
  console.log('  sequences played   ' + (seq / CFG.runs).toFixed(0) + '   (' +
    (bets / CFG.runs).toFixed(0) + ' bets, ' + money(staked / CFG.runs) + ' staked)');
  console.log('  sequences won      ' + (settled ? pct(wins / settled) : '—') + '   (' +
    (losses / CFG.runs).toFixed(1) + ' lost all ' + CFG.steps + ' steps per run)');
  console.log('  could not cover    ' + (skipped / CFG.runs).toFixed(1) + ' sequences');
  console.log('');
  console.log('  median P/L         ' + money(median(nets)));
  console.log('  mean P/L           ' + money(nets.reduce((a, b) => a + b, 0) / nets.length));
  console.log('  best / worst run   ' + money(Math.max(...nets)) + ' / ' + money(Math.min(...nets)));
  console.log('  lowest point       ' + money(median(lows)) + ' (median), ' + money(Math.min(...lows)) + ' (worst)');
  console.log('  runs in profit     ' + pct(nets.filter((n) => n > 0).length / nets.length));
  console.log('  budget gone        ' + pct(ends.filter((c) => c < stakes[0] * 18).length / ends.length));
  console.log('');
}

console.log('THE ARITHMETIC, one sequence:');
console.log('');
for (const size of [18, 19]) {
  const miss = (37 - size) / 37;
  const pAll = miss ** CFG.steps;
  let ev = -pAll * seqTotal * size;
  for (let k = 1; k <= CFG.steps; k++) {
    const pWin = miss ** (k - 1) * (size / 37);
    const spent = stakes.slice(0, k).reduce((a, b) => a + b, 0) * size;
    ev += pWin * (36 * stakes[k - 1] - spent);
  }
  console.log('  ' + (size + '-number group').padEnd(17) + 'completes ' + pct(1 - pAll) +
    ' of the time, loses all ' + CFG.steps + ' ' + pct(pAll) + ' (' + money(seqTotal * size) + ')');
  console.log('  ' + ' '.repeat(17) + 'expected ' + money(ev) + ' per sequence' +
    (size === 19 ? '   <- 19 numbers cannot recover: a win at step 5 or 6 still loses' : ''));
}
console.log('');
console.log('The wheel has no memory: the trigger changes WHEN you bet, never what the bet');
console.log('is worth. Over enough sequences the edge is 1/37 of everything staked.');
console.log('');
