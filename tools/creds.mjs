// Import data/credentials.json into the DPAPI-encrypted store, then delete the
// plaintext file.
//
//   npm run creds              import and remove the plaintext
//   npm run creds -- --keep    import but leave the file in place
//   npm run creds -- --list    show which operators have stored credentials
//   npm run creds -- --forget stoiximan
//
// Passwords are never printed, and never passed on a command line.

import { importFromFile, getCredentials, forgetCredentials, CRED_FILE } from '../src/credentials.mjs';
import * as operators from '../src/operators.mjs';

const args = process.argv.slice(2);

if (args.includes('--list')) {
  for (const op of Object.keys(operators.all())) {
    const c = await getCredentials(op);
    console.log('  ' + op.padEnd(12) + (c ? 'stored (' + c.username.replace(/(.{2}).*(@|$)/, '$1…$2') + ')' : '—'));
  }
  process.exit(0);
}

const forgetIdx = args.indexOf('--forget');
if (forgetIdx !== -1) {
  const op = args[forgetIdx + 1];
  if (!op) { console.error('usage: npm run creds -- --forget <operator>'); process.exit(1); }
  forgetCredentials(op);
  console.log('forgot credentials for ' + op);
  process.exit(0);
}

try {
  const r = await importFromFile({ keepFile: args.includes('--keep') });
  if (r.missing) {
    console.log('\nNo credentials file found. Create ' + CRED_FILE + ' containing:\n');
    console.log('  {\n    "stoiximan": { "username": "you@example.com", "password": "…" }\n  }\n');
    console.log('then run this again. It is imported into the encrypted store and the');
    console.log('plaintext file is deleted.\n');
    process.exit(1);
  }
  if (!r.imported.length) { console.error('nothing importable in ' + CRED_FILE); process.exit(1); }
  console.log('stored credentials for: ' + r.imported.join(', '));
  console.log(r.fileRemoved ? 'plaintext file deleted.' : 'plaintext file kept (--keep).');
} catch (e) {
  console.error('import failed: ' + e.message);
  process.exit(1);
}
