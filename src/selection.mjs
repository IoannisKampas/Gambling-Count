// Which reading, on which table, may raise a push notification.
//
// This has to live on the server, not in the browser. The table picks on /settings are
// localStorage - per browser, invisible to this process - and the process is what sends
// the pushes. A selection kept there would mean alerts that depend on which laptop last
// loaded a page, and none at all while no page is open.
//
// The shape is table -> readings, because "Andreas Deluxe on this one wheel only" is a
// normal thing to want: that reading fires orders of magnitude more often than the run
// readings, so arming it everywhere drowns them. A table may instead be armed for ALL
// readings, which is stored as '*' rather than a frozen list - otherwise adding a reading
// later would silently leave existing tables un-armed for it.
//
// Stored as JSON next to the other per-host state, written atomically, loaded at startup.
// Unknown table ids are kept rather than pruned: a table missing from today's catalogue
// (closed, or a lobby that has not refreshed yet) should not lose its place.

import fs from 'node:fs';
import path from 'node:path';

const ALL = '*';

export class AlertSelection {
  constructor({ file, log = console } = {}) {
    this.file = file;
    this.log = log;
    this.byTable = new Map();     // tableId -> '*' | Set<readingId>
    this.#load();
  }

  get size() { return this.byTable.size; }

  // every table with anything armed
  list() { return [...this.byTable.keys()]; }

  // may this reading on this table push?
  has(tableId, readingId) {
    const v = this.byTable.get(tableId);
    if (!v) return false;
    if (v === ALL) return true;
    return readingId ? v.has(readingId) : v.size > 0;
  }

  // '*' | string[] | null, for the API and the page
  readingsFor(tableId) {
    const v = this.byTable.get(tableId);
    if (!v) return null;
    return v === ALL ? ALL : [...v];
  }

  // { tableId: '*' | string[] }
  map() {
    const out = {};
    for (const [id, v] of this.byTable) out[id] = v === ALL ? ALL : [...v];
    return out;
  }

  // how many (table, reading) pairs are armed, counting '*' as `readingCount`
  pairs(readingCount) {
    let n = 0;
    for (const v of this.byTable.values()) n += v === ALL ? readingCount : v.size;
    return n;
  }

  // Arm or disarm a whole table, for every reading.
  toggleTable(id, on) {
    if (!id) return this.map();
    const want = on === undefined ? !this.byTable.has(id) : !!on;
    if (want) this.byTable.set(id, ALL); else this.byTable.delete(id);
    this.#save();
    return this.map();
  }

  // Arm or disarm one reading on one table. Turning a reading off on an all-armed table
  // expands '*' to the explicit rest, which is what the click means.
  toggleReading(id, readingId, on, allReadings = []) {
    if (!id || !readingId) return this.map();
    const current = this.byTable.get(id);
    const want = on === undefined ? !this.has(id, readingId) : !!on;

    let set;
    if (current === ALL) set = new Set(allReadings);
    else if (current) set = new Set(current);
    else set = new Set();

    if (want) set.add(readingId); else set.delete(readingId);

    if (!set.size) this.byTable.delete(id);
    else if (allReadings.length && set.size === allReadings.length) this.byTable.set(id, ALL);
    else this.byTable.set(id, set);

    this.#save();
    return this.map();
  }

  // Replace the whole selection. Accepts ['id', …] (all readings) or
  // { id: '*' | ['reading', …] }.
  set(value) {
    this.byTable = new Map();
    if (Array.isArray(value)) {
      for (const id of value) if (typeof id === 'string' && id) this.byTable.set(id, ALL);
    } else if (value && typeof value === 'object') {
      for (const [id, v] of Object.entries(value)) {
        if (!id) continue;
        if (v === ALL || v === true) this.byTable.set(id, ALL);
        else if (Array.isArray(v)) {
          const set = new Set(v.filter((x) => typeof x === 'string' && x));
          if (set.size) this.byTable.set(id, set);
        }
      }
    }
    this.#save();
    return this.map();
  }

  clear() { this.byTable = new Map(); this.#save(); return {}; }

  #load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // the first version of this file stored a plain array of table ids; those tables
      // were armed for everything, so they load as '*'
      this.set(Array.isArray(raw) ? raw : raw.tables || {});
    } catch (e) {
      // a corrupt file must not stop the server: an empty selection is safe (it only
      // means no pushes until something is armed again), and it says so.
      this.log.warn('alert selection unreadable, starting empty: ' + e.message);
    }
  }

  #save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ tables: this.map() }, null, 1));
      fs.renameSync(tmp, this.file);   // atomic, so a crash mid-write cannot truncate it
    } catch (e) {
      this.log.warn('could not save the alert selection: ' + e.message);
    }
  }
}
