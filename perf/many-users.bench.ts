/**
 * Many-users footprint — the idle cost of serving M accounts.
 *
 * MailStores (src/store/mail-stores.ts) opens one store per login on first use and
 * caches it FOREVER — there is no eviction. Each cached store holds an open SQLite
 * handle (its own page cache + WAL state) and a notifier. This measures the resident
 * memory of holding M open user databases, to answer "how many users fit on the box?".
 *
 *   node --expose-gc perf/many-users.bench.ts [users] [msgsPerUser]
 */

import type { DatabaseSync } from 'node:sqlite';
import { openMailDb } from '../src/store/open-mail-db.ts';
import { SqliteCatalog } from '../src/store/sqlite-mailbox.ts';
import { scratchDir, makeMessage, rssMB, pad } from './lib.ts';

const users = parseInt(process.argv[2] ?? '2000', 10);
const msgsPerUser = parseInt(process.argv[3] ?? '20', 10);

const dir = scratchDir('many-users');
const rss0 = rssMB();
const open: DatabaseSync[] = [];
const checkpoints = [1, Math.floor(users / 4), Math.floor(users / 2), users];
const marks: Array<[number, number]> = [];

for (let u = 0; u < users; u++) {
  const db = openMailDb(`${dir.path}/mail-user${u}.db`);
  const cat = SqliteCatalog.open(db);
  const inbox = cat.get('INBOX')!;
  for (let i = 0; i < msgsPerUser; i++) inbox.append(makeMessage(i, 4096), []);
  open.push(db); // held open, exactly as MailStores would keep it cached
  if (checkpoints.includes(u + 1)) marks.push([u + 1, rssMB() - rss0]);
}

console.log(`\nMany-users footprint — ${msgsPerUser} msgs/user, all DBs held open (no eviction)\n`);
console.log([pad('users', 8), pad('RSS Δ MB', 10), pad('KB/user', 10)].join(' '));
console.log('-'.repeat(30));
for (const [n, mb] of marks) {
  console.log([pad(n, 8), pad(mb.toFixed(1), 10), pad(((mb * 1024) / n).toFixed(1), 10)].join(' '));
}
const last = marks[marks.length - 1]!;
console.log(
  `\n${last[0]} concurrently-open user DBs cost ~${last[1].toFixed(0)} MB RSS (${((last[1] * 1024) / last[0]).toFixed(0)} KB/user).` +
    `\nMailStores never evicts, so this floor only grows with the number of DISTINCT users seen since boot.\n`,
);

for (const db of open) db.close();
dir.cleanup();
