// The paper-betting contract: when it stakes, on what, how much, and when it stops.
// Run: node tools/paper-test.mjs   (npm run test:paper)
import { PaperBook, BETTABLE, DEFAULT_PATTERNS, resetGroup } from '../src/paper.mjs';
import { READINGS, createState, applySpin, groupOf, GROUP_A, GROUP_B } from '../src/patterns.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name + (extra ? '   ' + extra : '')); }
};
const section = (s) => console.log('\n' + s);

const A = 3, B = 4;                       // one number from each group
const rule = (id) => READINGS.find((r) => r.id === id);

// A table that keeps its pattern state between calls, the way the tracker does. The
// first version of this helper rebuilt the state on every call, which quietly reset the
// counts and made half these tests assert nothing.
function table(book, patterns, { tableId = 't1', name = 'Table' } = {}) {
  const state = {};
  for (const id of patterns) state[id] = createState();
  return {
    state,
    run(spins) {
      const events = [];
      for (const n of spins) {
        for (const id of patterns) state[id] = applySpin(state[id], n, id).state;
        events.push(...book.feed(tableId, name, n, state));
      }
      return events;
    },
    // spins that take Monada one step deeper: a fresh A-run, broken, then carried on
    deeper() { return this.run([A, B, B]); },
    // spins that arm Monada and then reset it: our bet lands
    breaks() { return this.run([A, B, A]); },
    cycle(id) { const t = book.tables.get(tableId); return t && t.cycle[id]; },
  };
}

const book = (opts = {}) => new PaperBook({
  budget: 10000, unit: 5, steps: 6, start: true,
  patterns: ['monada', 'allin1'], readings: READINGS,
  depths: { monada: 2, allin1: 2 },       // shallow, so a test sequence can reach them
  ...opts,
});

section('it only bets when told to');
{
  const b = book({ start: false });
  table(b, ['monada']).run([A, B, B, A, B, B, A, B]);
  ok(b.snapshot().totals.bets === 0, 'a stopped book never stakes anything');
  ok(b.cash === 10000, 'and the balance does not move', String(b.cash));
  b.start();
  table(b, ['monada'], { tableId: 't2' }).run([A, B, B, A, B, B, A, B]);
  ok(b.snapshot().totals.bets === 1, 'once started it stakes on the next decider',
    String(b.snapshot().totals.bets));
}
{
  // not deep enough is not a trigger
  const b = book({ depths: { monada: 9 } });
  table(b, ['monada']).run([A, B, B, A, B, B, A, B]);
  ok(b.snapshot().totals.bets === 0, 'a count above the trigger depth is left alone');
}
{
  const b = book({ patterns: ['monada'] });
  ok(!b.isOn('allin1'), 'a pattern not chosen is not simulated');
  table(b, ['monada', 'allin1']).run([A, A, A, B, A, A, A, A, B, A, A, A, A, B]);
  ok(b.snapshot().patterns.length === 1, 'and keeps no figures');
}

section('it triggers at the simulation depth, not the push depth');
{
  const b = new PaperBook({ patterns: ['allin1', 'monada'], readings: READINGS });
  ok(b.depthFor('allin1') === 11, 'All in 1 simulates at −11 while it pushes at −15',
    String(b.depthFor('allin1')));
  ok(b.depthFor('monada') === 12, 'Monada simulates at −12 while it pushes at −14',
    String(b.depthFor('monada')));
  ok(b.depthFor('enaduo') === 6, 'Ena/Duo uses −6 for both', String(b.depthFor('enaduo')));
  const tuned = new PaperBook({ patterns: ['monada'], readings: READINGS, depths: { monada: 3 } });
  ok(tuned.depthFor('monada') === 3, 'SIM_DEPTHS overrides it', String(tuned.depthFor('monada')));
}

section('what it bets on');
{
  // Monada deepens when the interrupter carries on, so the reset - what we bet - is the
  // ORIGIN group coming back.
  const b = book({ patterns: ['monada'] });
  const events = table(b, ['monada']).run([A, B, B, A, B, B, A, B]);
  const placed = events.find((e) => e.placed);
  ok(placed && placed.group === 'A', 'Monada bets on group A, the origin group',
    placed && placed.group);
  ok(placed && placed.total === 5 * GROUP_A.length, 'staking the unit on each of its 18 numbers',
    placed && String(placed.total));
}
{
  // All in 1 is the other way round: it deepens on the return, so the reset is the
  // INTERRUPTING group carrying on.
  const b = book({ patterns: ['allin1'] });
  const events = table(b, ['allin1']).run([A, A, A, B, A, A, A, A, B, A, A, A, A, B]);
  const placed = events.find((e) => e.placed);
  ok(placed && placed.group === 'B', 'All in 1 bets on the interrupting group',
    placed && placed.group);
  ok(placed && placed.total === 5 * GROUP_B.length, 'that one is 19 numbers',
    placed && String(placed.total));
}
{
  // the rule itself, independent of any sequence
  // armed, as a run reading is when its decider is pending
  const st = { phase: 'INTERRUPTED', runGroup: 'B', originGroup: 'A' };
  ok(resetGroup(rule('allin1'), st) === 'B', 'All in 1 resets when B carries on');
  ok(resetGroup(rule('monada'), st) === 'A', 'Monada resets when A returns');
  // a streak reading is broken by its own group, whatever the state
  ok(resetGroup(rule('andreas'), { phase: 'BUILDING' }) === 'C',
    'Andreas Deluxe is broken by a group-C number');
  ok(BETTABLE.includes('andreas'), 'and is bettable, because it has a stake plan');
  ok(!BETTABLE.includes('serie1') && !BETTABLE.includes('serie2'),
    'Serie has neither a decider nor a plan, so it stays out', BETTABLE.join(','));
}

section('the money');
{
  // 18 numbers: 36b returned against 18b staked is exactly double, so a completed
  // sequence nets the opening stake whatever step it lands on.
  for (const step of [1, 3, 6]) {
    const b = book({ patterns: ['monada'] });
    const t = table(b, ['monada']);
    t.run([A, B, B, A, B, B]);                 // to the trigger depth
    for (let i = 1; i < step; i++) t.deeper(); // lose (step-1) deciders
    // before the first bet there is no cycle object yet, which is step 1 by definition
    const atStep = t.cycle('monada');
    ok((atStep ? atStep.step : 1) === step, 'sequence is at step ' + step,
      JSON.stringify(atStep));
    t.breaks();                                // armed, then the origin group returns
    const net = b.cash - 10000;
    ok(net === 90, 'a sequence won at step ' + step + ' nets $90 on 18 numbers', String(net));
    ok(b.snapshot().patterns[0].winsAtStep[step - 1] === 1, 'recorded at that step',
      JSON.stringify(b.snapshot().patterns[0].winsAtStep));
  }
}
{
  // 19 numbers: 36b against 19b staked is less than double, so the progression does not
  // recover. The winning SPIN still pays; it is the sequence that ends down.
  const b = book({ patterns: ['allin1'] });
  const states = { allin1: { phase: 'INTERRUPTED', count: -9, runGroup: 'B', originGroup: 'A' } };
  b.feed('t', 'T', A, states);                 // places step 1 (19 numbers of B)
  let spent = 10000 - b.cash;
  for (let step = 2; step <= 5; step++) {      // four losses: an A arrives each time
    b.feed('t', 'T', A, states);
    spent = 10000 - b.cash;
  }
  const beforeWin = b.cash;
  b.feed('t', 'T', B, states);                 // step 5 lands: a group-B number
  const spinGain = b.cash - beforeWin + 0;     // return minus the next stake placed
  ok(spent === (5 + 10 + 20 + 40 + 80) * 19, 'five steps stake the whole progression',
    String(spent));
  const sequenceNet = b.cash - 10000;
  ok(sequenceNet < 0, 'a step-5 win on 19 numbers still leaves the sequence down',
    String(sequenceNet));
  ok(sequenceNet === 95 - 2 * 80, 'by exactly 95 - 2x the stake', String(sequenceNet));
}

section('many tables at once, but the doubling is per table');
{
  // Several roulettes can be in play together. The progression belongs to ONE table: a
  // loss there doubles the next bet there, and never touches another table's sequence.
  const b = book({ patterns: ['monada'] });
  const x = table(b, ['monada'], { tableId: 'x', name: 'Wheel X' });
  const y = table(b, ['monada'], { tableId: 'y', name: 'Wheel Y' });

  x.run([A, B, B, A, B, B]);          // X to the trigger depth
  y.run([A, B, B, A, B, B]);          // Y likewise
  x.run([A, B]);                      // X stakes step 1
  ok(b.openBets().length === 1 && b.openBets()[0].per === 5, 'X opens at $5 a number',
    JSON.stringify(b.openBets()));
  x.run([B]);                         // that decider deepens X: a loss
  ok(x.cycle('monada').step === 2, 'X is now at step 2', JSON.stringify(x.cycle('monada')));

  y.run([A, B]);                      // Y stakes - its own first step, not X's second
  const yBet = b.openBets().find((o) => o.tableId === 'y');
  ok(yBet && yBet.step === 1 && yBet.per === 5, 'Y opens at step 1, $5 a number',
    JSON.stringify(yBet));

  x.run([A, B]);                      // X stakes step 2
  const xBet = b.openBets().find((o) => o.tableId === 'x');
  ok(xBet && xBet.step === 2 && xBet.per === 10, 'X doubles to $10 a number on ITS table',
    JSON.stringify(xBet));
  ok(b.openBets().length === 2, 'both tables are in play at the same time',
    String(b.openBets().length));
  ok(b.snapshot().atRisk === 90 + 180, 'with both stakes at risk',
    String(b.snapshot().atRisk));

  // and a win on one leaves the other's sequence exactly where it was
  y.run([A]);                         // Y's decider returns: Y wins
  ok(b.snapshot().totals.wins === 1, 'Y won');
  ok(x.cycle('monada').step === 2 || b.openBets().some((o) => o.tableId === 'x'),
    'X carries on at its own step', JSON.stringify(x.cycle('monada')));
}
{
  // six is the cap per table, counted per table
  const b = book({ patterns: ['monada'] });
  const x = table(b, ['monada'], { tableId: 'x' });
  const y = table(b, ['monada'], { tableId: 'y' });
  x.run([A, B, B, A, B, B]);
  y.run([A, B, B, A, B, B]);
  for (let i = 0; i < 6; i++) x.deeper();        // X loses all six
  for (let i = 0; i < 3; i++) y.deeper();        // Y is three in
  const s = b.snapshot();
  ok(s.totals.losses === 1, 'X lost its sequence', JSON.stringify(s.totals));
  ok(s.totals.bets === 9, 'six bets on X, three on Y', String(s.totals.bets));
  ok(10000 - b.cash === 315 * 18 + (5 + 10 + 20) * 18, 'each table staked its own ladder',
    String(10000 - b.cash));
}

section('it only plays the tables that were picked');
{
  // The live book is given an allow(table, pattern) gate: the pairs armed for alerts.
  // A pair outside it is never staked, however deep its count gets.
  const picked = new Set(['x|monada']);
  const b = new PaperBook({
    budget: 10000, unit: 5, steps: 4, start: true,
    patterns: ['monada'], readings: READINGS, depths: { monada: 2 },
    allow: (tableId, pattern) => picked.has(tableId + '|' + pattern),
  });
  const x = table(b, ['monada'], { tableId: 'x', name: 'Picked' });
  const y = table(b, ['monada'], { tableId: 'y', name: 'Not picked' });
  x.run([A, B, B, A, B, B]); x.run([A, B]);
  y.run([A, B, B, A, B, B]); y.run([A, B]);
  const open = b.openBets();
  ok(open.length === 1 && open[0].tableId === 'x', 'only the picked table is staked',
    JSON.stringify(open.map((o) => o.tableId)));
  ok(b.snapshot().totals.bets === 1, 'and the other table costs nothing',
    String(b.snapshot().totals.bets));

  // settlement is never gated: a bet already on the table resolves even if the pick goes
  picked.clear();
  x.run([A]);                                   // the decider arrives: our bet lands
  ok(b.snapshot().totals.wins === 1, 'an open bet still settles after the pick is removed',
    JSON.stringify(b.snapshot().totals));
  ok(b.openBets().length === 0, 'leaving nothing open');
  // and nothing new is staked now
  x.run([A, B, B, A, B]);
  ok(b.snapshot().totals.bets === 1, 'with no new bets once it is unpicked',
    String(b.snapshot().totals.bets));
}
{
  // four steps is the default ladder now
  const d = new PaperBook({ patterns: ['monada'], readings: READINGS });
  ok(d.steps === 4, 'the default is four steps', String(d.steps));
  ok(d.snapshot().stakes.join() === '5,10,20,40', 'staking 5/10/20/40 a number',
    d.snapshot().stakes.join());
  ok(d.sequenceRisk(18) === 75 * 18 && d.sequenceRisk(19) === 75 * 19,
    'so a full sequence risks $1,350 / $1,425',
    d.sequenceRisk(18) + '/' + d.sequenceRisk(19));
}
{
  // a sequence lost over four steps costs the four stakes, and no more
  const b = new PaperBook({ budget: 10000, unit: 5, steps: 4, start: true,
    patterns: ['monada'], readings: READINGS, depths: { monada: 2 } });
  const t = table(b, ['monada']);
  t.run([A, B, B, A, B, B]);
  for (let i = 0; i < 4; i++) t.deeper();
  ok(b.snapshot().totals.losses === 1 && b.snapshot().totals.bets === 4,
    'four bets, then the sequence is over', JSON.stringify(b.snapshot().totals));
  ok(10000 - b.cash === 75 * 18, 'having staked $1,350', String(10000 - b.cash));
}

section('Andreas Deluxe: every spin, its own stake');
{
  const C = 0, NC = 1;                  // 0 is in group C, 1 is not
  const b = new PaperBook({ budget: 10000, start: true, patterns: ['andreas'], readings: READINGS });
  ok(BETTABLE.includes('andreas'), 'it is bettable');
  ok(DEFAULT_PATTERNS.includes('andreas'), 'and simulated by default');
  const plan = b.planFor('andreas');
  ok(plan.unit === 2 && plan.steps === 4 && plan.everySpin === true,
    '$2 a number, four steps, every spin', JSON.stringify(plan));

  const t = table(b, ['andreas'], { tableId: 'speed', name: 'Speed Roulette 1' });
  // the first spin stakes for the next one: $2 on each of the 15 group-C numbers
  t.run([NC]);
  const open1 = b.openBets();
  ok(open1.length === 1 && open1[0].group === 'C' && open1[0].numbers === 15,
    'it bets the 15 group-C numbers', JSON.stringify(open1[0]));
  ok(open1[0].per === 2 && open1[0].total === 30, '$2 each, $30 a spin', JSON.stringify(open1[0]));

  // a miss doubles, with no count depth to wait for
  t.run([NC]);
  const open2 = b.openBets();
  ok(open2[0].step === 2 && open2[0].per === 4 && open2[0].total === 60,
    'a miss doubles to $4 a number', JSON.stringify(open2[0]));
  ok(b.snapshot().totals.bets === 2, 'and it bet on both spins', String(b.snapshot().totals.bets));

  // a group-C number pays 36x the stake on that number and resets the ladder
  const before = b.cash;
  t.run([C]);
  ok(b.cash - before === 36 * 4 - 30, 'a hit at step 2 returns 36x$4 less the next stake',
    String(b.cash - before));
  const open3 = b.openBets();
  ok(open3[0].step === 1 && open3[0].per === 2,
    'and the next spin is back to the base stake', JSON.stringify(open3[0]));
  ok(b.snapshot().totals.wins === 1, 'the win is recorded');
}
{
  const C = 0, NC = 1;
  const b = new PaperBook({ budget: 10000, start: true, patterns: ['andreas'], readings: READINGS });
  const t = table(b, ['andreas'], { tableId: 'speed', name: 'Speed Roulette 1' });
  // four misses in a row lose the whole ladder, then it starts again rather than stopping
  t.run([NC, NC, NC, NC, NC]);
  const s = b.snapshot();
  ok(s.totals.losses === 1, 'four misses lose the ladder', JSON.stringify(s.totals));
  ok(10000 - b.cash === (2 + 4 + 8 + 16) * 15 + 30,
    'costing $450, with $30 already staked on the next spin', String(10000 - b.cash));
  const open = b.openBets();
  ok(open.length === 1 && open[0].step === 1,
    'it keeps playing at the base stake - a table is never finished with',
    JSON.stringify(open[0]));
}
{
  // it plays only the tables picked for it
  const C = 0, NC = 1;
  const b = new PaperBook({
    budget: 10000, start: true, patterns: ['andreas'], readings: READINGS,
    allow: (tableId) => tableId === 'speed',
  });
  table(b, ['andreas'], { tableId: 'speed', name: 'Speed Roulette 1' }).run([NC, NC]);
  table(b, ['andreas'], { tableId: 'other', name: 'Another wheel' }).run([NC, NC]);
  const open = b.openBets();
  ok(open.length === 1 && open[0].table === 'Speed Roulette 1',
    'only the picked wheel is played', JSON.stringify(open.map((o) => o.table)));
}
{
  // the run readings are untouched by all this
  const b = new PaperBook({ budget: 10000, start: true, patterns: ['monada'], readings: READINGS,
    depths: { monada: 2 } });
  const plan = b.planFor('monada');
  ok(plan.unit === 5 && plan.steps === 4 && plan.everySpin === false,
    'Monada still stakes $5 on a decider', JSON.stringify(plan));
  const t = table(b, ['monada']);
  t.run([A, B]);                       // armed but nowhere near the depth
  ok(b.openBets().length === 0, 'and waits for its count, not every spin');
}

section('when it stops');
{
  const b = book({ patterns: ['monada'] });
  const t = table(b, ['monada']);
  t.run([A, B, B, A, B, B]);
  t.breaks();                                  // triggers and wins
  const bets = b.snapshot().totals.bets;
  ok(b.snapshot().totals.wins === 1, 'the win is recorded');
  t.run([A, B, B, A, B, A, B, A]);
  ok(b.snapshot().totals.bets === bets, 'and that table is finished with - no more bets',
    b.snapshot().totals.bets + ' vs ' + bets);
  const other = table(b, ['monada'], { tableId: 'other', name: 'Other' });
  other.run([A, B, B, A, B, B]);
  other.run([A, B]);
  ok(b.snapshot().totals.bets === bets + 1, 'another table still trades',
    String(b.snapshot().totals.bets));
}
{
  // six losses end the sequence, and cost the whole progression
  const b = book({ patterns: ['monada'] });
  const t = table(b, ['monada']);
  t.run([A, B, B, A, B, B]);
  for (let i = 0; i < 6; i++) t.deeper();
  const s = b.snapshot();
  ok(s.totals.losses === 1, 'the lost sequence is recorded', JSON.stringify(s.totals));
  ok(s.totals.bets === 6, 'after exactly six bets', String(s.totals.bets));
  ok(10000 - b.cash === 315 * 18, 'having staked the whole progression',
    String(10000 - b.cash));
  t.run([A, B, B, A, B, B]);
  t.run([A, B]);
  ok(b.snapshot().totals.bets === 6, 'and the table is done', String(b.snapshot().totals.bets));
}
{
  // it will not stake what it cannot cover
  const b = book({ patterns: ['monada'], budget: 100 });
  const t = table(b, ['monada']);
  t.run([A, B, B, A, B, B]);
  t.run([A, B]);                               // arms: stakes $90 of the $100
  ok(b.snapshot().totals.bets === 1, 'the first bet fits in $100',
    JSON.stringify(b.snapshot().totals));
  t.run([B]);                                  // that decider deepens: we lose
  t.run([A, B]);                               // arms again; step 2 needs $180
  ok(b.snapshot().totals.skipped === 1, 'the next step does not, and is skipped',
    JSON.stringify(b.snapshot().totals));
  ok(b.cash >= 0, 'the balance never goes negative', String(b.cash));
}

section('voiding and switching patterns');
{
  const b = book({ patterns: ['monada'] });
  const t = table(b, ['monada']);
  t.run([A, B, B, A, B, B]);
  t.run([A, B]);
  ok(b.openBets().length === 1, 'a bet is open');
  const staked = 10000 - b.cash;
  const back = b.voidTable('t1');
  ok(back === staked && b.cash === 10000, 'voiding a desynced table refunds it',
    'refunded ' + back);
  ok(b.openBets().length === 0, 'and closes the bet');
}
{
  const b = book({ patterns: ['monada', 'allin1'] });
  const t = table(b, ['monada', 'allin1']);
  t.run([A, B, B, A, B, B]);
  t.run([A, B]);
  ok(b.openBets().length === 1, 'a Monada bet is open', JSON.stringify(b.openBets()));
  b.togglePattern('monada', false);
  ok(b.cash === 10000, 'switching a pattern off refunds what it had staked', String(b.cash));
  ok(!b.isOn('monada') && b.isOn('allin1'), 'and leaves the others alone');
  b.togglePattern('monada', true);
  ok(b.isOn('monada') && b.patterns.length === 2, 'switching it back on restores it');
}

section('the ledger survives a restart');
{
  const b = book({ patterns: ['monada'] });
  const t = table(b, ['monada']);
  t.run([A, B, B, A, B, B]);
  t.breaks();                                  // a completed win
  const saved = JSON.parse(JSON.stringify(b.toJSON()));
  const b2 = book({ patterns: ['monada'], start: false });
  b2.load(saved);
  ok(b2.cash === b.cash, 'the balance comes back', b2.cash + ' vs ' + b.cash);
  ok(b2.snapshot().totals.wins === 1, 'and the figures');
  ok(b2.running === true, 'and whether it was running');
  ok(b2.openBets().length === 0, 'open bets are not restored - their spin has been and gone');
}
{
  // a ledger saved under different stakes is not comparable, so only the switch carries
  const b = book({ patterns: ['monada'] });
  const t = table(b, ['monada']);
  t.run([A, B, B, A, B, B]);
  t.breaks();
  const other = new PaperBook({ budget: 500, unit: 1, steps: 3, patterns: ['monada'], readings: READINGS });
  other.load(b.toJSON());
  ok(other.cash === 500, 'a ledger from other stakes is ignored', String(other.cash));
}

section('the snapshot the page draws');
{
  const b = book({ patterns: ['monada'] });
  const t = table(b, ['monada']);
  t.run([A, B, B, A, B, B]);
  t.run([A, B]);
  const s = b.snapshot();
  ok(s.running === true && s.budget === 10000, 'it reports the basics');
  ok(s.atRisk === 90 && s.equity === s.cash + 90, 'money on the table counts as equity',
    JSON.stringify({ atRisk: s.atRisk, cash: s.cash, equity: s.equity }));
  ok(s.stakes.join() === '5,10,20,40,80,160', 'the progression is stated', s.stakes.join());
  ok(s.risk18 === 315 * 18 && s.risk19 === 315 * 19, 'and what a full sequence risks',
    s.risk18 + '/' + s.risk19);
  ok(s.open[0] && s.open[0].numbers === 18, 'open bets say how many numbers',
    JSON.stringify(s.open[0]));
  ok(Array.isArray(s.curve) && s.curve.length >= 1, 'and there is a balance curve');
  ok(s.patterns[0].depth === 2, 'with the depth each pattern is triggering at',
    String(s.patterns[0].depth));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
