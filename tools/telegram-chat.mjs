// Find the chat id to push alerts to.
//
//   npm run tg:chat
//
// Telegram does not show a group's id anywhere in the app, so the only way to learn it
// is to have the bot receive a message in that group and read it off the update.
//
// Setup, once:
//   1. message @BotFather -> /newbot -> copy the token
//   2. add the bot to your group
//   3. send any message in the group that mentions it, e.g.  /start@your_bot
//   4. export TELEGRAM_BOT_TOKEN=... and run this
//
// Group ids are negative (-100…); a private chat with you is positive.
//
// The work is inside main() so each check can simply return. Exiting mid-flight right
// after a fetch trips a libuv assertion on Windows, so the exit code is set and the
// process is left to end on its own.

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const api = (method) => 'https://api.telegram.org/bot' + token + '/' + method;

async function main() {
  if (!token) {
    console.error('set TELEGRAM_BOT_TOKEN first:  export TELEGRAM_BOT_TOKEN=123456:AA...');
    return 1;
  }

  const me = await fetch(api('getMe')).then((r) => r.json())
    .catch((e) => ({ ok: false, description: e.message }));
  if (!me.ok) {
    console.error('the token was rejected: ' + (me.description || 'unknown error'));
    return 1;
  }
  console.log('bot: @' + me.result.username + '  (' + me.result.first_name + ')\n');

  const updates = await fetch(api('getUpdates') + '?limit=100').then((r) => r.json())
    .catch((e) => ({ ok: false, description: e.message }));
  if (!updates.ok) {
    console.error('getUpdates failed: ' + (updates.description || 'unknown error'));
    return 1;
  }

  const chats = new Map();
  for (const u of updates.result) {
    const msg = u.message || u.edited_message || u.channel_post || u.my_chat_member;
    const chat = msg && msg.chat;
    if (chat) chats.set(chat.id, chat);
  }

  if (!chats.size) {
    console.log('No chats seen yet. Add the bot to the group, then send a message there');
    console.log('mentioning it (/start@' + me.result.username + ') and run this again.');
    console.log('');
    console.log('If the bot IS in the group but sees nothing, privacy mode is on:');
    console.log('BotFather -> /mybots -> your bot -> Bot Settings -> Group Privacy -> Turn off.');
    return 2;
  }

  console.log('chats this bot can see:\n');
  for (const c of chats.values()) {
    console.log('  ' + String(c.id).padEnd(16) + (c.type || '').padEnd(12) + (c.title || c.username || ''));
  }
  console.log('\nUse the group id (negative) as TELEGRAM_CHAT_ID, then:  npm run tg:test');
  return 0;
}

process.exitCode = await main();
