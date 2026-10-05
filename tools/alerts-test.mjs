// The push-notification contract: what gets alerted, what must stay silent, and how
// the queue behaves against Telegram's limits.
// Run: node tools/alerts-test.mjs   (npm run test:alerts)
import {
  createAlertState, scan, formatAlert, formatAlertBlock, formatBatch, spinStrip,
} from '../src/alerts.mjs';
import { Telegram } from '../src/telegram.mjs';
import { READINGS } from '../src/patterns.mjs';

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
const opts = { depth: 4, readings: READINGS };

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
  const st = createAlertState();
  scan(st, [row({})], { ...opts, depth: 2 });
  ok(scan(st, [row({ monada: -2 })], { ...opts, depth: 2 }).length === 1, 'depth is configurable');
}

section('message text');
const rule = (id) => READINGS.find((r) => r.id === id);
const alert = (o = {}) => ({
  table: 'Greek Roulette', provider: 'pragmatic', label: 'Monada', rule: rule('monada'),
  count: -4, previous: -3, spins: [12, 7, 0, 4, 18, 3], armed: false, ...o,
});
{
  const line = formatAlert(alert());
  ok(line.includes('−4') && line.includes('Monada') && line.includes('Greek Roulette'),
    'the plain one-line form carries depth, reading and table', line);
  ok(formatAlert('already a string') === 'already a string', 'strings pass through');
}
{
  // spins arrive newest first and must read oldest -> newest, coloured by group
  const strip = spinStrip([12, 7, 0]);
  ok(strip === '🔵0 🔵7 🟠12', 'the strip is oldest-first and group-coloured', strip);
  ok(spinStrip([]) === '', 'no spins is empty, not a stray marker');
}
{
  const block = formatAlertBlock(alert({ armed: true }));
  const lines = block.split('\n');
  ok(lines.length === 4, 'an armed block is four lines', String(lines.length));
  ok(lines[0].includes('🔵') && lines[0].includes('<b>Monada</b>') && lines[0].includes('−4'),
    'line 1: group colour, reading, depth', lines[0]);
  ok(lines[1].includes('<b>Greek Roulette</b>'), 'line 2: the table in bold', lines[1]);
  ok(lines[3].includes('next spin decides'), 'line 4: only when armed', lines[3]);
  ok(formatAlertBlock(alert({ armed: false })).split('\n').length === 3,
    'an unarmed block drops that line');
  ok(formatAlertBlock(alert({ rule: rule('allin1'), label: 'All in 1' })).startsWith('⚪'),
    'the All in pair take neither group colour');
  ok(formatAlertBlock(alert({ rule: rule('monada2'), label: 'Monada 2' })).startsWith('🟠'),
    'a group-B reading is orange');
}
{
  // table names come from the operators; one with HTML in it must not break the message
  const block = formatAlertBlock(alert({ table: 'Roulette <b>&</b> Co' }));
  ok(block.includes('Roulette &lt;b&gt;&amp;lt;') === false, 'escaping is applied once');
  ok(block.includes('&lt;b&gt;&amp;&lt;/b&gt;'), 'angle brackets and ampersands are escaped', block);
}
{
  const one = formatBatch([alert()], 4, { tz: 'UTC' });
  ok(one.startsWith('🎯 <b>−4 or deeper</b>'), 'the header states the threshold', one.split('\n')[0]);
  ok(!one.includes('tables'), 'a single alert does not say "1 tables"');
  const three = formatBatch([alert(), alert(), alert()], 4, { tz: 'UTC' });
  ok(three.includes('3 tables'), 'several alerts are counted in the header');
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
  ok(calls[0].text.startsWith('🎯 <b>−4 or deeper</b>') && calls[0].text.includes('12 tables'),
    'the header states the threshold and counts them', calls[0].text.split('\n')[0]);
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
