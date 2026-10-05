// What has actually been pushed to Telegram, so it can be read back in the app.
//
// The group itself is the real record, but it is a chat on somebody's phone: it cannot
// answer "did this table alert while I was out?", "is anything stuck in the queue?" or
// "what exactly did it say?". This keeps the last few hundred alerts with their status,
// which is what the /alerts page shows.
//
// Memory only, deliberately: it is a view of this process's recent behaviour, not a
// record to be relied on across restarts, and writing every alert to disk would mean
// fsync traffic on a VPS for something nobody audits later.

const LIMIT = 300;

let seq = 0;

export class AlertLog {
  constructor({ limit = LIMIT } = {}) {
    this.limit = limit;
    this.entries = [];          // newest first
    this.counts = { queued: 0, sent: 0, failed: 0, dropped: 0 };
  }

  // Record alerts as queued. Returns the entries, which the caller hands back on
  // success or failure so the same rows can be updated.
  add(alerts, depths = {}) {
    const at = Date.now();
    const made = (alerts || []).map((a) => ({
      id: ++seq,
      at,
      tableId: a.tableId,
      table: a.table,
      provider: a.provider,
      reading: a.reading,
      label: a.label,
      side: (a.rule && a.rule.side) || null,
      count: a.count,
      previous: a.previous,
      depth: depths[a.reading] || (a.rule && a.rule.alertDepth) || null,
      spins: a.spins || [],
      status: 'queued',
      error: null,
      sentAt: null,
      text: null,
    }));
    this.entries.unshift(...made);
    this.counts.queued += made.length;
    if (this.entries.length > this.limit) this.entries.length = this.limit;
    return made;
  }

  sent(entries, text) {
    const when = Date.now();
    for (const e of entries || []) {
      if (!e || typeof e !== 'object') continue;
      if (e.status === 'queued') this.counts.queued--;
      e.status = 'sent';
      e.sentAt = when;
      e.error = null;
      e.text = text || null;
      this.counts.sent++;
    }
  }

  // A failure is not final: the queue keeps the alert and retries with a backoff, so the
  // row stays queued and carries the last reason rather than reading as lost.
  failed(entries, error) {
    for (const e of entries || []) {
      if (!e || typeof e !== 'object') continue;
      e.error = error || 'unknown error';
      this.counts.failed++;
    }
  }

  // Dropped means the queue never drained and the alert aged out - the one case where
  // something really did not reach the group.
  dropped(entries) {
    for (const e of entries || []) {
      if (!e || typeof e !== 'object') continue;
      if (e.status === 'queued') this.counts.queued--;
      e.status = 'dropped';
      this.counts.dropped++;
    }
  }

  list(limit = 100) { return this.entries.slice(0, limit); }

  stats() {
    return {
      ...this.counts,
      held: this.entries.filter((e) => e.status === 'queued').length,
      kept: this.entries.length,
      limit: this.limit,
    };
  }
}
