// Telegram push for deep pattern counts. Sending only; this bot reads no commands.
//
// Telegram's group limit is about 20 messages per MINUTE (not per second), and a deep
// run across hundreds of tracked table/reading pairs can produce a burst of alerts in
// one tick. One message per alert would therefore be throttled within seconds and the
// interesting ones would be the ones dropped. So:
//
//   * alerts are queued and coalesced into ONE message every few seconds
//   * a token bucket keeps us under the per-minute limit with headroom
//   * a 429 is obeyed for exactly as long as it asks (retry_after), and the lines that
//     did not go out are put back at the front of the queue rather than lost
//
// Configure with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. The token is never logged.

import { formatBatch } from './alerts.mjs';

const API = 'https://api.telegram.org/bot';
// Telegram's hard cap is 4096 characters; leave room for the header and a long name.
const MAX_TEXT = 3800;
// A queue that never drains - a wrong token, a bot removed from the group - would
// otherwise grow for as long as the server runs. Keep the newest, since a deep count
// from an hour ago is not news, and say so when dropping.
const MAX_QUEUE = 200;
// How many alerts one message may describe. Beyond this the message stops being
// readable on a phone, and the rest are better off in the next one a few seconds later.
const MAX_ITEMS = 12;

export class Telegram {
  constructor({
    token, chatId, log = console, depth = 4,
    flushMs = 4000, maxPerMinute = 15, fetchImpl = fetch,
    tz = 'Europe/Athens', link = '', format = formatBatch,
    // Told what actually happened to each alert, so the app can show the group's feed
    // back to whoever is not holding the phone. All three are optional.
    onSent = null, onFailed = null, onDropped = null,
  } = {}) {
    this.onSent = onSent;
    this.onFailed = onFailed;
    this.onDropped = onDropped;
    this.tz = tz;
    this.link = link;
    this.format = format;
    this.token = String(token || '').trim();
    this.chatId = String(chatId || '').trim();
    this.log = log;
    this.depth = depth;
    this.flushMs = flushMs;
    this.maxPerMinute = maxPerMinute;
    this.fetch = fetchImpl;
    this.pending = [];
    this.sentAt = [];        // timestamps of recent sends, for the bucket
    this.timer = null;
    this.blockedUntil = 0;   // set by a 429
    this.sent = 0;
    this.failed = 0;
    this.dropped = 0;
    this.streak = 0;         // consecutive failures, for the retry backoff
  }

  get configured() { return !!(this.token && this.chatId); }

  status() {
    return {
      configured: this.configured,
      chatId: this.chatId || null,
      queued: this.pending.length,
      sent: this.sent,
      failed: this.failed,
      dropped: this.dropped,
      throttledFor: Math.max(0, Math.round((this.blockedUntil - Date.now()) / 1000)),
    };
  }

  enqueue(lines) {
    if (!this.configured || !lines || !lines.length) return;
    this.pending.push(...lines);
    if (this.pending.length > MAX_QUEUE) {
      const lost = this.pending.length - MAX_QUEUE;
      const gone = this.pending.slice(0, lost);
      this.pending = this.pending.slice(-MAX_QUEUE);
      this.dropped += lost;
      if (this.onDropped) { try { this.onDropped(gone); } catch {} }
      this.log.warn('telegram: dropped ' + lost + ' stale alert' + (lost === 1 ? '' : 's') +
        ' (' + this.dropped + ' total) - the queue is not draining');
    }
    this.#schedule(this.flushMs);
  }

  #schedule(ms) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((e) => this.log.warn('telegram: ' + e.message));
    }, Math.max(50, ms));
    // never the reason the process stays alive
    if (this.timer.unref) this.timer.unref();
  }

  // Send as much of the queue as the limits allow, and come back for the rest.
  async flush() {
    if (!this.pending.length) return;
    const now = Date.now();

    if (now < this.blockedUntil) { this.#schedule(this.blockedUntil - now); return; }
    this.sentAt = this.sentAt.filter((t) => now - t < 60000);
    if (this.sentAt.length >= this.maxPerMinute) {
      this.#schedule(60000 - (now - this.sentAt[0]));
      return;
    }

    const batch = this.pending.splice(0, MAX_ITEMS);
    let text = this.#render(batch);
    // one message has to fit Telegram's limit; hand the tail back rather than truncate
    while (text.length > MAX_TEXT && batch.length > 1) {
      this.pending.unshift(batch.pop());
      text = this.#render(batch);
    }

    let delay = this.flushMs;
    try {
      await this.send(text);
      this.sent += 1;
      this.streak = 0;
      this.backoffMs = 0;
      this.log.info('telegram: pushed ' + batch.length + ' alert' + (batch.length === 1 ? '' : 's') +
        (this.pending.length ? ', ' + this.pending.length + ' queued' : ''));
      if (this.onSent) { try { this.onSent(batch, text); } catch {} }
    } catch (e) {
      this.failed += 1;
      this.streak += 1;
      this.pending.unshift(...batch);     // nothing is dropped on a failure
      // Back off rather than retrying every few seconds: the usual causes (bad token,
      // bot removed) do not fix themselves, and hammering the API is how a bot gets
      // blocked outright. Doubles up to a minute, and resets on the next success.
      this.backoffMs = Math.min(60000, this.flushMs * 2 ** Math.min(this.streak, 6));
      delay = this.backoffMs;
      this.log.warn('telegram: ' + e.message + ' (' + this.pending.length + ' queued, retrying in ' +
        Math.round(delay / 1000) + 's)');
      if (this.onFailed) { try { this.onFailed(batch, e.message); } catch {} }
    }
    if (this.pending.length) this.#schedule(delay);
  }

  #render(items) {
    return this.format(items, this.depth, { tz: this.tz, link: this.link });
  }

  // One sendMessage call. Throws with something readable; never includes the token.
  //
  // `html` false retries the same text with the markup stripped: an alert is worth more
  // than its formatting, and a table name that breaks the HTML parser should not be the
  // reason nobody hears about a −6.
  async send(text, html = true) {
    if (!this.configured) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set');
    let r;
    try {
      r = await this.fetch(API + this.token + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: html ? text : text.replace(/<[^>]+>/g, ''),
          disable_web_page_preview: true,
          ...(html ? { parse_mode: 'HTML' } : {}),
        }),
      });
    } catch (e) {
      throw new Error('cannot reach api.telegram.org: ' + e.message);
    }
    const body = await r.json().catch(() => ({}));

    if (r.status === 429) {
      // retry_after can legitimately be 0, so test for a number rather than truthiness
      const secs = body.parameters && body.parameters.retry_after;
      const wait = (Number.isFinite(secs) ? secs : 30) * 1000;
      this.blockedUntil = Date.now() + wait;
      throw new Error('rate limited for ' + Math.round(wait / 1000) + 's');
    }
    if ((!r.ok || body.ok === false) && html && /parse entities|unsupported start tag|tag .* is unsupported/i.test(body.description || '')) {
      this.log.warn('telegram: markup rejected (' + body.description + ') - resending as plain text');
      return this.send(text, false);
    }
    if (!r.ok || body.ok === false) {
      // 400 "chat not found" and 403 "bot was kicked" are the two configuration
      // mistakes worth naming, because the description alone reads like a bug.
      const why = body.description || 'HTTP ' + r.status;
      const hint = /chat not found/i.test(why)
        ? ' - check TELEGRAM_CHAT_ID (a group id is negative, e.g. -1001234567890) and that the bot is in the group'
        : /kicked|not a member|forbidden/i.test(why)
          ? ' - the bot is not in that group any more'
          : '';
      throw new Error(why + hint);
    }
    this.sentAt.push(Date.now());
    return body;
  }
}
