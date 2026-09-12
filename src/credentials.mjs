// Operator credentials. Two ways in, and the plain one is fine on a host you own.
//
//   1. data/credentials.json — left in place. Read directly, and it WINS over the
//      encrypted store, so editing the file is all it takes to change a password.
//      Git-ignored; keep it chmod 600 and owned by the service user.
//   2. The encrypted store (src/secret-store.mjs) — `npm run creds` imports the file
//      and then shreds it. Worth it on a shared or laptop machine; unnecessary on a
//      single-tenant VPS.
//
// Nothing here is ever logged or echoed, and the password is never passed on a command
// line (it would show up in the process list) - it goes to the browser through CDP.
//
// File format (data/credentials.json):
//   { "stoiximan": { "username": "you@example.com", "password": "…" } }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveSecret, loadSecret, deleteSecret } from './secret-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CRED_FILE = path.join(ROOT, 'data/credentials.json');

const nameFor = (op) => 'cred-' + op;

// Pull one operator's entry out of the plaintext file, or null if it is absent,
// unreadable, or has no entry for this operator.
function fromFile(op) {
  if (!fs.existsSync(CRED_FILE)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    const v = j && j[op];
    if (!v || !v.username || !v.password) return null;
    return { username: String(v.username), password: String(v.password) };
  } catch { return null; }
}

export async function getCredentials(op) {
  // The file first: if it is sitting there, it is what the operator of this box last
  // edited, and a stale entry in the encrypted store silently overriding it is the
  // kind of thing that costs an hour.
  const plain = fromFile(op);
  if (plain) return plain;

  const raw = await loadSecret(nameFor(op));
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j && j.username && j.password ? j : null;
  } catch { return null; }
}

export async function setCredentials(op, username, password) {
  if (!op || !username || !password) throw new Error('operator, username and password are required');
  await saveSecret(nameFor(op), JSON.stringify({ username, password }));
}

export function forgetCredentials(op) { deleteSecret(nameFor(op)); }

// Import data/credentials.json into the encrypted store, then remove the plaintext.
// Returns the list of operators imported.
export async function importFromFile({ keepFile = false } = {}) {
  if (!fs.existsSync(CRED_FILE)) return { imported: [], missing: true };
  let j;
  try { j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); }
  catch (e) { throw new Error('credentials.json is not valid JSON: ' + e.message); }

  const imported = [];
  for (const [op, v] of Object.entries(j)) {
    if (!v || !v.username || !v.password) continue;
    await setCredentials(op, String(v.username), String(v.password));
    imported.push(op);
  }
  if (!keepFile && imported.length) {
    // overwrite before unlinking so the plaintext does not linger in free space
    try {
      const size = fs.statSync(CRED_FILE).size;
      fs.writeFileSync(CRED_FILE, '0'.repeat(Math.max(size, 1)));
    } catch {}
    try { fs.rmSync(CRED_FILE, { force: true }); } catch {}
  }
  return { imported, missing: false, fileRemoved: !keepFile && imported.length > 0 };
}
