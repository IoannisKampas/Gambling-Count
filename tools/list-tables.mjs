// Fetch the live table catalogue from the Pragmatic Play lobby API and print it.
//   GET https://games.pragmaticplaylive.net/api/lobby/tables?JSESSIONID=…
// Refreshes data/lobby-tables.json as a side effect.
//
// Usage: node tools/list-tables.mjs [--game blackjack] [--open] [--json]

import fs from 'node:fs';
import { SessionProvider } from '../src/session.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const val = (n) => {
  const i = args.indexOf('--' + n);
  return i === -1 ? null : args[i + 1];
};

const jsession = val('session') || process.env.JSESSIONID || (await new SessionProvider().refresh());

const url = 'https://games.pragmaticplaylive.net/api/lobby/tables?JSESSIONID=' + encodeURIComponent(jsession);
const res = await fetch(url, {
  headers: {
    Origin: 'https://client.pragmaticplaylive.net',
    Referer: 'https://client.pragmaticplaylive.net/',
  },
});
if (!res.ok) {
  console.error('lobby API returned HTTP ' + res.status);
  process.exit(1);
}
const data = await res.json();
fs.writeFileSync('data/lobby-tables.json', JSON.stringify(data, null, 1));

let tables = data.tables || [];
const gameFilter = val('game');
if (gameFilter) tables = tables.filter((t) => t.game === gameFilter);
if (flag('open')) tables = tables.filter((t) => t.open);

if (flag('json')) {
  console.log(JSON.stringify(tables, null, 1));
  process.exit(0);
}

const byGame = new Map();
for (const t of tables) {
  if (!byGame.has(t.game)) byGame.set(t.game, []);
  byGame.get(t.game).push(t);
}

const name = (t) => (t.title && t.title.key) || t.id;
const limits = (t) => (t.limits ? t.limits.min + '-' + t.limits.max : '');

console.log('\ncasino ' + data.casinoId + '   user ' + data.userId);
console.log(tables.length + ' tables   (' + tables.filter((t) => t.open).length + ' open)\n');

for (const [game, list] of [...byGame.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log('== ' + game.toUpperCase() + '  (' + list.length + ') ' + '='.repeat(Math.max(0, 46 - game.length)));
  for (const t of list.sort((a, b) => name(a).localeCompare(name(b), undefined, { numeric: true }))) {
    console.log(
      '  ' + (t.open ? ' ' : 'x') + ' ' +
      t.id.padEnd(18) +
      name(t).padEnd(24) +
      String(t.gameLoaderKey || '').padEnd(20) +
      limits(t).padEnd(13) +
      (t.dealer && t.dealer.name ? t.dealer.name : ''),
    );
  }
  console.log('');
}
console.log('x = closed   columns: id, name, variant, limits, dealer');
