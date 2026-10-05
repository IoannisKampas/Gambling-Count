// Send one test message, so a misconfigured bot is found now rather than at −4.
//
//   npm run tg:test
//   npm run tg:test -- "your own text"
//
// Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. Prints what Telegram said, including
// the two mistakes that read like bugs: a wrong chat id ("chat not found") and a bot
// that is no longer in the group.

import { Telegram } from '../src/telegram.mjs';
import { formatAlert } from '../src/alerts.mjs';

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

const custom = process.argv.slice(2).join(' ').trim();
// a real alert line, so you see exactly what a −4 will look like in the group
const sample = formatAlert({
  table: 'Greek Roulette', provider: 'pragmatic', label: 'Monada',
  count: -4, previous: -3, spins: [17, 4, 9, 3, 26, 12], armed: false,
});
const text = custom || 'Pattern monitor test — alerts will look like this:\n\n' + sample;

try {
  const r = await tg.send(text);
  console.log('sent to chat ' + (r.result.chat.title || r.result.chat.id) +
    ' (message ' + r.result.message_id + ')');
} catch (e) {
  console.error('failed: ' + e.message);
  process.exit(1);
}
