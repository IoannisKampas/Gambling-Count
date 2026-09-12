// The contract from PATTERNS.md §7 and the checklist from §10.
// Run: node tools/patterns-test.mjs
import {
  GROUP_A, GROUP_B, groupOf, createState, applySpin, replay, detectNew, EVENT, PHASE,
} from '../src/patterns.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   ' + extra : '')); }
};
const nums = (s) => s.trim().split(/\s+/).map(Number);
// letters -> pockets: any group-A number for A, any group-B for B
const letters = (s) => [...s.replace(/\s+/g, '')].map((c) => (c === 'A' ? 3 : 4));

console.log('\n§7 Pattern 1 vectors');
const P1 = [
  ['3 6 7 18 0', -1, 'base case'],
  ['3 6 7 18 0 3 6 18 0', -2, 'return spin seeds next run'],
  ['0 0 0 4 0 4 4 4 0 4', -2, 'blocks either direction'],
  ['3 6 7 18 0 1 2 3 18 4', 0, 'two consecutive opposites wipe'],
  ['3 6 7 18 0 4 1 4 1 3 6 7 18 0', -2, 'chop is deadzone not reset'],
  ['1 2 4 5 5 4', 0, 'run of 2 never arms'],
  ['3 6 7 8 10 18 0', -1, 'long runs qualify once'],
  ['3 6 18 0 3 6 18 0', -1, 'pivot seeds a fresh run'],
];
for (const [seq, want, note] of P1) {
  const { state } = replay(nums(seq), 1);
  ok(state.count === want, `P1 "${seq}" -> ${want}  (${note})`, 'got ' + state.count);
}

console.log('\n§7 Pattern 1 event-order assertions');
{
  const { events } = replay(nums('3 6 7 18 0 1 2 3 18 4'), 1);
  const scoring = events.filter((e) => e === EVENT.COUNT || e === EVENT.RESET);
  ok(scoring.length === 2 && scoring[0] === EVENT.COUNT && scoring[1] === EVENT.RESET,
    'vector 4 fires exactly one COUNT then one RESET', scoring.join(','));
}
{
  const { events } = replay(nums('0 0 0 4 0 4 4 4 0 4'), 1);
  ok(!events.includes(EVENT.RESET), 'vector 3 fires no RESET at all', events.join(','));
}

console.log('\n§7 Pattern 2 shapes');
const P2 = [
  ['AAABB', -1, 0],
  ['AAABA', 0, -1],
  ['AABB', 0, 0],
  ['AAAAAABB', -1, 0],
  ['AAABBBAA', -2, null],
  ['AAABBBAAABB', -3, null],
  ['AAABBBAAABA', 0, null],
];
for (const [shape, want2, want1] of P2) {
  const s2 = replay(letters(shape), 2).state;
  ok(s2.count === want2, `P2 ${shape} -> ${want2}`, 'got ' + s2.count);
  if (want1 !== null) {
    const s1 = replay(letters(shape), 1).state;
    ok(s1.count === want1, `P1 ${shape} -> ${want1}`, 'got ' + s1.count);
  }
}

console.log('\n§7 Pattern 2 carry state');
{
  const s = replay(letters('AAABB'), 2).state;
  ok(s.runGroup === 'B' && s.runLength === 2 && s.count === -1,
    'after AAABB: run B x2, count -1', `${s.runGroup}x${s.runLength} count ${s.count}`);
}
{
  const s = replay(letters('AAABA'), 2).state;
  ok(s.runGroup === 'A' && s.runLength === 1 && s.count === 0,
    'after AAABA: run A x1, count 0', `${s.runGroup}x${s.runLength} count ${s.count}`);
}

console.log('\n§10 checklist');
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
  const s = createState();
  ok(s.count === 0 && s.runGroup === null && s.originGroup === null && s.phase === PHASE.BUILDING,
    'fresh state is empty');
}
{
  // a few thousand random spins: counts never positive, deepest == min ever seen
  let s1 = createState(), s2 = createState();
  let min1 = 0, min2 = 0, everPositive = false;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 37; };
  for (let i = 0; i < 5000; i++) {
    const n = rnd();
    s1 = applySpin(s1, n, 1).state;
    s2 = applySpin(s2, n, 2).state;
    if (s1.count > 0 || s2.count > 0) everPositive = true;
    min1 = Math.min(min1, s1.count); min2 = Math.min(min2, s2.count);
  }
  ok(!everPositive, 'no count is ever positive over 5000 spins');
  ok(s1.deepest === min1 && s2.deepest === min2, 'deepest equals the minimum ever observed',
    `${s1.deepest}/${min1} ${s2.deepest}/${min2}`);
}
{
  const seq = nums('3 6 7 18 0 4 1 4 1 3 6 7 18 0');
  const a = JSON.stringify(replay(seq, 1).state);
  const b = JSON.stringify(replay(seq, 1).state);
  ok(a === b, 'replaying the same sequence twice is identical');
}

console.log('\n§8 new-spin detection');
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
