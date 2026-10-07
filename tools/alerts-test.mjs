// The push-notification contract: what gets alerted, what must stay silent, and how
// the queue behaves against Telegram's limits.
// Run: node tools/alerts-test.mjs   (npm run test:alerts)
import {
  createAlertState, scan, formatAlert, formatAlertBlock, formatBatch, spinStrip,
} from '../src/alerts.mjs';
import { Telegram } from '../src/telegram.mjs';
import { AlertSelection } from '../src/selection.mjs';
import { AlertLog } from '../src/alert-log.mjs';
import { READINGS } from '../src/patterns.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name + (extra ? '   ' + extra : '')); }
};
const section = (s) => console.log('\n' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one table row shaped like /api/patterns serves it
const row = (counts, { id = 't1', name = 'Greek Roulette', desynced = false, observed = 10 } = {}) => ({
  id, name, provider: 'pragmatic', desynced, spins: [17, 4, 9, 3, 26, 12],
  reads: Object.fromEntries(READINGS.map((r) => [r.id, {
    count: counts[r.id] ?? 0, phase: 'BUILDING', runGroup: 'A', runLength: 1,
    originGroup: null, deepest: counts[r.id] ?? 0, resets: 0,
    spinsObserved: observed, lastEvent: 'NONE',
  }])),
});
// The mechanics sections (latching, desync, selection, message layout) are about the
// machinery, not the thresholds, so they pin every reading to -4. The real per-reading
// depths have their own section below.
const FLAT = Object.fromEntries(READINGS.map((r) => [r.id, 4]));
const opts = { depth: 4, readings: READINGS, depths: FLAT };
// the thresholds as the readings themselves declare them
const realOpts = { depth: 4, readings: READINGS };

section('what must stay silent');
{
  // §8.3 — a table restored by replaying its window starts latched, however deep
  const st = createAlertState();
  const hits = scan(st, [row({ monada: -9 })], opts);
  ok(hits.length === 0, 'first sight never alerts, even at −9', JSON.stringify(hits));
  // and it stays silent while it sits there
  ok(scan(st, [row({ monada: -9 })], opts).length === 0, 'an unchanged deep count does not re-alert');
}
{
  const st = createAlertState();
  scan(st, [row({ monada: 0 })], opts);
  ok(scan(st, [row({ monada: -3 })], opts).length === 0, '−3 is above the −4 threshold');
}
{
  // §8.2 — desynced counts are discarded, not real, never announced
  const st = createAlertState();
  scan(st, [row({ monada: 0 })], opts);
  const hits = scan(st, [row({ monada: -6 }, { desynced: true })], opts);
  ok(hits.length === 0, 'a desynced table never alerts');
  // and the re-baseline means the same count later is still not an alert
  ok(scan(st, [row({ monada: -6 })], opts).length === 0, 'desync re-baselines silently');
}
{
  const st = createAlertState();
  scan(st, [row({ monada: 0 }, { observed: 0 })], opts);
  const hits = scan(st, [row({ monada: -5 }, { observed: 0 })], opts);
  ok(hits.length === 0, 'a table with no live spins seen does not alert');
}

section('what must alert');
{
  const st = createAlertState();
  scan(st, [row({ monada: -3 })], opts);
  const hits = scan(st, [row({ monada: -4 })], opts);
  ok(hits.length === 1 && hits[0].count === -4 && hits[0].label === 'Monada',
    'crossing to −4 alerts once', JSON.stringify(hits));
  // deeper still is worth knowing
  const deeper = scan(st, [row({ monada: -5 })], opts);
  ok(deeper.length === 1 && deeper[0].count === -5, 'deepening to −5 alerts again');
  // but not the same depth twice
  ok(scan(st, [row({ monada: -5 })], opts).length === 0, 'the same depth does not alert twice');
}
{
  // wiped, then deep again: the second run is its own alert
  const st = createAlertState();
  scan(st, [row({ monada: -4 })], opts);        // first sight, latched
  scan(st, [row({ monada: 0 })], opts);         // reset
  const hits = scan(st, [row({ monada: -4 })], opts);
  ok(hits.length === 1, 'after a reset, −4 alerts again');
}
{
  // every reading is watched, and several can fire on one tick
  const st = createAlertState();
  scan(st, [row({})], opts);
  const hits = scan(st, [row({ monada: -4, triada2: -7, allin1: -4 })], opts);
  ok(hits.length === 3, 'three readings deep on one tick give three alerts', String(hits.length));
  ok(hits.some((h) => h.label === 'Triada 2' && h.count === -7), 'labels come from READINGS');
}
{
  // several tables are independent
  const st = createAlertState();
  scan(st, [row({}, { id: 'a' }), row({}, { id: 'b' })], opts);
  const hits = scan(st, [row({ diada: -4 }, { id: 'a' }), row({ diada: -4 }, { id: 'b' })], opts);
  ok(hits.length === 2 && hits[0].tableId !== hits[1].tableId, 'two tables alert separately');
}

section('configuration');
{
  const st = createAlertState();
  scan(st, [row({})], { ...opts, only: ['allin1'] });
  const hits = scan(st, [row({ monada: -6, allin1: -4 })], { ...opts, only: ['allin1'] });
  ok(hits.length === 1 && hits[0].reading === 'allin1',
    'only: restricts alerting to the chosen readings (PATTERNS.md §8.5)');
}
{
  // the global depth applies to any reading that declares none of its own
  const shallow = { depth: 2, readings: READINGS, depths: { monada: 2 } };
  const st = createAlertState();
  scan(st, [row({})], shallow);
  ok(scan(st, [row({ monada: -2 })], shallow).length === 1, 'depth is configurable');
}

section('only the selected tables push');
{
  const st = createAlertState();
  const two = [row({ monada: 0 }, { id: 'picked' }), row({ monada: 0 }, { id: 'ignored' })];
  scan(st, two, { ...opts, onlyTables: ['picked'] });
  const hits = scan(st, [row({ monada: -4 }, { id: 'picked' }), row({ monada: -4 }, { id: 'ignored' })],
    { ...opts, onlyTables: ['picked'] });
  ok(hits.length === 1 && hits[0].tableId === 'picked',
    'an unselected table never pushes', JSON.stringify(hits.map((h) => h.tableId)));
}
{
  // a table selected later must not arrive with a backlog: it latches first (§8.3)
  const st = createAlertState();
  scan(st, [row({ monada: -6 }, { id: 't' })], { ...opts, onlyTables: [] });   // nothing selected
  const justSelected = scan(st, [row({ monada: -6 }, { id: 't' })], { ...opts, onlyTables: ['t'] });
  ok(justSelected.length === 0, 'selecting a table that is already deep stays silent');
  const next = scan(st, [row({ monada: -7 }, { id: 't' })], { ...opts, onlyTables: ['t'] });
  ok(next.length === 1 && next[0].count === -7, 'and its next live deepening does push');
}
{
  const st = createAlertState();
  scan(st, [row({ monada: 0 })], opts);
  ok(scan(st, [row({ monada: -4 })], { ...opts, onlyTables: null }).length === 1,
    'onlyTables null means every table, as before');
}

section('every reading pushes at its own depth');
{
  // The thresholds as specified. A table here rather than a loop over READINGS on
  // purpose: a typo in the rules should fail this, not be mirrored by it.
  const WANT = {
    allin1: 15, allin2: 15,
    monada: 14, monada2: 14,
    diada: 13, diada2: 13,
    triada: 11, triada2: 11,
    enaduo: 6, enaduo2: 6,
    serie1: 11, serie2: 11,
    andreas: 8,
  };
  for (const [id, depth] of Object.entries(WANT)) {
    const r = READINGS.find((x) => x.id === id);
    ok(r && r.alertDepth === depth, id + ' pushes at −' + depth,
      'got ' + (r ? r.alertDepth : 'missing'));
  }
  // and each one fires exactly at its own depth, not one short of it
  for (const [id, depth] of Object.entries(WANT)) {
    const st = createAlertState();
    scan(st, [row({ [id]: -(depth - 2) })], realOpts);
    const early = scan(st, [row({ [id]: -(depth - 1) })], realOpts);
    ok(early.length === 0, id + ' stays quiet at −' + (depth - 1), JSON.stringify(early.map((h) => h.count)));
    const hit = scan(st, [row({ [id]: -depth })], realOpts);
    ok(hit.length === 1 && hit[0].count === -depth, id + ' fires at −' + depth,
      JSON.stringify(hit.map((h) => h.count)));
  }
}

section('the push depth and the simulation depth are separate');
{
  // A notification should be rare; the simulation needs sequences to judge. Where both
  // are set, the push depth is the deeper of the two.
  const pairs = [['allin1', 15, 11], ['allin2', 15, 11], ['monada', 14, 12], ['monada2', 14, 12],
    ['diada', 13, 10], ['diada2', 13, 10], ['triada', 11, 8], ['triada2', 11, 8]];
  for (const [id, push, sim] of pairs) {
    const r = READINGS.find((x) => x.id === id);
    ok(r.alertDepth === push && r.simDepth === sim,
      id + ' pushes at −' + push + ' and simulates at −' + sim,
      'push ' + r.alertDepth + ' sim ' + r.simDepth);
    ok(r.alertDepth > r.simDepth, 'and the push is the rarer of the two');
  }
  for (const id of ['enaduo', 'enaduo2']) {
    const r = READINGS.find((x) => x.id === id);
    ok(r.alertDepth === 6 && !r.simDepth, id + ' keeps one depth of −6 for both',
      JSON.stringify({ alert: r.alertDepth, sim: r.simDepth }));
  }
  // and the alert scan uses the push depth, never the simulation one
  const st = createAlertState();
  scan(st, [row({ allin1: -11 })], realOpts);
  ok(scan(st, [row({ allin1: -14 })], realOpts).length === 0,
    'All in 1 stays quiet at −14, its simulation depth notwithstanding');
  ok(scan(st, [row({ allin1: -15 })], realOpts).length === 1, 'and pushes at −15');
}

section('a reading can set its own push depth');
{
  // Andreas Deluxe moves constantly - a miss is 22/37 - so it must not push at the
  // global −4, or anywhere above its own much deeper threshold.
  const st = createAlertState();
  scan(st, [row({ andreas: -3 })], realOpts);
  ok(scan(st, [row({ andreas: -4 })], realOpts).length === 0,
    'Andreas Deluxe stays quiet at −4');
  ok(scan(st, [row({ andreas: -7 })], realOpts).length === 0, 'and at −7');
  const deep = scan(st, [row({ andreas: -8 })], realOpts);
  ok(deep.length === 1 && deep[0].label === 'Andreas Deluxe', 'and pushes at −8',
    JSON.stringify(deep.map((h) => h.label)));
  // a run reading keeps its own, much deeper threshold
  const st2 = createAlertState();
  scan(st2, [row({ monada: -13 })], realOpts);
  ok(scan(st2, [row({ monada: -14 })], realOpts).length === 1, 'Monada pushes at −14');

  // ALERT_DEPTHS overrides both the reading's own default and the global one
  const st3 = createAlertState();
  const tuned = { ...realOpts, depths: { andreas: 12, monada: 2 } };
  scan(st3, [row({ andreas: -9, monada: -1 })], tuned);
  ok(scan(st3, [row({ andreas: -11, monada: -1 })], tuned).length === 0,
    'a per-reading override can make Andreas quieter than its own default');
  const louder = scan(st3, [row({ andreas: -12, monada: -2 })], tuned);
  ok(louder.length === 2, 'and another reading louder', JSON.stringify(louder.map((h) => h.label)));
}
{
  // its message speaks in group-C terms, not A/B
  const r = READINGS.find((x) => x.id === 'andreas');
  const block = formatAlertBlock({
    table: 'Greek Roulette', provider: 'pragmatic', label: r.label, rule: r,
    count: -5, previous: -4, spins: [12, 7, 1, 4, 18], armed: false,
  });
  ok(block.split('\n')[0].startsWith('🎰'), 'the first line is the table', block.split('\n')[0]);
  ok(block.includes('⚪12') && block.includes('🟣10') === false,
    'non-members are marked as misses', block.split('\n')[2]);
  const withHit = formatAlertBlock({
    table: 'T', label: r.label, rule: r, count: -5, spins: [0, 1], armed: false,
  });
  ok(withHit.includes('🟣0') && withHit.includes('⚪1'), 'and members as hits',
    withHit.split('\n')[2]);
}
{
  // a message mixing thresholds states the shallowest one rather than claiming one depth
  const andreas = READINGS.find((x) => x.id === 'andreas');
  const monada = READINGS.find((x) => x.id === 'monada');
  const head = formatBatch([
    { table: 'T', label: 'Monada', rule: monada, count: -4, spins: [1] },
    { table: 'U', label: 'Andreas Deluxe', rule: andreas, count: -5, spins: [1] },
  ], 4, { tz: 'UTC' }).split('\n')[0];
  ok(head === '⚠️ <b>2 alerts</b>', 'a batch is headed by how many it carries', head);

  // and it follows the threshold actually in force, not the reading's default: an
  // ALERT_DEPTHS override was being reported with the wrong number in the message
  const st = createAlertState();
  const tuned = { ...realOpts, depths: { andreas: 3 } };
  scan(st, [row({ andreas: -1 })], tuned);
  const hit = scan(st, [row({ andreas: -3 })], tuned);
  ok(hit.length === 1 && hit[0].depth === 3, 'an alert carries the depth that fired it',
    JSON.stringify(hit.map((h) => h.depth)));
  ok(formatBatch(hit, 4, { tz: 'UTC' }).startsWith('🎰'),
    'a single alert is just its own block, with no header',
    formatBatch(hit, 4, { tz: 'UTC' }).split('\n')[0]);
}

section('arming one reading on one table');
{
  const st = createAlertState();
  const two = [row({}, { id: 'wheel1' }), row({}, { id: 'wheel2' })];
  // Andreas Deluxe on wheel1 only; wheel2 armed for Monada only
  const allow = (table, rdg) =>
    (table === 'wheel1' && rdg === 'andreas') || (table === 'wheel2' && rdg === 'monada');
  const o = { ...opts, allow };
  scan(st, two, o);
  const hits = scan(st, [
    row({ andreas: -4, monada: -4 }, { id: 'wheel1' }),
    row({ andreas: -4, monada: -4 }, { id: 'wheel2' }),
  ], o);
  ok(hits.length === 2, 'two alerts, one per armed pair', String(hits.length));
  const pairs = hits.map((h) => h.tableId + '/' + h.reading).sort().join(' ');
  ok(pairs === 'wheel1/andreas wheel2/monada',
    'each table only pushes the reading armed on it', pairs);
}
{
  // a pair armed later starts latched, exactly as a newly seen table does (§8.3)
  const st = createAlertState();
  const none = { ...opts, allow: () => false };
  scan(st, [row({ andreas: -9 }, { id: 'w' })], none);
  const justArmed = { ...opts, allow: (t, r) => r === 'andreas' };
  ok(scan(st, [row({ andreas: -9 }, { id: 'w' })], justArmed).length === 0,
    'arming a reading that is already deep stays silent');
  ok(scan(st, [row({ andreas: -10 }, { id: 'w' })], justArmed).length === 1,
    'and its next deepening pushes');
}

section('patterns switched off in Settings cannot push');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alertsw-'));
  const file = path.join(dir, 'alerts.json');
  const quietLog = { info() {}, warn() {}, error() {} };
  const ALL_IDS = ['monada', 'diada', 'andreas'];

  const sel = new AlertSelection({ file, log: quietLog });
  sel.toggleTable('t1', true);                       // every pattern on this table
  ok(sel.has('t1', 'monada') && sel.has('t1', 'andreas'), 'armed for everything to start');

  sel.setEnabled(['monada'], ALL_IDS);               // Settings: only Monada may alert
  ok(sel.has('t1', 'monada'), 'the enabled pattern still pushes');
  ok(!sel.has('t1', 'andreas') && !sel.has('t1', 'diada'),
    'a pattern switched off cannot push even on an armed table');
  ok(sel.enabledList(ALL_IDS).join() === 'monada', 'the list is what was chosen',
    sel.enabledList(ALL_IDS).join());

  // turning them all on is stored as "every pattern", so a new reading is on by default
  sel.setEnabled(ALL_IDS, ALL_IDS);
  ok(sel.allEnabled(), 'all of them means every pattern');
  ok(sel.has('t1', 'a-reading-added-later'), 'including one added afterwards');

  sel.toggleEnabled('andreas', false, ALL_IDS);
  const reloaded = new AlertSelection({ file, log: quietLog });
  ok(!reloaded.isEnabled('andreas') && reloaded.isEnabled('monada'),
    'the choice survives a restart', JSON.stringify(reloaded.enabledList(ALL_IDS)));
  fs.rmSync(dir, { recursive: true, force: true });
}

section('the selection survives a restart');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alertsel-'));
  const file = path.join(dir, 'alerts.json');
  const quietLog = { info() {}, warn() {}, error() {} };

  const ALL_IDS = ['monada', 'diada', 'andreas'];
  const a = new AlertSelection({ file, log: quietLog });
  ok(a.size === 0, 'a missing file is an empty selection');

  a.toggleTable('t1', true);
  ok(a.has('t1', 'monada') && a.has('t1', 'andreas'), 'a table armed whole covers every reading');
  ok(a.readingsFor('t1') === '*', "and is stored as '*', not a frozen list", String(a.readingsFor('t1')));

  a.toggleReading('t2', 'andreas', true, ALL_IDS);
  ok(a.has('t2', 'andreas') && !a.has('t2', 'monada'),
    'one reading on one table arms only that pair');
  ok(a.list().sort().join() === 't1,t2', 'both tables are listed', a.list().sort().join());

  // turning one reading off on an all-armed table expands it to the explicit rest
  a.toggleReading('t1', 'monada', false, ALL_IDS);
  ok(!a.has('t1', 'monada') && a.has('t1', 'diada') && a.has('t1', 'andreas'),
    'disarming one reading leaves the others armed', JSON.stringify(a.readingsFor('t1')));
  // and arming the last missing one collapses it back
  a.toggleReading('t1', 'monada', true, ALL_IDS);
  ok(a.readingsFor('t1') === '*', 'arming them all collapses back to every reading');

  const b = new AlertSelection({ file, log: quietLog });
  ok(b.has('t1', 'diada') && b.has('t2', 'andreas') && !b.has('t2', 'diada'),
    'reloaded from disk after a restart', JSON.stringify(b.map()));
  ok(b.pairs(3) === 4, 'pairs() counts reading slots', String(b.pairs(3)));

  b.set({ x: '*', y: ['andreas'], z: [] });
  ok(JSON.stringify(b.map()) === JSON.stringify({ x: '*', y: ['andreas'] }),
    'set() replaces, and drops a table with no readings', JSON.stringify(b.map()));
  b.clear();
  ok(b.size === 0 && new AlertSelection({ file, log: quietLog }).size === 0, 'clear() empties it');

  // the first version of this file stored a plain array; those tables were armed for all
  fs.writeFileSync(file, JSON.stringify({ tables: ['old1', 'old2'] }));
  const legacy = new AlertSelection({ file, log: quietLog });
  ok(legacy.has('old1', 'monada') && legacy.readingsFor('old2') === '*',
    'an older selection file loads as armed for every reading');

  fs.writeFileSync(file, '{ this is not json');
  const c = new AlertSelection({ file, log: quietLog });
  ok(c.size === 0, 'a corrupt file starts empty rather than throwing');
  fs.rmSync(dir, { recursive: true, force: true });
}

section('the bet group survives the moment an alert fires');
{
  // An alert fires on the spin that DEEPENED the count, by which point a run reading has
  // resolved its decider and is back to BUILDING. Reading the group off the state alone
  // produced nothing then, and the message lost its bet line entirely.
  const notArmed = (counts) => ({
    id: 't1', name: 'Greek Roulette', provider: 'pragmatic', desynced: false,
    spins: [12, 7, 0],
    reads: Object.fromEntries(READINGS.map((r) => [r.id, {
      count: counts[r.id] ?? 0, phase: 'BUILDING', runGroup: 'B', runLength: 2,
      originGroup: null, deepest: counts[r.id] ?? 0, resets: 0, spinsObserved: 9,
      lastEvent: 'COUNT',
    }])),
  });

  const oneWay = { monada: 'A', monada2: 'B', diada: 'A', diada2: 'B',
    triada: 'A', triada2: 'B', enaduo: 'A', enaduo2: 'B' };
  for (const [id, group] of Object.entries(oneWay)) {
    const depth = READINGS.find((r) => r.id === id).alertDepth;
    const st = createAlertState();
    scan(st, [notArmed({ [id]: -(depth - 1) })], realOpts);
    const hits = scan(st, [notArmed({ [id]: -depth })], realOpts);
    ok(hits.length === 1 && hits[0].bet === group,
      id + ' names group ' + group + ' even while unarmed',
      JSON.stringify(hits.map((h) => h.bet)));
    const block = formatAlertBlock(hits[0]);
    ok(block.split('BETLINE').length === 1 && /Bet on <b>Group/.test(block),
      id + ' keeps its bet line in the message', block.split('NEWLINE')[0]);
    ok(block.split(String.fromCharCode(10)).length === 4, 'four lines, as specified',
      String(block.split(String.fromCharCode(10)).length));
  }

  // The All in pair arm from either group, so between arms there is no single answer: the
  // message states the rule instead of guessing.
  for (const id of ['allin1', 'allin2']) {
    const depth = READINGS.find((r) => r.id === id).alertDepth;
    const st = createAlertState();
    scan(st, [notArmed({ [id]: -(depth - 1) })], realOpts);
    const hits = scan(st, [notArmed({ [id]: -depth })], realOpts);
    ok(hits.length === 1 && !hits[0].bet && hits[0].betHint,
      id + ' falls back to the rule in words', JSON.stringify(hits[0] && hits[0].betHint));
    ok(/Bet on whichever group/.test(formatAlertBlock(hits[0])),
      id + ' still has a bet line', formatAlertBlock(hits[0]).split(String.fromCharCode(10))[2]);
  }

  // and while it IS armed, the All in pair name the exact group
  const armed = (count) => ({
    id: 't2', name: 'Mega Roulette', provider: 'playtech', desynced: false, spins: [26, 14],
    reads: Object.fromEntries(READINGS.map((r) => [r.id, {
      count, phase: 'INTERRUPTED', runGroup: 'B', runLength: 1, originGroup: 'A',
      deepest: count, resets: 0, spinsObserved: 9, lastEvent: 'ARMED',
    }])),
  });
  const st2 = createAlertState();
  scan(st2, [armed(-14)], realOpts);
  const hits2 = scan(st2, [armed(-15)], realOpts);
  const one = hits2.find((h) => h.reading === 'allin1');
  const two = hits2.find((h) => h.reading === 'allin2');
  ok(one && one.bet === 'B', 'armed, All in 1 names the interrupting group', one && one.bet);
  ok(two && two.bet === 'A', 'armed, All in 2 names the origin group', two && two.bet);
}

section('message text');
const rule = (id) => READINGS.find((r) => r.id === id);
const alert = (o = {}) => ({
  table: 'Greek Roulette', provider: 'pragmatic', label: 'Monada', rule: rule('monada'),
  count: -4, previous: -3, spins: [12, 7, 0, 4, 18, 3], armed: false, bet: 'A', ...o,
});
{
  const line = formatAlert(alert());
  ok(line.includes('−4') && line.includes('Monada') && line.includes('Greek Roulette'),
    'the plain one-line form carries depth, reading and table', line);
  ok(formatAlert('already a string') === 'already a string', 'strings pass through');
}
{
  // the feed delivers newest first, and the strip keeps that order: the spin that just
  // landed is the one people look for, and the wall shows it the same way round
  const strip = spinStrip([12, 7, 0]);
  ok(strip === '🟠12 🔵7 🔵0', 'the strip is newest-first and group-coloured', strip);
  ok(spinStrip([]) === '', 'no spins is empty, not a stray marker');
}
{
  // table, pattern and count, the group to bet with its colour and numbers, then the
  // recent spins - in that order
  const lines = formatAlertBlock(alert({ bet: 'A' })).split('\n');
  ok(lines.length === 4, 'a block with a bet group is four lines', String(lines.length));
  ok(lines[0].startsWith('🎰') && lines[0].includes('<b>Greek Roulette</b>') &&
    lines[0].includes('(pragmatic)'), 'line 1: the table and its provider', lines[0]);
  ok(lines[1].startsWith('🎯') && lines[1].includes('<b>Monada</b>') &&
    lines[1].includes('−4'), 'line 2: the pattern and the count', lines[1]);
  ok(lines[2].startsWith('🎲') && lines[2].includes('Group A') &&
    lines[2].includes('Blue'), 'line 3: the group to bet, named and coloured', lines[2]);
  ok(lines[3].includes('🟠12') && lines[3].includes('🔵7'),
    'line 4: the recent numbers, newest first', lines[3]);
  ok(!/[0-9] {2}[0-9]/.test(lines[2]), 'and the group numbers are not listed out', lines[2]);

  // the colour follows the group, not the reading
  const b = formatAlertBlock(alert({ bet: 'B' })).split('\n');
  ok(b[2].includes('Group B') && b[2].includes('Orange') && b[2].includes('🟠'),
    'group B is orange', b[2]);
  const c = formatAlertBlock(alert({ bet: 'C', rule: rule('andreas'), label: 'Andreas Deluxe' })).split('\n');
  ok(c[2].includes('Group C') && c[2].includes('Purple') && c[2].includes('🟣'),
    'group C is purple', c[2]);

  // without a bet group it is just the three lines
  ok(formatAlertBlock(alert({ bet: null })).split('\n').length === 3,
    'no bet group means no bet lines');
}
{
  // table names come from the operators; one with HTML in it must not break the message
  const block = formatAlertBlock(alert({ table: 'Roulette <b>&</b> Co' }));
  ok(block.includes('Roulette &lt;b&gt;&amp;lt;') === false, 'escaping is applied once');
  ok(block.includes('&lt;b&gt;&amp;&lt;/b&gt;'), 'angle brackets and ampersands are escaped', block);
}
{
  const one = formatBatch([alert()], 4, { tz: 'UTC' });
  ok(one.startsWith('🎰 <b>Greek Roulette</b>'), 'one alert starts with its table',
    one.split('\n')[0]);
  ok(!one.includes('tables'), 'a single alert does not say "1 tables"');
  const three = formatBatch([alert(), alert(), alert()], 4, { tz: 'UTC' });
  ok(three.startsWith('⚠️ <b>3 alerts</b>'), 'several alerts are counted in the header',
    three.split('\n')[0]);
  ok(three.split('\n\n').length === 4, 'few alerts are separate blocks', String(three.split('\n\n').length));
  const six = formatBatch(Array.from({ length: 6 }, () => alert()), 4, { tz: 'UTC' });
  ok(six.split('\n').filter((l) => l.includes('Monada')).length === 6,
    'a burst collapses to one line each');
  ok(!six.includes('next spin decides'), 'the compact form drops the extra lines');
  const linked = formatBatch([alert()], 4, { tz: 'UTC', link: 'http://localhost:3001/patterns' });
  ok(linked.includes('📊 http://localhost:3001/patterns'), 'a link is appended when configured');
}

section('the queue against Telegram limits');
const fakeApi = (opts = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (opts.rateLimitFirst && calls.length === 1) {
      return { ok: false, status: 429, json: async () => ({ ok: false, parameters: { retry_after: 0 } }) };
    }
    if (opts.badMarkupFirst && calls.length === 1) {
      return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities: unexpected end tag" }) };
    }
    if (opts.chatNotFound) {
      return { ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: calls.length, chat: { id: -1, title: 'g' } } }) };
  };
  return { calls, fetchImpl };
};
const quiet = { info() {}, warn() {}, error() {} };

{
  const tg = new Telegram({ token: 't', chatId: '-1', log: quiet, fetchImpl: () => {}, flushMs: 10 });
  ok(tg.configured, 'configured with both values');
  ok(!new Telegram({ token: 't', log: quiet }).configured, 'not configured without a chat id');
  ok(!new Telegram({ chatId: '-1', log: quiet }).configured, 'not configured without a token');
}
{
  // 12 alerts in one tick must become ONE message, not 12
  const { calls, fetchImpl } = fakeApi();
  const tg = new Telegram({ token: 't', chatId: '-1', log: quiet, fetchImpl, flushMs: 10 });
  tg.enqueue(Array.from({ length: 12 }, (_, i) => 'alert ' + i));
  await sleep(80);
  ok(calls.length === 1, '12 alerts coalesce into one message', 'sent ' + calls.length);
  ok((calls[0].text.match(/alert \d+/g) || []).length === 12, 'all 12 lines are in it');
  ok(calls[0].text.startsWith('⚠️ <b>12 alerts</b>'),
    'the header counts what the message carries', calls[0].text.split('\n')[0]);
}
{
  // the per-minute bucket holds the rest back rather than letting Telegram throttle us.
  // flush() is driven directly: a timer-based version of this test passes or fails on
  // Windows timer drift rather than on the behaviour.
  const { calls, fetchImpl } = fakeApi();
  const tg = new Telegram({ token: 't', chatId: '-1', log: quiet, fetchImpl, flushMs: 60000, maxPerMinute: 2 });
  tg.enqueue(['batch 0']); await tg.flush();
  tg.enqueue(['batch 1']); await tg.flush();
  tg.enqueue(['batch 2']); await tg.flush();
  ok(calls.length === 2, 'maxPerMinute caps sends', 'sent ' + calls.length);
  ok(tg.pending.length === 1 && tg.pending[0] === 'batch 2',
    'the rest stays queued rather than being dropped', JSON.stringify(tg.pending));
}
{
  // a 429 must not lose the alerts it could not send
  const { calls, fetchImpl } = fakeApi({ rateLimitFirst: true });
  const tg = new Telegram({ token: 't', chatId: '-1', log: quiet, fetchImpl, flushMs: 60000 });
  tg.enqueue(['important alert']);
  await tg.flush();                       // 429
  ok(calls.length === 1 && tg.pending.length === 1,
    'a 429 puts the alert back on the queue', JSON.stringify(tg.status()));
  ok(tg.blockedUntil > 0, 'and records how long to wait');
  await tg.flush();                       // retry_after was 0, so this one goes out
  ok(calls.length === 2 && calls[1].text.includes('important alert'),
    'the alert survives the 429', 'calls ' + calls.length);
  ok(tg.pending.length === 0 && tg.sent === 1, 'and is delivered once', JSON.stringify(tg.status()));
}
{
  // the coalescing path still has to work on its own timer
  const { calls, fetchImpl } = fakeApi();
  const tg = new Telegram({ token: 't', chatId: '-1', log: quiet, fetchImpl, flushMs: 10 });
  tg.enqueue(['one']);
  tg.enqueue(['two']);
  await sleep(120);
  ok(calls.length === 1 && /one[\s\S]*two/.test(calls[0].text),
    'alerts queued between flushes go out together', 'calls ' + calls.length);
}
{
  // a queue that never drains must not grow for the lifetime of the server
  const { fetchImpl } = fakeApi({ chatNotFound: true });
  const tg = new Telegram({ token: 't', chatId: '1', log: quiet, fetchImpl, flushMs: 60000 });
  tg.enqueue(Array.from({ length: 250 }, (_, i) => 'a' + i));
  ok(tg.pending.length === 200, 'the queue is capped at 200', String(tg.pending.length));
  ok(tg.pending[0] === 'a50' && tg.pending[199] === 'a249',
    'the newest alerts are the ones kept', tg.pending[0] + '..' + tg.pending[199]);
  ok(tg.dropped === 50, 'drops are counted', String(tg.dropped));
}
{
  // repeated failures back off instead of hammering the API every few seconds
  const { fetchImpl } = fakeApi({ chatNotFound: true });
  const tg = new Telegram({ token: 't', chatId: '1', log: quiet, fetchImpl, flushMs: 1000 });
  tg.enqueue(['x']);
  const seen = [];
  for (let i = 0; i < 3; i++) { await tg.flush(); seen.push(tg.backoffMs); }
  ok(seen.join(',') === '2000,4000,8000', 'the retry delay doubles', seen.join(','));
  ok(tg.streak === 3 && tg.failed === 3, 'failures are counted', JSON.stringify(tg.status()));
  // and a success clears it
  const good = fakeApi();
  tg.fetch = good.fetchImpl;
  await tg.flush();
  ok(tg.streak === 0 && tg.backoffMs === 0 && tg.pending.length === 0,
    'a success resets the backoff and drains the queue', JSON.stringify(tg.status()));
}
{
  // markup Telegram refuses must not cost us the alert
  const { calls, fetchImpl } = fakeApi({ badMarkupFirst: true });
  const tg = new Telegram({ token: 't', chatId: '-1', log: quiet, fetchImpl, flushMs: 60000 });
  const r = await tg.send('<b>deep</b> count');
  ok(r.ok && calls.length === 2, 'a rejected tag is resent as plain text', 'calls ' + calls.length);
  ok(calls[0].parse_mode === 'HTML' && !calls[1].parse_mode, 'the retry drops parse_mode');
  ok(calls[1].text === 'deep count', 'and the tags are stripped', calls[1].text);
}
{
  // one message describes at most 12 alerts; the rest wait for the next
  const { calls, fetchImpl } = fakeApi();
  const tg = new Telegram({ token: 't', chatId: '-1', log: quiet, fetchImpl, flushMs: 60000 });
  tg.enqueue(Array.from({ length: 20 }, (_, i) => 'line ' + i));
  await tg.flush();
  ok(calls.length === 1 && tg.pending.length === 8, 'a batch is capped at 12 per message',
    'queued ' + tg.pending.length);
  ok(calls[0].text.includes('line 11') && !calls[0].text.includes('line 12'),
    'in order, oldest first');
}
{
  // the two configuration mistakes that read like bugs
  const { fetchImpl } = fakeApi({ chatNotFound: true });
  const tg = new Telegram({ token: 't', chatId: '999', log: quiet, fetchImpl });
  let msg = '';
  try { await tg.send('x'); } catch (e) { msg = e.message; }
  ok(/chat not found/.test(msg) && /negative/.test(msg),
    'a wrong chat id explains itself', msg);
}
{
  const tg = new Telegram({ log: quiet });
  let msg = '';
  try { await tg.send('x'); } catch (e) { msg = e.message; }
  ok(/TELEGRAM_BOT_TOKEN/.test(msg), 'sending while unconfigured says what is missing', msg);
  tg.enqueue(['x']);
  ok(tg.pending.length === 0, 'enqueue is a no-op while unconfigured');
}

section('the log of what was pushed');
{
  const log = new AlertLog({ limit: 5 });
  const mk = (id, count) => ({
    tableId: 't' + id, table: 'Table ' + id, provider: 'pragmatic', reading: 'monada',
    label: 'Monada', rule: READINGS.find((r) => r.id === 'monada'), count, previous: count + 1,
    spins: [1, 2, 3],
  });
  const rows = log.add([mk(1, -12), mk(2, -13)]);
  ok(rows.length === 2 && rows.every((r) => r.status === 'queued'), 'alerts start queued');
  // the row carries the depth that actually fired it - Monada's push depth
  ok(rows[0].depth === 14, 'the threshold that fired is recorded', String(rows[0].depth));
  ok(log.stats().held === 2, 'and are counted as waiting', JSON.stringify(log.stats()));

  log.sent(rows, 'the message text');
  ok(rows.every((r) => r.status === 'sent' && r.text === 'the message text' && r.sentAt),
    'sending marks them with the text that went out');
  ok(log.stats().sent === 2 && log.stats().held === 0, 'and they stop waiting',
    JSON.stringify(log.stats()));

  // a failure is not final: the queue retries, so the row stays queued with the reason
  const more = log.add([mk(3, -12)]);
  log.failed(more, 'Unauthorized');
  ok(more[0].status === 'queued' && more[0].error === 'Unauthorized',
    'a failure records the reason and keeps the row queued', more[0].status);
  // dropped is the one case where it really never arrived
  log.dropped(more);
  ok(more[0].status === 'dropped' && log.stats().dropped === 1, 'dropping is recorded as such');

  // the log is a window, not a ledger
  for (let i = 0; i < 10; i++) log.add([mk(10 + i, -12)]);
  ok(log.list(100).length === 5, 'it keeps only the most recent entries', String(log.list(100).length));
  ok(log.list(100)[0].table === 'Table 19', 'newest first', log.list(100)[0].table);
  ok(log.list(2).length === 2, 'and honours a limit');
}
{
  // the queue tells the log what happened, including which alerts it dropped
  const { fetchImpl } = fakeApi({ chatNotFound: true });
  const seen = { sent: 0, failed: 0, dropped: 0 };
  const tg = new Telegram({
    token: 't', chatId: '-1', log: quiet, fetchImpl, flushMs: 60000,
    onSent: (items) => { seen.sent += items.length; },
    onFailed: (items) => { seen.failed += items.length; },
    onDropped: (items) => { seen.dropped += items.length; },
  });
  tg.enqueue(['a']);
  await tg.flush();
  ok(seen.failed === 1 && seen.sent === 0, 'a failure is reported', JSON.stringify(seen));
  tg.enqueue(Array.from({ length: 250 }, (_, i) => 'x' + i));
  ok(seen.dropped === 51, 'and so is every alert the queue had to drop', JSON.stringify(seen));

  const ok2 = fakeApi();
  tg.fetch = ok2.fetchImpl;
  await tg.flush();
  ok(seen.sent === 12, 'a successful batch reports exactly what went out', JSON.stringify(seen));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
