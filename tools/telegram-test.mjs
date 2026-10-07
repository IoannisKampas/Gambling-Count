// Send one test message, so a misconfigured bot is found now rather than at −4.
//
//   npm run tg:test
//   npm run tg:test -- --many          the compact layout a burst uses
//   npm run tg:test -- "your own text"
//
// Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. Prints what Telegram said, including
// the two mistakes that read like bugs: a wrong chat id ("chat not found") and a bot
// that is no longer in the group.

import { Telegram } from '../src/telegram.mjs';
import { formatBatch } from '../src/alerts.mjs';
import { READINGS } from '../src/patterns.mjs';

const tg = new Telegram({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  depth: Number(process.env.ALERT_DEPTH || 4),
});

if (!tg.configured) {
  console.error('set both first:');
  console.error('  export TELEGRAM_BOT_TOKEN=123456:AA...');
  console.error('  export TELEGRAM_CHAT_ID=-1001234567890      # npm run tg:chat finds it');
  process.exit(1);
}

// Sends the real thing rather than a "test" string: the point is to see on a phone
// exactly what the group will get. `--many` shows the compact layout a burst uses.
const args = process.argv.slice(2);
const custom = args.filter((a) => !a.startsWith('--')).join(' ').trim();
const rule = (id) => READINGS.find((r) => r.id === id);
const sample = (id, count, table, provider, spins, bet = 'A') =>
  ({ label: rule(id).label, rule: rule(id), count, table, provider, spins, bet,
    depth: rule(id).alertDepth });

const items = args.includes('--many')
  ? [
    sample('monada', -14, 'Brazilian Roulette', 'pragmatic', [12, 7, 0, 4, 18, 3], 'A'),
    sample('triada2', -11, 'French Roulette la Partage', 'pragmatic', [21, 33, 5, 16, 9, 2], 'B'),
    sample('allin1', -15, 'Mega Roulette 3000', 'playtech', [26, 14, 29, 11, 36, 20], 'B'),
    sample('diada', -13, 'Turkish Mega Roulette', 'pragmatic', [8, 15, 22, 31, 1, 17], 'A'),
    sample('enaduo2', -6, 'Speed Auto Roulette', 'pragmatic', [3, 24, 30, 6, 13, 35], 'B'),
    sample('andreas', -8, 'Roulette Italia Tricolore', 'pragmatic', [19, 1, 7, 11, 36, 2], 'C'),
  ]
  : [sample('monada', -14, 'Brazilian Roulette', 'pragmatic', [12, 7, 0, 4, 18, 3], 'A')];

const text = custom || formatBatch(items, Number(process.env.ALERT_DEPTH || 4), {
  tz: process.env.ALERT_TZ || 'Europe/Athens',
  link: process.env.ALERT_LINK || '',
});

try {
  const r = await tg.send(text);
  console.log('sent to chat ' + (r.result.chat.title || r.result.chat.id) +
    ' (message ' + r.result.message_id + ')');
} catch (e) {
  console.error('failed: ' + e.message);
  process.exit(1);
}
