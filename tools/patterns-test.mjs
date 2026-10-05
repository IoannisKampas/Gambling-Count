// The acceptance tests from AGENT-BRIEF.md §6, plus the scraper contract from §8.
// Run: node tools/patterns-test.mjs   (npm run test:patterns)
import {
  GROUP_A, GROUP_B, GROUP_C, groupOf, inGroup, createState, applySpin, replay, detectNew,
  EVENT, PHASE, READINGS, READING_IDS,
} from '../src/patterns.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   ' + extra : '')); }
};
const section = (s) => console.log('\n' + s);
const nums = (s) => s.trim().split(/\s+/).map(Number);
// letters -> pockets: any group-A number for A, any group-B number for B
const letters = (s) => [...s.replace(/\s+/g, '')].map((c) => (c === 'A' ? 3 : 4));
const armed = (st) => st.phase === PHASE.INTERRUPTED;

section('§6.1 numeric vectors (All in 1)');
const VECTORS = [
  ['3 6 7 18 0', -1, 'base case; fires on the return spin'],
  ['3 6 7 18 0 3 6 18 0', -2, 'the return spin seeds the next run'],
  ['0 0 0 4 0 4 4 4 0 4', -2, 'blocks run in either direction'],
  ['3 6 7 18 0 1 2 3 18 4', 0, 'two consecutive opposites wipe it'],
  ['3 6 7 18 0 4 1 4 1 3 6 7 18 0', -2, 'chop after a return is deadzone'],
  ['1 2 4 5 5 4', 0, 'a run of 2 never arms'],
  ['3 6 7 8 10 18 0', -1, 'runs longer than 3 qualify, and only once'],
  ['3 6 18 0 3 6 18 0', -1, 'the pivot seeds a fresh run'],
];
for (const [seq, want, note] of VECTORS) {
  const { state } = replay(nums(seq), 'allin1');
  ok(state.count === want, `"${seq}" -> ${want}  (${note})`, 'got ' + state.count);
}
{
  const { events } = replay(nums('3 6 7 18 0 1 2 3 18 4'), 'allin1');
  const scoring = events.filter((e) => e === EVENT.COUNT || e === EVENT.RESET);
  ok(scoring.length === 2 && scoring[0] === EVENT.COUNT && scoring[1] === EVENT.RESET,
    'vector 4 fires exactly one COUNT then one RESET', scoring.join(','));
}
{
  const { events } = replay(nums('0 0 0 4 0 4 4 4 0 4'), 'allin1');
  ok(!events.includes(EVENT.RESET), 'vector 3 fires no RESET at all', events.join(','));
}

section('§6.2 the full matrix (28 shapes x the original ten readings)');
// column order matches the brief's table
const COLS = ['allin1', 'monada', 'diada', 'triada', 'enaduo',
  'allin2', 'monada2', 'diada2', 'triada2', 'enaduo2'];
const A = 'armed';
const MATRIX = [
  ['AB', [0, A, 0, 0, A, 0, 0, 0, 0, 0]],
  ['ABB', [0, -1, A, 0, A, 0, 0, 0, 0, 0]],
  ['ABA', [0, 0, 0, 0, 0, 0, A, 0, 0, A]],
  ['ABBB', [0, -1, -1, A, -1, 0, 0, 0, 0, 0]],
  ['ABBA', [0, -1, 0, 0, 0, 0, A, 0, 0, A]],
  ['ABBBB', [0, -1, -1, -1, -1, 0, 0, 0, 0, 0]],
  ['ABBBA', [A, -1, -1, 0, -1, A, A, 0, 0, A]],
  ['ABBBBB', [0, -1, -1, -1, -1, 0, 0, 0, 0, 0]],
  ['AABB', [0, -1, A, 0, A, 0, 0, 0, 0, 0]],
  ['AAABB', [0, -1, A, 0, A, -1, 0, 0, 0, 0]],
  ['AAABA', [-1, 0, 0, 0, 0, 0, A, 0, 0, A]],
  ['ABBABB', [0, -2, A, 0, A, 0, 0, 0, 0, 0]],
  ['ABBBABBB', [-1, -2, -2, A, -2, 0, 0, 0, 0, 0]],
  ['AAABBBAA', [0, -1, -1, 0, -1, -2, -1, A, 0, A]],
  ['BA', [0, 0, 0, 0, 0, 0, A, 0, 0, A]],
  ['BAA', [0, 0, 0, 0, 0, 0, -1, A, 0, A]],
  ['BAB', [0, A, 0, 0, A, 0, 0, 0, 0, 0]],
  ['BAAA', [0, 0, 0, 0, 0, 0, -1, -1, A, -1]],
  ['BAAB', [0, A, 0, 0, A, 0, -1, 0, 0, 0]],
  ['BAAAA', [0, 0, 0, 0, 0, 0, -1, -1, -1, -1]],
  ['BAAAB', [A, A, 0, 0, A, A, -1, -1, 0, -1]],
  ['BAAAAA', [0, 0, 0, 0, 0, 0, -1, -1, -1, -1]],
  ['BBAA', [0, 0, 0, 0, 0, 0, -1, A, 0, A]],
  ['BBBAA', [0, 0, 0, 0, 0, -1, -1, A, 0, A]],
  ['BBBAB', [-1, A, 0, 0, A, 0, 0, 0, 0, 0]],
  ['BAABAA', [0, 0, 0, 0, 0, 0, -2, A, 0, A]],
  ['BAAABAAA', [-1, 0, 0, 0, 0, 0, -2, -2, A, -2]],
  ['BBBAAABB', [0, -1, A, 0, A, -2, -1, -1, 0, -1]],
];
for (const [shape, row] of MATRIX) {
  const spins = letters(shape);
  row.forEach((want, i) => {
    const st = replay(spins, COLS[i]).state;
    if (want === A) {
      ok(st.count === 0 && armed(st), `${shape} / ${COLS[i]} -> armed`,
        `count ${st.count} ${st.phase}`);
    } else {
      ok(st.count === want, `${shape} / ${COLS[i]} -> ${want}`, 'got ' + st.count);
    }
  });
}

section('addendum §3 — vectors for Tetrada / Pentada and their opposites');
const ADD_COLS = ['tetrada', 'tetrada2', 'pentada', 'pentada2'];
const ADDENDUM = [
  ['AB', [0, 0, 0, 0]],
  ['ABB', [0, 0, 0, 0]],
  ['ABA', [0, 0, 0, 0]],
  ['ABBB', [0, 0, 0, 0]],
  ['ABBA', [0, 0, 0, 0]],
  ['ABBBB', [A, 0, 0, 0]],
  ['ABBBA', [0, 0, 0, 0]],
  ['ABBBBB', [-1, 0, A, 0]],
  ['ABBBBA', [0, 0, 0, 0]],
  ['ABBBBBB', [-1, 0, -1, 0]],
  ['ABBBBBA', [-1, 0, 0, 0]],
  ['ABBBBBBB', [-1, 0, -1, 0]],
  ['AABB', [0, 0, 0, 0]],
  ['AAABB', [0, 0, 0, 0]],
  ['AAABA', [0, 0, 0, 0]],
  ['AABBBBB', [-1, 0, A, 0]],
  ['AABBBBBB', [-1, 0, -1, 0]],
  ['ABBABB', [0, 0, 0, 0]],
  ['ABBBABBB', [0, 0, 0, 0]],
  ['AAABBBAA', [0, 0, 0, 0]],
  ['ABBBBBABBBBB', [-2, 0, A, 0]],
  ['ABBBBBBABBBBBB', [-2, 0, -2, 0]],
  ['ABBBBABBBBB', [-1, 0, A, 0]],
  ['ABBBBBABBBBBB', [-2, 0, -1, 0]],
  ['ABBBBBBABBBBA', [0, 0, -1, 0]],     // the row that separates the two depths
  ['ABBBBBBABBBA', [-1, 0, -1, 0]],
  ['BA', [0, 0, 0, 0]],
  ['BAA', [0, 0, 0, 0]],
  ['BAB', [0, 0, 0, 0]],
  ['BAAA', [0, 0, 0, 0]],
  ['BAAB', [0, 0, 0, 0]],
  ['BAAAA', [0, A, 0, 0]],
  ['BAAAB', [0, 0, 0, 0]],
  ['BAAAAA', [0, -1, 0, A]],
  ['BAAAAB', [0, 0, 0, 0]],
  ['BAAAAAA', [0, -1, 0, -1]],
  ['BAAAAAB', [0, -1, 0, 0]],
  ['BAAAAAAA', [0, -1, 0, -1]],
  ['BBAA', [0, 0, 0, 0]],
  ['BBBAA', [0, 0, 0, 0]],
  ['BBBAB', [0, 0, 0, 0]],
  ['BBAAAAA', [0, -1, 0, A]],
  ['BBAAAAAA', [0, -1, 0, -1]],
  ['BAABAA', [0, 0, 0, 0]],
  ['BAAABAAA', [0, 0, 0, 0]],
  ['BBBAAABB', [0, 0, 0, 0]],
  ['BAAAAABAAAAA', [0, -2, 0, A]],
  ['BAAAAAABAAAAAA', [0, -2, 0, -2]],
  ['BAAAABAAAAA', [0, -1, 0, A]],
  ['BAAAAABAAAAAA', [0, -2, 0, -1]],
  ['BAAAAAABAAAAB', [0, 0, 0, -1]],     // the mirror of the separating row
  ['BAAAAAABAAAB', [0, -1, 0, -1]],
  ['BBBBABBBBB', [-1, 0, A, 0]],
  ['BBBBBABBBBBB', [-1, 0, -1, 0]],
  ['AAAABAAAAA', [0, -1, 0, A]],
  ['AAAAABAAAAAA', [0, -1, 0, -1]],
];
for (const [shape, row] of ADDENDUM) {
  const spins = letters(shape);
  row.forEach((want, i) => {
    const st = replay(spins, ADD_COLS[i]).state;
    if (want === A) {
      ok(st.count === 0 && armed(st), `${shape} / ${ADD_COLS[i]} -> armed`, `count ${st.count} ${st.phase}`);
    } else {
      ok(st.count === want, `${shape} / ${ADD_COLS[i]} -> ${want}`, 'got ' + st.count);
    }
  });
}
{
  // "If your Tetrada and Pentada columns are identical, you have given them the same
  // armAfter" - assert the separating rows disagree rather than trusting the loop above
  const t = replay(letters('ABBBBBBABBBBA'), 'tetrada').state.count;
  const p = replay(letters('ABBBBBBABBBBA'), 'pentada').state.count;
  ok(t === 0 && p === -1, 'ABBBBBBABBBBA separates Tetrada from Pentada', `${t}/${p}`);
  const t2 = replay(letters('BAAAAAABAAAAB'), 'tetrada2').state.count;
  const p2 = replay(letters('BAAAAAABAAAAB'), 'pentada2').state.count;
  ok(t2 === 0 && p2 === -1, 'BAAAAAABAAAAB separates the opposites', `${t2}/${p2}`);
}

section('addendum §2.4 — a reading arming at depth n ignores n−1 near misses');
const NEAR_MISSES = [
  ['monada', [], 'ABA'],
  ['diada', ['ABA'], 'ABBA'],
  ['triada', ['ABA', 'ABBA'], 'ABBBA'],
  ['tetrada', ['ABA', 'ABBA', 'ABBBA'], 'ABBBBA'],
  ['pentada', ['ABA', 'ABBA', 'ABBBA', 'ABBBBA'], 'ABBBBBA'],
  ['monada2', [], 'BAB'],
  ['diada2', ['BAB'], 'BAAB'],
  ['triada2', ['BAB', 'BAAB'], 'BAAAB'],
  ['tetrada2', ['BAB', 'BAAB', 'BAAAB'], 'BAAAAB'],
  ['pentada2', ['BAB', 'BAAB', 'BAAAB', 'BAAAAB'], 'BAAAAAB'],
];
for (const [reading, ignores, resets] of NEAR_MISSES) {
  for (const shape of ignores) {
    const { events } = replay(letters(shape), reading);
    ok(events.every((e) => e === EVENT.NONE), `${reading} ignores ${shape} entirely`, events.join(','));
    // and a standing count must survive it untouched
    const seeded = replay(letters('A'.repeat(1) + 'B'.repeat(20)), reading).state;
    const after = replay(letters(shape), reading, seeded).state;
    ok(after.count === seeded.count, `${reading}: ${shape} leaves a standing count alone`,
      `${seeded.count} -> ${after.count}`);
  }
  const { events } = replay(letters(resets), reading);
  ok(events[events.length - 1] === EVENT.RESET, `${reading} resets on ${resets}`, events.join(','));
}

section('§6.3 event sequences');
const N = EVENT.NONE, AR = EVENT.ARMED, C = EVENT.COUNT, R = EVENT.RESET;
const EVENTS = [
  ['allin1', 'AAABA', [N, N, N, AR, C]],
  ['allin1', 'AAABB', [N, N, N, AR, R]],
  ['allin2', 'AAABB', [N, N, N, AR, C]],
  ['allin2', 'AAABA', [N, N, N, AR, R]],
  ['monada', 'ABB', [N, AR, C]],
  ['monada', 'ABA', [N, AR, R]],
  ['diada', 'ABBB', [N, N, AR, C]],
  ['diada', 'ABBA', [N, N, AR, R]],
  ['diada', 'ABA', [N, N, N]],              // no event at all
  ['triada', 'ABBBB', [N, N, N, AR, C]],
  ['triada', 'ABBBA', [N, N, N, AR, R]],
  ['triada', 'ABBA', [N, N, N, N]],         // no event at all
  ['enaduo', 'ABBB', [N, AR, AR, C]],
  ['enaduo', 'ABBA', [N, AR, AR, R]],
  ['enaduo', 'ABA', [N, AR, R]],
  ['monada2', 'BAA', [N, AR, C]],
  ['monada2', 'BAB', [N, AR, R]],
  ['diada2', 'BAAA', [N, N, AR, C]],
  ['diada2', 'BAAB', [N, N, AR, R]],
  ['diada2', 'BAB', [N, N, N]],
  ['triada2', 'BAAAA', [N, N, N, AR, C]],
  ['triada2', 'BAAAB', [N, N, N, AR, R]],
  ['triada2', 'BAAB', [N, N, N, N]],
  ['enaduo2', 'BAAA', [N, AR, AR, C]],
  ['enaduo2', 'BAAB', [N, AR, AR, R]],
  ['enaduo2', 'BAB', [N, AR, R]],
  // addendum §4
  ['tetrada', 'ABBBBB', [N, N, N, N, AR, C]],
  ['tetrada', 'ABBBBA', [N, N, N, N, AR, R]],
  ['tetrada', 'ABBA', [N, N, N, N]],
  ['tetrada', 'ABBBA', [N, N, N, N, N]],
  ['tetrada2', 'BAAAA', [N, N, N, N, AR]],
  ['tetrada2', 'BAAAAB', [N, N, N, N, AR, R]],
  ['tetrada2', 'BAAB', [N, N, N, N]],
  ['tetrada2', 'BAAAB', [N, N, N, N, N]],
  ['pentada', 'ABBBBBB', [N, N, N, N, N, AR, C]],
  ['pentada', 'ABBBBBA', [N, N, N, N, N, AR, R]],
  ['pentada', 'ABBBBA', [N, N, N, N, N, N]],
  ['pentada2', 'BAAAAAA', [N, N, N, N, N, AR, C]],
  ['pentada2', 'BAAAAAB', [N, N, N, N, N, AR, R]],
  ['pentada2', 'BAAAAB', [N, N, N, N, N, N]],
];
for (const [reading, shape, want] of EVENTS) {
  const { events } = replay(letters(shape), reading);
  ok(events.join(',') === want.join(','), `${reading} / ${shape} events`,
    'got ' + events.join(','));
}

section('§6.4 the carry');
const CARRY = [
  ['allin2', 'AAABB', 'B', 2, -1],
  ['allin2', 'AAABA', 'A', 1, 0],
  ['monada', 'ABB', 'B', 2, -1],
  ['monada', 'ABA', 'A', 1, 0],
  ['diada', 'ABBB', 'B', 2, -1],
  ['diada', 'ABBA', 'A', 1, 0],
  ['monada2', 'BAA', 'A', 2, -1],
  ['monada2', 'BAB', 'B', 1, 0],
  ['diada2', 'BAAA', 'A', 2, -1],
  ['diada2', 'BAAB', 'B', 1, 0],
  ['triada2', 'BAAAA', 'A', 2, -1],
  ['triada2', 'BAAAB', 'B', 1, 0],
  ['enaduo2', 'BAAA', 'A', 2, -1],
  ['enaduo2', 'BAAB', 'B', 1, 0],
  // addendum §5 — the carry never depends on the reading, asserted for the new four too
  ['tetrada', 'ABBBBB', 'B', 2, -1],
  ['tetrada', 'ABBBBA', 'A', 1, 0],
  ['tetrada2', 'BAAAAA', 'A', 2, -1],
  ['tetrada2', 'BAAAAB', 'B', 1, 0],
  ['pentada', 'ABBBBBB', 'B', 2, -1],
  ['pentada', 'ABBBBBA', 'A', 1, 0],
  ['pentada2', 'BAAAAAA', 'A', 2, -1],
  ['pentada2', 'BAAAAAB', 'B', 1, 0],
];
for (const [reading, shape, g, len, count] of CARRY) {
  const s = replay(letters(shape), reading).state;
  ok(s.runGroup === g && s.runLength === len && s.count === count,
    `${reading} / ${shape} carries ${g}x${len} count ${count}`,
    `${s.runGroup}x${s.runLength} count ${s.count}`);
}

section('§6.5 properties over a random stream');
{
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 37; };
  const stream = Array.from({ length: 5000 }, rnd);

  const st = {}; const mins = {}; const scored = {};
  for (const id of READING_IDS) { st[id] = createState(); mins[id] = 0; scored[id] = []; }
  let everPositive = false, armExclusive = true, enaduoArming = true;

  stream.forEach((n, spin) => {
    for (const id of READING_IDS) {
      const r = applySpin(st[id], n, id);
      st[id] = r.state;
      if (r.event === EVENT.COUNT) scored[id].push(spin);
      if (st[id].count > 0) everPositive = true;
      mins[id] = Math.min(mins[id], st[id].count);
    }
    // 6 (as amended by addendum §2.3): at most one of the FIVE single-arm readings on a
    // group is armed at a time - each wants a different interrupting-run length
    for (const five of [
      ['monada', 'diada', 'triada', 'tetrada', 'pentada'],
      ['monada2', 'diada2', 'triada2', 'tetrada2', 'pentada2'],
    ]) {
      if (five.filter((id) => armed(st[id])).length > 1) armExclusive = false;
    }
    // 5: Ena/Duo armed exactly when Monada or Diada is
    if (armed(st.enaduo) !== (armed(st.monada) || armed(st.diada))) enaduoArming = false;
    if (armed(st.enaduo2) !== (armed(st.monada2) || armed(st.diada2))) enaduoArming = false;
  });

  ok(!everPositive, '1. no count is ever positive');
  ok(READING_IDS.every((id) => st[id].deepest === mins[id]),
    '2. deepest equals the minimum ever observed');

  // 3. swap invariance: a group-B reading on a sequence equals its group-A twin on the
  // same sequence with every number moved to the other group.
  const swapped = stream.map((n) => (groupOf(n) === 'A' ? 4 : 3));
  const plain = stream.map((n) => (groupOf(n) === 'A' ? 3 : 4));
  let swapOk = true;
  for (const [a, b] of [['monada', 'monada2'], ['diada', 'diada2'],
    ['triada', 'triada2'], ['tetrada', 'tetrada2'], ['pentada', 'pentada2'],
    ['enaduo', 'enaduo2'], ['allin1', 'allin1'], ['allin2', 'allin2']]) {
    if (replay(plain, a).state.count !== replay(swapped, b).state.count) swapOk = false;
  }
  ok(swapOk, '3. swap invariance holds for every mirror pair (addendum §6.1)');

  ok(st.enaduo.count >= st.diada.count && st.enaduo2.count >= st.diada2.count,
    '4. Ena/Duo is never deeper than Diada',
    `${st.enaduo.count}/${st.diada.count} ${st.enaduo2.count}/${st.diada2.count}`);
  ok(enaduoArming, '5. Ena/Duo armed exactly when Monada or Diada is');
  ok(armExclusive, '6. at most one of Monada/Diada/Triada armed at a time');

  // 7. no group-B reading ever scores on the same spin as its group-A twin
  let shared = 0;
  for (const [a, b] of [['monada', 'monada2'], ['diada', 'diada2'], ['triada', 'triada2'],
    ['tetrada', 'tetrada2'], ['pentada', 'pentada2'], ['enaduo', 'enaduo2']]) {
    const sa = new Set(scored[a]);
    shared += scored[b].filter((s) => sa.has(s)).length;
  }
  ok(shared === 0, '7. no mirror pair scores on the same spin', 'shared ' + shared);

  const once = JSON.stringify(replay(stream.slice(0, 400), 'diada').state);
  const twice = JSON.stringify(replay(stream.slice(0, 400), 'diada').state);
  ok(once === twice, '8. replaying the same sequence twice is identical');

  // §7 sanity: the deeper a reading arms, the rarer it is, all the way down the ladder
  const ladder = ['monada', 'diada', 'triada', 'tetrada', 'pentada'].map((id) => scored[id].length);
  ok(ladder.every((n, i) => i === 0 || n < ladder[i - 1]),
    'frequency: each depth fires less often than the one above it', ladder.join(' > '));
}

section('addendum §6 — properties over a long stream');
{
  // 200k spins, because the Pentada pair score about once per 112 and 147 spins: a
  // 2,000-spin stream exercises almost no deciders and would pass whatever we did
  // (addendum §2.5). mulberry32 rather than the LCG above: a weak generator's low bits
  // skew the group split, which is exactly what this measures.
  let s = 0x9e3779b9;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * 37) | 0;
  };
  const SINGLE_ARM = ['monada', 'diada', 'triada', 'tetrada', 'pentada',
    'monada2', 'diada2', 'triada2', 'tetrada2', 'pentada2'];
  const rules = new Map(READINGS.map((r) => [r.id, r]));
  const st = {}; const counts = {};
  for (const id of READING_IDS) { st[id] = createState(); counts[id] = 0; }

  let armingExact = true, armingWhere = '';
  const orderSeen = new Map();   // 'a<b' / 'a>b' per adjacent pair, for no-domination
  const SPINS = 200000;

  for (let i = 0; i < SPINS; i++) {
    const n = rnd();
    for (const id of READING_IDS) {
      const r = applySpin(st[id], n, id);
      st[id] = r.state;
      if (r.event === EVENT.COUNT) counts[id] += 1;
    }
    // 3. arming is exact: a single-arm reading is only ever armed with its own origin
    // group and its own interrupting-run length
    for (const id of SINGLE_ARM) {
      if (!armed(st[id])) continue;
      const rule = rules.get(id);
      if (st[id].originGroup !== rule.armsFrom || st[id].runLength !== rule.armAfter ||
          st[id].runGroup === rule.armsFrom) {
        armingExact = false;
        armingWhere = id + ' origin ' + st[id].originGroup + ' run ' +
          st[id].runGroup + 'x' + st[id].runLength + ' (armAfter ' + rule.armAfter + ')';
      }
    }
    // 5. no domination in either direction between adjacent depths on a group
    for (const [a, b] of [['monada', 'diada'], ['diada', 'triada'], ['triada', 'tetrada'],
      ['tetrada', 'pentada'], ['monada2', 'diada2'], ['diada2', 'triada2'],
      ['triada2', 'tetrada2'], ['tetrada2', 'pentada2']]) {
      if (st[a].count < st[b].count) orderSeen.set(a + '<' + b, true);
      if (st[a].count > st[b].count) orderSeen.set(a + '>' + b, true);
    }
  }

  ok(armingExact, '3. arming is exact at each reading’s own depth', armingWhere);

  const bothWays = [['monada', 'diada'], ['diada', 'triada'], ['triada', 'tetrada'],
    ['tetrada', 'pentada'], ['monada2', 'diada2'], ['diada2', 'triada2'],
    ['triada2', 'tetrada2'], ['tetrada2', 'pentada2']]
    .filter(([a, b]) => orderSeen.get(a + '<' + b) && orderSeen.get(a + '>' + b));
  ok(bothWays.length === 8, '5. neither of any adjacent pair dominates the other',
    bothWays.length + '/8 pairs showed both orderings');

  // 6. observed scoring rates match the predicted ones (addendum §2.2). This is the
  // backstop for an off-by-one in armAfter at depths 4 and 5, where no single vector
  // reveals it: the rate moves by roughly a factor of two.
  const PREDICTED = {
    monada: 12.8, monada2: 12.2, diada: 6.6, diada2: 5.9, triada: 3.4, triada2: 2.9,
    tetrada: 1.7, tetrada2: 1.4, pentada: 0.89, pentada2: 0.68,
  };
  const rates = [];
  for (const [id, want] of Object.entries(PREDICTED)) {
    const got = counts[id] / SPINS * 100;
    const within = Math.abs(got - want) / want <= 0.1;      // 10% relative
    if (!within) rates.push(id + ' ' + got.toFixed(2) + '% vs ' + want + '%');
    ok(within, '6. ' + id + ' scores at about ' + want + '% of spins',
      got.toFixed(3) + '% over ' + SPINS + ' spins');
  }
  if (rates.length) console.log('      (rates off: ' + rates.join(', ') + ')');
}

section('PATTERNS.md §10 — the cases it singles out');
{
  // §10.5 and §10.10: the two-armed readings lose a count where the single-arm one keeps it
  const ed = replay(letters('ABBBABA'), 'enaduo').state.count;
  const di = replay(letters('ABBBABA'), 'diada').state.count;
  ok(ed === 0 && di === -1, 'ABBBABA: Ena/Duo 0 where Diada is -1', `${ed}/${di}`);
  const ed2 = replay(letters('BAAABAB'), 'enaduo2').state.count;
  const di2 = replay(letters('BAAABAB'), 'diada2').state.count;
  ok(ed2 === 0 && di2 === -1, 'BAAABAB: Ena/Duo 2 0 where Diada 2 is -1', `${ed2}/${di2}`);
}
{
  // §10.9: BOTH Triada 2 near misses must fire no event at all
  ok(replay(letters('BAB'), 'triada2').events.every((e) => e === EVENT.NONE),
    'triada2 / BAB fires no event');
  ok(replay(letters('BAAB'), 'triada2').events.every((e) => e === EVENT.NONE),
    'triada2 / BAAB fires no event');
}
{
  // §10.10: Ena/Duo scores on exactly the spins Diada scores on, and §10.14's extra
  // arming exclusion: Triada is never armed alongside Monada, Diada or Ena/Duo.
  let seed = 98765;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 37; };
  const st = {}; const scored = {};
  for (const id of READING_IDS) { st[id] = createState(); scored[id] = []; }
  let triadaAlone = true;
  for (let i = 0; i < 5000; i++) {
    const n = rnd();
    for (const id of READING_IDS) {
      const r = applySpin(st[id], n, id);
      st[id] = r.state;
      if (r.event === EVENT.COUNT) scored[id].push(i);
    }
    if (armed(st.triada) && (armed(st.monada) || armed(st.diada) || armed(st.enaduo) || armed(st.tetrada) || armed(st.pentada))) triadaAlone = false;
    if (armed(st.triada2) && (armed(st.monada2) || armed(st.diada2) || armed(st.enaduo2) || armed(st.tetrada2) || armed(st.pentada2))) triadaAlone = false;
  }
  ok(scored.enaduo.join() === scored.diada.join(),
    'Ena/Duo scores on exactly the spins Diada scores on',
    `${scored.enaduo.length} vs ${scored.diada.length}`);
  ok(scored.enaduo2.join() === scored.diada2.join(),
    'Ena/Duo 2 scores on exactly the spins Diada 2 scores on',
    `${scored.enaduo2.length} vs ${scored.diada2.length}`);
  ok(triadaAlone, 'Triada is never armed alongside Monada, Diada or Ena/Duo');
  // §10.8: neither Monada 2 nor Diada 2 dominates the other over a long stream
  ok(scored.monada.length > 0 && scored.diada.length > 0, 'both depths score over 5000 spins');
}

section('Andreas Deluxe — the streak reading on group C');
{
  ok(GROUP_C.length === 15, 'group C holds 15 numbers', String(GROUP_C.length));
  ok(new Set(GROUP_C).size === 15, 'with no duplicates');
  ok(GROUP_C.every((n) => Number.isInteger(n) && n >= 0 && n <= 36), 'all within 0..36');
  // C is a separate split, not a slice of A/B: it overlaps both
  const inA = GROUP_C.filter((n) => groupOf(n) === 'A');
  const inB = GROUP_C.filter((n) => groupOf(n) === 'B');
  ok(inA.length === 9 && inB.length === 6, 'C overlaps A and B (9 + 6)',
    inA.length + ' + ' + inB.length);
  ok(inGroup('C', 0) && inGroup('C', 35) && !inGroup('C', 1) && !inGroup('C', 36),
    'inGroup reads membership');
  let threw = 0;
  try { inGroup('D', 1); } catch { threw++; }
  try { inGroup('C', 37); } catch { threw++; }
  try { inGroup('C', 1.5); } catch { threw++; }
  ok(threw === 3, 'an unknown group and a non-spin are both rejected', String(threw));
}
{
  // every miss deepens, and nothing else does
  const misses = [];
  for (let n = 0; n <= 36; n++) if (!GROUP_C.includes(n)) misses.push(n);
  ok(misses.length === 22, '22 numbers are outside C', String(misses.length));
  const { state, events } = replay(misses.slice(0, 5), 'andreas');
  ok(state.count === -5, 'five misses in a row is −5', String(state.count));
  ok(events.every((e) => e === EVENT.COUNT), 'each miss fires COUNT', events.join(','));
  ok(state.phase === PHASE.BUILDING && !armed(state), 'it is never armed - there is nothing to arm');
  ok(state.runLength === 5, 'runLength carries the streak for display', String(state.runLength));
}
{
  // any group-C number wipes it
  for (const c of GROUP_C) {
    const seeded = replay([1, 4, 7], 'andreas').state;          // −3
    const r = applySpin(seeded, c, 'andreas');
    ok(r.state.count === 0 && r.event === EVENT.RESET, c + ' (in C) resets it',
      r.state.count + ' ' + r.event);
  }
}
{
  // a C number with nothing standing is an ordinary spin, not a reset: counting it as
  // one would file half of all spins as resets
  const fresh = createState();
  const r = applySpin(fresh, 0, 'andreas');
  ok(r.state.count === 0 && r.event === EVENT.NONE && r.state.resets === 0,
    'a C hit at 0 fires no event', r.event + ' resets ' + r.state.resets);
  const after = replay([1, 4, 0, 7, 11, 0], 'andreas').state;
  ok(after.resets === 2, 'resets count only wipes of a standing count', String(after.resets));
  ok(after.deepest === -2, 'deepest is the deepest streak reached', String(after.deepest));
}
{
  // the chain: misses, a hit, misses again
  const seq = [1, 4, 7, 11, 0, 13, 16, 18, 19, 22, 24, 31];
  const { state, events } = replay(seq, 'andreas');
  ok(state.count === -7, 'seven misses after the last C number', String(state.count));
  ok(events[4] === EVENT.RESET, 'the C number in the middle is the reset', events.join(','));
  ok(state.deepest === -7, 'deepest followed it down', String(state.deepest));
}
{
  const rule = READINGS.find((r) => r.id === 'andreas');
  ok(rule.kind === 'streak' && rule.group === 'C' && rule.deepensOn === 'out',
    'it is a streak reading that counts spins OUTSIDE group C');
  ok(rule.alertDepth === 8, 'it pushes at −8, not the global −4', String(rule.alertDepth));
  ok(rule.minRunToArm === undefined && rule.armsFrom === undefined,
    'it carries none of the run-reading fields');
}
{
  // rate check: a miss is 22/37, so the count reaches −5 on (22/37)^5 of spins
  let s = 0x1234567;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * 37) | 0;
  };
  const SPINS = 200000;
  let st = createState(), misses = 0, crossings = 0, atOrPast = 0;
  for (let i = 0; i < SPINS; i++) {
    const r = applySpin(st, rnd(), 'andreas');
    if (r.event === EVENT.COUNT) misses++;
    if (r.state.count === -5) crossings++;      // the spin that brings it to exactly −5
    if (r.state.count <= -5) atOrPast++;        // spins spent at −5 or deeper
    st = r.state;
  }
  const p = 22 / 37;                            // a miss
  const q = 15 / 37;                            // a group-C hit

  const missRate = misses / SPINS;
  ok(Math.abs(missRate - p) / p < 0.02, 'misses land at about 22/37 of spins',
    (missRate * 100).toFixed(2) + '% vs ' + (p * 100).toFixed(2) + '%');

  // Two different quantities, and conflating them is the easy mistake: the count SITS at
  // −5 or deeper on p^5 of spins, but it ARRIVES at exactly −5 only when the streak
  // started precisely five spins ago, which also needs the hit before it: p^5 · q.
  const sitRate = atOrPast / SPINS;
  ok(Math.abs(sitRate - p ** 5) / p ** 5 < 0.1,
    'the count sits at −5 or deeper on about p^5 of spins',
    (sitRate * 100).toFixed(2) + '% vs ' + (p ** 5 * 100).toFixed(2) + '%');

  const crossRate = crossings / SPINS;
  const wantCross = p ** 5 * q;
  ok(Math.abs(crossRate - wantCross) / wantCross < 0.1,
    'it arrives at exactly −5 on about p^5·q of spins',
    (crossRate * 100).toFixed(2) + '% vs ' + (wantCross * 100).toFixed(2) + '%');
}

section('Serie 1 / Serie 2 — consecutive numbers from one group');
{
  const s1 = READINGS.find((r) => r.id === 'serie1');
  const s2 = READINGS.find((r) => r.id === 'serie2');
  ok(s1.kind === 'streak' && s1.group === 'A' && s1.deepensOn === 'in',
    'Serie 1 counts consecutive group-A numbers');
  ok(s2.kind === 'streak' && s2.group === 'B' && s2.deepensOn === 'in',
    'Serie 2 counts consecutive group-B numbers');
  ok(s1.alertDepth === 11 && s2.alertDepth === 11, 'both push at −11',
    s1.alertDepth + '/' + s2.alertDepth);
}
{
  // eleven in a row is exactly −11, and every spin on the way fires a COUNT
  const elevenA = [0, 1, 2, 3, 6, 7, 8, 10, 13, 14, 17];
  const { state, events } = replay(elevenA, 'serie1');
  ok(state.count === -11, 'eleven group-A numbers is −11', String(state.count));
  ok(events.length === 11 && events.every((e) => e === EVENT.COUNT), 'each one counts',
    events.join(','));
  ok(state.runLength === 11 && state.runGroup === 'A', 'the streak is carried for display',
    state.runGroup + '×' + state.runLength);
  ok(state.phase === PHASE.BUILDING && !armed(state), 'a streak reading is never armed');
  // the same spins do nothing at all to Serie 2
  ok(replay(elevenA, 'serie2').state.count === 0, 'and nothing to Serie 2');
}
{
  // one number from the other group wipes it, however deep
  const ten = [0, 1, 2, 3, 6, 7, 8, 10, 13, 14];
  const seeded = replay(ten, 'serie1').state;
  ok(seeded.count === -10, 'ten in a row first', String(seeded.count));
  const r = applySpin(seeded, 4, 'serie1');            // 4 is group B
  ok(r.state.count === 0 && r.event === EVENT.RESET, 'a group-B number resets Serie 1',
    r.state.count + ' ' + r.event);
  ok(r.state.resets === 1, 'and is recorded as a reset');
  // and the next group-A number starts again from −1
  const again = applySpin(r.state, 3, 'serie1');
  ok(again.state.count === -1 && again.event === EVENT.COUNT, 'then it builds again',
    String(again.state.count));
}
{
  // breaking a streak of nothing is an ordinary spin
  const r = applySpin(createState(), 4, 'serie1');
  ok(r.state.count === 0 && r.event === EVENT.NONE && r.state.resets === 0,
    'a group-B number at 0 fires no event', r.event);
}
{
  // Serie 2 is Serie 1 with the groups exchanged
  const elevenB = [4, 5, 9, 11, 12, 15, 16, 18, 19, 21, 22];
  const st = replay(elevenB, 'serie2').state;
  ok(st.count === -11 && st.runGroup === 'B', 'eleven group-B numbers is −11 on Serie 2',
    st.count + ' ' + st.runGroup);
  ok(replay(elevenB, 'serie1').state.count === 0, 'and nothing to Serie 1');

  // swap invariance over a long stream, as for every other mirror pair
  let s = 0x5eed;
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * 37) | 0; };
  const stream = Array.from({ length: 20000 }, rnd);
  const plain = stream.map((n) => (groupOf(n) === 'A' ? 3 : 4));
  const swapped = stream.map((n) => (groupOf(n) === 'A' ? 4 : 3));
  ok(replay(plain, 'serie1').state.count === replay(swapped, 'serie2').state.count,
    'Serie 2 mirrors Serie 1 under a group swap');
}
{
  // rate: eleven group-A numbers in a row is (18/37)^11, and arriving there also needs
  // the break before it
  let s = 0xBEEF;
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * 37) | 0; };
  const SPINS = 3000000;
  let st1 = createState(), hits = 0, sits = 0;
  for (let i = 0; i < SPINS; i++) {
    const r = applySpin(st1, rnd(), 'serie1');
    if (r.state.count === -11) hits++;
    if (r.state.count <= -11) sits++;
    st1 = r.state;
  }
  const p = 18 / 37, q = 19 / 37;
  ok(Math.abs(sits / SPINS - p ** 11) / p ** 11 < 0.2,
    'Serie 1 sits at −11 or deeper on about (18/37)^11 of spins',
    (sits / SPINS * 100).toFixed(4) + '% vs ' + (p ** 11 * 100).toFixed(4) + '%');
  ok(Math.abs(hits / SPINS - p ** 11 * q) / (p ** 11 * q) < 0.25,
    'and arrives there on about (18/37)^11 · (19/37)',
    (hits / SPINS * 100).toFixed(4) + '% vs ' + (p ** 11 * q * 100).toFixed(4) + '%');
}

section('§2 / §9 groups and bad input');
ok(GROUP_A.length === 18, 'group A totals 18', String(GROUP_A.length));
ok(GROUP_B.length === 19, 'group B totals 19', String(GROUP_B.length));
{
  const seen = new Set([...GROUP_A, ...GROUP_B]);
  let all = true;
  for (let n = 0; n <= 36; n++) if (!seen.has(n)) all = false;
  ok(all && seen.size === 37, 'every integer 0..36 classified exactly once');
}
ok(groupOf(0) === 'A', 'zero is group A');
{
  let threw = 0;
  for (const bad of [-1, 37, 1.5, NaN, '5', null, undefined]) {
    try { groupOf(bad); } catch { threw++; }
  }
  ok(threw === 7, 'out-of-range and non-integers rejected', 'threw ' + threw + '/7');
}
{
  let threw = false;
  try { applySpin(createState(), 3, 'nosuchreading'); } catch { threw = true; }
  ok(threw, 'an unknown reading is rejected');
}
ok(READINGS.length === 17 && new Set(READING_IDS).size === 17, 'seventeen distinct readings');
{
  // the legacy variant numbers still address the All in pair
  const a = replay(nums('3 6 7 18 0'), 1).state.count;
  const b = replay(nums('3 6 7 18 0'), 'allin1').state.count;
  ok(a === b && a === -1, 'variant 1 still means All in 1');
}
{
  const s = createState();
  ok(s.count === 0 && s.runGroup === null && s.originGroup === null && s.phase === PHASE.BUILDING,
    'fresh state is empty');
}

section('§9 things that look like edge cases');
{
  const s = replay(letters('ABABAB'), 'allin1').state;
  ok(s.count === 0, 'long chop does nothing at all');
}
{
  // a standing count survives the deadzone untouched
  const seeded = replay(nums('3 6 7 18 0'), 'allin1').state;   // count -1
  const after = replay(letters('ABABAB'), 'allin1', seeded).state;
  ok(after.count === -1, 'a standing count is untouched by chop', 'got ' + after.count);
}
{
  const mon = replay(letters('ABBBB'), 'monada').state.count;
  const dia = replay(letters('ABBBB'), 'diada').state.count;
  const tri = replay(letters('ABBBB'), 'triada').state.count;
  ok(mon === -1 && dia === -1 && tri === -1, 'ABBBB is -1 for Monada, Diada and Triada',
    `${mon}/${dia}/${tri}`);
}
{
  const s = replay(letters('BBBBBBAA'), 'monada').state;
  ok(s.count === 0, 'a long B-run never scores under Monada');
}

section('§8 new-spin detection');
{
  const known = [{ n: 5, id: 'e' }, { n: 4, id: 'd' }, { n: 3, id: 'c' }];
  const fetched = [{ n: 9, id: 'g' }, { n: 8, id: 'f' }, { n: 5, id: 'e' }, { n: 4, id: 'd' }];
  const r = detectNew(known, fetched);
  ok(r.status === 'ok' && r.fresh.length === 2 && r.fresh[0].id === 'g', 'ids: two new found');
}
{
  const r = detectNew([{ n: 1, id: 'a' }], [{ n: 1, id: 'a' }]);
  ok(r.status === 'ok' && r.fresh.length === 0, 'ids: nothing new');
}
{
  const r = detectNew([{ n: 1, id: 'old' }], [{ n: 9, id: 'z' }, { n: 8, id: 'y' }]);
  ok(r.status === 'desync', 'ids: window rolled past what we knew -> desync');
}
{
  const known = [{ n: 5 }, { n: 4 }, { n: 3 }, { n: 2 }, { n: 1 }];
  const fetched = [{ n: 7 }, { n: 5 }, { n: 4 }, { n: 3 }, { n: 2 }, { n: 1 }];
  const r = detectNew(known, fetched);
  ok(r.status === 'ok' && r.fresh.length === 1 && r.fresh[0].n === 7, 'values: one new by overlap');
}
{
  const known = [{ n: 1 }, { n: 1 }, { n: 1 }, { n: 1 }];
  const fetched = [{ n: 1 }, { n: 1 }, { n: 1 }, { n: 1 }, { n: 1 }, { n: 1 }];
  const r = detectNew(known, fetched);
  ok(r.status === 'desync', 'values: ambiguous alignment refuses to guess');
}
{
  const r = detectNew([{ n: 5 }, { n: 4 }, { n: 3 }, { n: 2 }], [{ n: 9 }, { n: 8 }, { n: 7 }, { n: 6 }]);
  ok(r.status === 'desync', 'values: no overlap -> desync');
}
{
  const r = detectNew([], [{ n: 3 }, { n: 2 }]);
  ok(r.status === 'seed', 'empty history -> seed');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
