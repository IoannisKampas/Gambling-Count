// Records every incoming game-socket message to a JSON-lines file, each line tagged
// with its tableId. Opt-in: pass a directory (or set RECORD_DIR). One file per day.
//
// A line is: {"t": <epoch ms>, "tableId": "...", "kind": "card", "message": { ... }}

import fs from 'node:fs';
import path from 'node:path';

export function attachRecorder(feed, dir) {
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  let day = '';
  let stream = null;

  const roll = () => {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      if (stream) stream.end();
      stream = fs.createWriteStream(path.join(dir, 'messages-' + d + '.jsonl'), { flags: 'a' });
    }
    return stream;
  };

  let count = 0;
  feed.on('message', ({ tableId, kind, message }) => {
    roll().write(JSON.stringify({ t: Date.now(), tableId, kind, message }) + '\n');
    count++;
  });

  return { dir, get count() { return count; } };
}
