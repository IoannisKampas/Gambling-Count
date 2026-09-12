// Mint a Pragmatic session and persist it to the DPAPI secret store.
// By default prints only a masked prefix (never the full token). Pass --reveal to
// print the full token to stdout for manual use in a dev tool.
import { SessionProvider } from '../src/session.mjs';

const reveal = process.argv.includes('--reveal');
const p = new SessionProvider({ logger: (m) => console.log('[session]', m) });
console.time('acquire');
try {
  const s = await p.refresh(); // mints and persists via the secret store
  console.timeEnd('acquire');
  if (reveal) {
    console.log('JSESSIONID =', s);
  } else {
    console.log('session minted and saved to the secret store (' + s.slice(0, 6) + '…). Pass --reveal to print it.');
  }
} catch (e) {
  console.timeEnd('acquire');
  console.error('FAILED:', e.message);
  process.exit(1);
}
process.exit(0);
