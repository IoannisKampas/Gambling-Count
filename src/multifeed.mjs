// Aggregates one BlackjackFeed per operator session.
//
// Pragmatic caps concurrent game sockets at MAX_CONCURRENT per *account*
// (FINDINGS.md §6). Extra sessions of the same account do not raise it - only a
// genuinely different account does. So the only honest way to watch more tables is
// to hold an authorized login on more than one operator that carries Pragmatic
// (Stoiximá, Winmasters, Betsson, …) and run each one's own capped feed alongside
// the others. Capacity is therefore MAX_CONCURRENT x (number of live sessions).
//
// Each child feed is entirely independent: its own JSESSIONID, its own socket set,
// its own 6-table ceiling. This class only routes tables to a feed and merges the
// snapshots back into one list, tagging every row with the operator carrying it.
//
// Read-only throughout: it inherits BlackjackFeed's behaviour and never bets.

import { EventEmitter } from 'node:events';
import { BlackjackFeed, MAX_CONCURRENT } from './feed.mjs';

export { MAX_CONCURRENT };

export class MultiFeed extends EventEmitter {
  constructor({ names = new Map() } = {}) {
    super();
    this.names = names;          // shared id -> display name, mutated in place
    this.feeds = new Map();      // operator -> BlackjackFeed
    this.owner = new Map();      // tableId -> operator currently carrying it
  }

  // Re-emit a child feed's events upward, tagged with the operator they came from.
  #wire(operator, feed) {
    feed.on('update', (id) => this.emit('update', id));
    feed.on('message', (m) => this.emit('message', m));
    feed.on('shoe', (m) => this.emit('shoe', { ...m, operator }));
    feed.on('log', (e) => this.emit('log', { ...e, msg: '[' + operator + '] ' + e.msg }));
    // the server refreshes that operator's session, not everyone's
    feed.on('authfail', (id) => this.emit('authfail', { operator, id }));
  }

  // Create the operator's feed, or hand its existing feed a newer token.
  ensure(operator, jsessionid) {
    const existing = this.feeds.get(operator);
    if (existing) {
      existing.setSession(jsessionid);
      return existing;
    }
    const feed = new BlackjackFeed({ jsessionid, tables: [], names: this.names });
    this.#wire(operator, feed);
    this.feeds.set(operator, feed);
    return feed;
  }

  has(operator) { return this.feeds.has(operator); }
  operators() { return [...this.feeds.keys()]; }

  setSession(operator, jsessionid) {
    const feed = this.feeds.get(operator);
    if (feed) feed.setSession(jsessionid);
  }

  liveCount() {
    let n = 0;
    for (const f of this.feeds.values()) n += f.liveCount();
    return n;
  }

  // Total tables the current set of sessions may carry at once.
  capacity() { return this.feeds.size * MAX_CONCURRENT; }

  // Tables currently live on one operator's session.
  liveOn(operator) {
    const f = this.feeds.get(operator);
    return f ? f.liveCount() : 0;
  }

  // Free slots left on one operator's session (0 if it has no session at all).
  free(operator) {
    const f = this.feeds.get(operator);
    return f ? Math.max(0, MAX_CONCURRENT - f.liveCount()) : 0;
  }

  // Which operator carries this table right now, if any.
  which(id) { return this.owner.get(id) || null; }

  // Pick the emptiest session among those whose catalogue offers this table, so
  // pins spread across accounts instead of filling one and stalling.
  pick(candidates) {
    let best = null;
    let bestFree = 0;
    for (const op of candidates) {
      const f = this.free(op);
      if (f > bestFree) { bestFree = f; best = op; }
    }
    return best;
  }

  // Bring a table live on a specific operator's session. Returns the operator that
  // took it, or null if it could not be placed.
  addTable(operator, id) {
    if (this.owner.has(id)) return this.owner.get(id); // already live somewhere
    const feed = this.feeds.get(operator);
    if (!feed) return null;
    if (!feed.addTable(id)) return null;               // that session is full
    this.owner.set(id, operator);
    return operator;
  }

  removeTable(id) {
    const operator = this.owner.get(id);
    if (!operator) return null;
    const feed = this.feeds.get(operator);
    if (feed) feed.removeTable(id);
    this.owner.delete(id);
    return operator;
  }

  // Merged live rows, each tagged with the operator whose session carries it.
  snapshot() {
    const out = [];
    for (const [operator, feed] of this.feeds) {
      for (const row of feed.snapshot()) {
        row.operator = operator;
        out.push(row);
      }
    }
    return out;
  }

  // Unpin every table everywhere, keeping the sessions themselves alive.
  clear() {
    for (const id of [...this.owner.keys()]) this.removeTable(id);
  }

  // Drop every table on one operator (its session died and cannot be replaced).
  stopOperator(operator) {
    const feed = this.feeds.get(operator);
    if (!feed) return;
    feed.stop();
    this.feeds.delete(operator);
    for (const [id, op] of [...this.owner]) if (op === operator) this.owner.delete(id);
  }

  stop() {
    for (const f of this.feeds.values()) f.stop();
    this.feeds.clear();
    this.owner.clear();
  }
}
