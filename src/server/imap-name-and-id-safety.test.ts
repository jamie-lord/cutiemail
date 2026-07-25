/**
 * Two ways a mailbox NAME or ID could reach further than it should.
 *
 * 1. Mailbox ids were `MAX(id) + 1`, which recycles the id of the most recently created mailbox
 *    the moment it is deleted. A second session with that mailbox still selected holds a handle
 *    bound to the number, not the name — so its next FETCH/STORE/EXPUNGE silently operated on
 *    whichever mailbox inherited the id, reading one folder's mail and then destroying it. No
 *    attacker is needed: deleting a folder while another device has it open is an everyday
 *    action, and a fresh account's first custom folder sits at exactly the recycled position.
 *
 * 2. `SPECIAL_USE` was a plain object indexed by a client-chosen mailbox name, so
 *    `CREATE constructor` resolved through Object.prototype.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a deleted mailbox never hands its internal id to the next CREATE', () => {
  const cat = SqliteCatalog.open(new DatabaseSync(':memory:'));
  const work = cat.create('Work')!;
  work.append(Buffer.from('Subject: PRIVATE\r\n\r\nvery private\r\n', 'latin1'), [], Date.now());
  // A second session's handle, bound at SELECT time and still held.
  const stale = cat.get('Work')!;
  assert.equal(stale.index().length, 1);

  assert.equal(cat.delete('Work'), true);
  const secrets = cat.create('Secrets')!;
  secrets.append(Buffer.from('Subject: OTHER\r\n\r\nsomeone else\r\n', 'latin1'), [], Date.now());

  // Before the fix, `stale` and `secrets` shared an id: the stale handle listed, and could
  // expunge, the NEW mailbox's message.
  assert.equal(secrets.index().length, 1, 'the new mailbox has its own message');
  assert.equal(stale.index().length, 0, 'the stale handle must NOT see it');

  // And the destructive path: an EXPUNGE through the stale handle must not empty the new mailbox.
  for (const m of stale.index()) stale.storeFlags(m.uid, 'replace', ['\\Deleted']);
  stale.expungeDeleted();
  assert.equal(secrets.index().length, 1, 'the new mailbox still holds its message');
});

test('the id high-water mark survives reopening the database', () => {
  const db = new DatabaseSync(':memory:');
  const cat = SqliteCatalog.open(db);
  cat.create('Work');
  assert.equal(cat.delete('Work'), true);
  // Reopening must not reset the mark to MAX(id) and start recycling again.
  const reopened = SqliteCatalog.open(db);
  const a = reopened.create('A')!;
  const b = reopened.create('B')!;
  a.append(Buffer.from('Subject: a\r\n\r\na\r\n', 'latin1'), [], Date.now());
  assert.equal(b.index().length, 0, 'two mailboxes created after a delete must not share storage');
});

test('a mailbox named after an Object.prototype key gets no special-use attribute', async () => {
  const server = await ImapServer.start(new MemoryCatalog(), { authenticate: (u, p) => u === 'alice' && p === 'pw' });
  const sock = net.connect(server.port, '127.0.0.1');
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('error', () => {});
  const run = async (w: string, re: RegExp): Promise<string> => {
    const from = acc.length;
    sock.write(Buffer.from(w, 'latin1'));
    for (let i = 0; i < 400; i++) {
      if (re.test(acc.slice(from))) return acc.slice(from);
      await delay(5);
    }
    throw new Error(`timed out waiting for ${re}: ${acc.slice(from)}`);
  };

  try {
    await run('', /^\* OK/m);
    await run('a1 LOGIN alice pw\r\n', /^a1 OK/m);
    await run('a2 CREATE constructor\r\n', /^a2 OK/m);
    await run('a3 CREATE __proto__\r\n', /^a3 OK/m);

    const list = await run('a4 LIST "" *\r\n', /^a4 OK/m);
    assert.ok(!/native code/.test(list), 'no prototype value may be interpolated into LIST attributes');
    assert.match(list, /\(\\HasNoChildren\) "\/" constructor/, 'it lists with ordinary attributes');

    // The (SPECIAL-USE) filter means "has a special-use attribute" — a poisoned name must not
    // satisfy it, whatever else the filter returns.
    const special = await run('a5 LIST (SPECIAL-USE) "" *\r\n', /^a5 OK/m);
    assert.ok(!/ constructor\r?$/m.test(special), 'a prototype-named mailbox must not pass the SPECIAL-USE filter');
    assert.ok(!/ __proto__\r?$/m.test(special), 'nor must __proto__');
  } finally {
    sock.destroy();
    await server.close();
  }
});
