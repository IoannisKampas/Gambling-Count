// Which roulette tables may raise a push notification.
//
// This has to live on the server, not in the browser. The table picks on /settings are
// localStorage - per browser, invisible to this process - and the process is what sends
// the pushes. A selection kept there would mean alerts that depend on which laptop last
// loaded a page, and none at all while no page is open.
//
// So: a small JSON file next to the other per-host state, written atomically, loaded at
// startup. Unknown ids are kept rather than pruned - a table missing from today's
// catalogue (closed, or a lobby that has not refreshed yet) should not silently lose its
// place in the selection.

import fs from 'node:fs';
import path from 'node:path';

export class AlertSelection {
  constructor({ file, log = console } = {}) {
    this.file = file;
    this.log = log;
    this.ids = new Set();
    this.#load();
  }

  get size() { return this.ids.size; }
  has(id) { return this.ids.has(id); }
  list() { return [...this.ids]; }

  set(ids) {
    this.ids = new Set((ids || []).filter((x) => typeof x === 'string' && x));
    this.#save();
    return this.list();
  }

  toggle(id, on) {
    if (!id) return this.list();
    const want = on === undefined ? !this.ids.has(id) : !!on;
    if (want) this.ids.add(id); else this.ids.delete(id);
    this.#save();
    return this.list();
  }

  clear() { this.ids = new Set(); this.#save(); return []; }

  #load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.tables;
      this.ids = new Set((list || []).filter((x) => typeof x === 'string' && x));
    } catch (e) {
      // a corrupt file must not stop the server: an empty selection is safe (it only
      // means no pushes until something is selected again), and it says so.
      this.log.warn('alert selection unreadable, starting empty: ' + e.message);
    }
  }

  #save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ tables: this.list() }, null, 1));
      fs.renameSync(tmp, this.file);   // atomic, so a crash mid-write cannot truncate it
    } catch (e) {
      this.log.warn('could not save the alert selection: ' + e.message);
    }
  }
}
