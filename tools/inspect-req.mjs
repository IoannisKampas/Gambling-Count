// Print the captured request/response for URLs matching a substring.
// Usage: node tools/inspect-req.mjs <substring>
import fs from 'node:fs';

const needle = process.argv[2];
const files = fs.readdirSync('capture').filter((f) => f.endsWith('.jsonl')).sort();
const rows = fs.readFileSync('capture/' + files[0], 'utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

for (const r of rows) {
  if (!r.url || !r.url.includes(needle)) continue;
  if (r.type === 'req') {
    console.log('--- REQUEST', r.method, r.url);
    console.log(JSON.stringify(r.headers, null, 1));
  }
  if (r.type === 'res') {
    console.log('--- RESPONSE', r.status, r.mime, r.url.slice(0, 120));
  }
}
