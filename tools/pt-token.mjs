// Print the newest Playtech session token recorded by tools/capture.mjs.
// The token is minted by the real game launch and lives ~5 minutes, so this is meant to
// be piped straight into a login attempt.
import fs from 'node:fs';

const files = fs.readdirSync('capture').filter((f) => /^session-.*\.jsonl$/.test(f)).sort();
if (!files.length) { console.error('no capture files'); process.exit(1); }
const latest = files[files.length - 1];

let bodyFile = null;
for (const line of fs.readFileSync('capture/' + latest, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.type === 'body' && /GetTemporaryAuthenticationToken/i.test(o.url || '')) bodyFile = o.file;
}
if (!bodyFile) { console.error('no GetTemporaryAuthenticationToken body in ' + latest); process.exit(1); }

const j = JSON.parse(fs.readFileSync('capture/bodies/' + bodyFile, 'utf8'));
const tok = j.sessionToken && j.sessionToken.sessionToken;
if (!tok) { console.error('body had no sessionToken: ' + JSON.stringify(j).slice(0, 200)); process.exit(1); }
if (process.argv.includes('--verbose')) {
  console.error('capture: ' + latest + '  expires ' + (j.sessionToken.expirationTime || {}).timestamp + '  user ' + j.username);
}
process.stdout.write(tok);
