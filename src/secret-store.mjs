// Secure secret storage, with a backend per platform.
//
// Windows: DPAPI (the same per-user encryption the Credential Manager uses). Secrets
// are encrypted with the current user's account key, so the ciphertext is useless to
// any other user or machine. Plaintext goes to PowerShell over stdin, not argv, so it
// never appears in the process list.
//
// Linux/macOS: AES-256-GCM under a key file that only the service user can read. There
// is no OS-bound equivalent of DPAPI available without pulling in a desktop keyring
// (libsecret needs a running session bus, which a headless VPS does not have), so the
// guarantee is weaker and honest about it: the ciphertext is safe at rest and in a
// backup, but anyone who can read the key file as that user can read the secrets. Keep
// the store on the service user's own home, and do not run the app as root.
//
// Supply PLFA_SECRET_KEY (base64, 32 bytes) to keep the key out of the filesystem
// entirely — e.g. from a systemd LoadCredential — and no key file is written.
//
// Used to persist session tokens and operator credentials between runs. It never logs
// a secret, and the store lives outside the repo.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';

const DIR = WIN
  ? path.join(
      process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'),
      'plfa-secrets',
    )
  : path.join(
      process.env.XDG_DATA_HOME || path.join(os.homedir() || '.', '.local', 'share'),
      'plfa-secrets',
    );

const KEY_FILE = path.join(DIR, 'master.key');

function ensureDir() {
  // 0700 so the store is not world-readable; a no-op on Windows, where the ACL
  // inherited from LOCALAPPDATA already restricts it to this user.
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (!WIN) restrict(DIR, 0o700);
}

// The `mode` option on writeFileSync/mkdirSync is masked by umask, and is ignored
// outright when the path already exists - so set the bits explicitly rather than
// assuming a file written last week under a looser umask is still private.
function restrict(file, mode) {
  if (WIN) return;
  try { fs.chmodSync(file, mode); } catch {}
}

function fileFor(name) {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error('bad secret name');
  return path.join(DIR, name + '.dat');
}

// ------------------------------------------------------------------ windows ----

function ps(script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

const dpapi = {
  // read plaintext from stdin, DPAPI-encrypt (CurrentUser scope), emit ciphertext
  encrypt: (value) => ps(
    '$p=[Console]::In.ReadToEnd();' +
      '$s=ConvertTo-SecureString -String $p -AsPlainText -Force;' +
      'ConvertFrom-SecureString -SecureString $s',
    value,
  ),
  decrypt: (cipher) => ps(
    '$c=[Console]::In.ReadToEnd().Trim();' +
      '$s=ConvertTo-SecureString -String $c;' +
      '$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);' +
      'try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)}' +
      'finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}',
    cipher,
  ),
};

// -------------------------------------------------------------------- posix ----

// The AES key: from the environment if supplied, else a key file created on first use.
// `create` is false on the read path so a missing key reads as "no secret" rather than
// silently minting a new key that cannot decrypt anything already stored.
function masterKey({ create }) {
  const env = process.env.PLFA_SECRET_KEY;
  if (env) {
    const k = Buffer.from(env.trim(), 'base64');
    if (k.length !== 32) throw new Error('PLFA_SECRET_KEY must be 32 bytes, base64-encoded');
    return k;
  }
  if (fs.existsSync(KEY_FILE)) {
    const k = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    if (k.length === 32) return k;
    throw new Error('master.key is corrupt — delete it and re-enter your credentials');
  }
  if (!create) return null;
  ensureDir();
  const k = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, k.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  restrict(KEY_FILE, 0o600);
  return k;
}

// v1:<base64 iv|tag|ciphertext>
const aes = {
  encrypt(value) {
    const key = masterKey({ create: true });
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  },
  decrypt(cipher) {
    const key = masterKey({ create: false });
    if (!key) return null;
    if (!cipher.startsWith('v1:')) throw new Error('unknown secret format');
    const buf = Buffer.from(cipher.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  },
};

// --------------------------------------------------------------------- api ----

// Encrypt `value` and write the ciphertext. Returns nothing; logs nothing.
export async function saveSecret(name, value) {
  ensureDir();
  const enc = WIN ? await dpapi.encrypt(value) : aes.encrypt(value);
  fs.writeFileSync(fileFor(name), enc, { encoding: 'utf8', mode: 0o600 });
  restrict(fileFor(name), 0o600);
}

// Load and decrypt a secret. Returns null if absent or undecryptable (e.g. copied from
// another user/machine, or restored without its key). Never logs the value.
export async function loadSecret(name) {
  const file = fileFor(name);
  if (!fs.existsSync(file)) return null;
  try {
    const cipher = fs.readFileSync(file, 'utf8').trim();
    if (!cipher) return null;
    const out = WIN ? await dpapi.decrypt(cipher) : aes.decrypt(cipher);
    return out || null;
  } catch {
    return null; // corrupt, or not decryptable by this user
  }
}

export function deleteSecret(name) {
  try { fs.rmSync(fileFor(name), { force: true }); } catch {}
}

// Where the store lives, for diagnostics that need to tell the user what to back up.
export const STORE_DIR = DIR;
