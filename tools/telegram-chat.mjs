// Find the chat id to push alerts to.
//
//   npm run tg:chat
//
// Telegram does not tell you a group's id anywhere in the app, so the only way to learn
// it is to have the bot receive a message in that group and read it off the update.
//
// Setup, once:
//   1. message @BotFather -> /newbot -> copy the token
//   2. add the bot to your group
//   3. send any message in the group that mentions it, e.g.  /start@your_bot
//   4. export TELEGRAM_BOT_TOKEN=... and run this
//
// Group ids are negative (-100…); a private chat with you is positive.

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) {
  console.error('set TELEGRAM_BOT_TOKEN first:  export TELEGRAM_BOT_TOKEN=123456:AA...');
  process.exit(1);
}

const api = (method) => 'https://api.telegram.org/bot' + token + '/' + method;

const me = await fetch(api('getMe')).then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));
if (!me.ok) {
  console.error('the token was rejected: ' + (me.description || 'unknown error'));
  process.exit(1);
}
console.log('bot: @' + me.result.username + '  (' + me.result.first_name + ')\n');

const updates = await fetch(api('getUpdates') + '?limit=100').then((r) => r.json());
if (!updates.ok) {
  console.error('getUpdates failed: ' + updates.description);
  process.exit(1);
}

const chats = new Map();
for (const u of updates.result) {
  const msg = u.message || u.edited_message || u.channel_post || u.my_chat_member;
  const chat = msg && msg.chat;
  if (chat) chats.set(chat.id, chat);
}

if (!chats.size) {
  console.log('No chats seen yet. Send a message in the group (mentioning the bot, or');
  console.log('/start@' + me.result.username + '), then run this again.');
  console.log('');
  console.log('If the bot is in the group but sees nothing, Telegram privacy mode is on:');
  console.log('BotFather -> /mybots -> your bot -> Bot Settings -> Group Privacy -> Turn off.');
  process.exit(2);
}

console.log('chats this bot can see:\n');
for (const c of chats.values()) {
  console.log('  ' + String(c.id).padEnd(16) + (c.type || '').padEnd(10) + (c.title || c.username || ''));
}
console.log('\nUse the group id (negative) as TELEGRAM_CHAT_ID, then:  npm run tg:test');
