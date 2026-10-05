// The acceptance tests from AGENT-BRIEF.md §6, plus the scraper contract from §8.
// Run: node tools/patterns-test.mjs   (npm run test:patterns)
import {
  GROUP_A, GROUP_B, groupOf, createState, applySpin, replay, detectNew,
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

section('§6.2 the full matrix (28 shapes x 10 readings)');
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
    // 6: at most one of each trio armed at a time
    for (const trio of [['monada', 'diada', 'triada'], ['monada2', 'diada2', 'triada2']]) {
      if (trio.filter((id) => armed(st[id])).length > 1) armExclusive = false;
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
    ['triada', 'triada2'], ['enaduo', 'enaduo2'], ['allin1', 'allin1'], ['allin2', 'allin2']]) {
    if (replay(plain, a).state.count !== replay(swapped, b).state.count) swapOk = false;
  }
  ok(swapOk, '3. swap invariance holds for every mirror pair');

  ok(st.enaduo.count >= st.diada.count && st.enaduo2.count >= st.diada2.count,
    '4. Ena/Duo is never deeper than Diada',
    `${st.enaduo.count}/${st.diada.count} ${st.enaduo2.count}/${st.diada2.count}`);
  ok(enaduoArming, '5. Ena/Duo armed exactly when Monada or Diada is');
  ok(armExclusive, '6. at most one of Monada/Diada/Triada armed at a time');

  // 7. no group-B reading ever scores on the same spin as its group-A twin
  let shared = 0;
  for (const [a, b] of [['monada', 'monada2'], ['diada', 'diada2'],
    ['triada', 'triada2'], ['enaduo', 'enaduo2']]) {
    const sa = new Set(scored[a]);
    shared += scored[b].filter((s) => sa.has(s)).length;
  }
  ok(shared === 0, '7. no mirror pair scores on the same spin', 'shared ' + shared);

  const once = JSON.stringify(replay(stream.slice(0, 400), 'diada').state);
  const twice = JSON.stringify(replay(stream.slice(0, 400), 'diada').state);
  ok(once === twice, '8. replaying the same sequence twice is identical');

  // §7 sanity: the deeper a reading arms, the rarer it is; and neither Monada nor
  // Diada dominates the other (a suite that only ever sees one ordering is wrong).
  ok(scored.monada.length > scored.diada.length && scored.diada.length > scored.triada.length,
    'frequency: Monada fires more often than Diada, Diada more than Triada',
    `${scored.monada.length}/${scored.diada.length}/${scored.triada.length}`);
  ok(scored.triada2.length > 0 && scored.triada2.length < scored.triada.length,
    'frequency: Triada 2 fires, and less often than Triada',
    `${scored.triada2.length}/${scored.triada.length}`);
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
    if (armed(st.triada) && (armed(st.monada) || armed(st.diada) || armed(st.enaduo))) triadaAlone = false;
    if (armed(st.triada2) && (armed(st.monada2) || armed(st.diada2) || armed(st.enaduo2))) triadaAlone = false;
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
ok(READINGS.length === 10 && new Set(READING_IDS).size === 10, 'ten distinct readings');
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
