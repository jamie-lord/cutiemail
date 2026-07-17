/**
 * IMAP mailbox management: DELETE and RENAME (RFC 9051 §6.3.4, §6.3.5).
 *
 * We advertise IMAP4rev2 and support CREATE, so a client can make folders; it must
 * also be able to remove and rename them. Pins: a plain mailbox renames and deletes,
 * INBOX cannot be deleted, a missing/taken name is rejected, and renaming INBOX moves
 * its messages into the target while INBOX itself stays (emptied).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ImapServer } from './imap-server.ts';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function client(port: number): { sock: net.Socket; run: (tag: string, cmd: string) => Promise<string> } {
  const sock = net.connect(port, '127.0.0.1');
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('error', () => {});
  const run = async (tag: string, cmd: string): Promise<string> => {
    const from = acc.length;
    sock.write(Buffer.from(`${tag} ${cmd}\r\n`, 'latin1'));
    for (let i = 0; i < 400; i++) {
      if (new RegExp(`^${tag} (OK|NO|BAD)`, 'm').test(acc.slice(from))) return acc.slice(from);
      await delay(5);
    }
    throw new Error(`timed out on ${tag}: ${acc.slice(from)}`);
  };
  return { sock, run };
}

test('DELETE and RENAME manage mailboxes; INBOX is protected', async () => {
  const cat = SqliteCatalog.open(new DatabaseSync(':memory:'));
  cat.create('Work')!.append(Buffer.from('Subject: w\r\n\r\nbody\r\n', 'latin1'));
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const c = client(server.port);
  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a1', 'LOGIN u p');

    assert.match(await c.run('a2', 'RENAME Work Projects'), /^a2 OK/m, 'a plain mailbox is renamed');
    assert.ok(cat.get('Projects') !== undefined && cat.get('Work') === undefined, 'the rename took effect in the store');
    assert.match(await c.run('a3', 'RENAME Projects INBOX'), /^a3 NO/m, 'renaming onto an existing name is refused');

    assert.match(await c.run('a4', 'DELETE Projects'), /^a4 OK/m, 'a mailbox is deleted');
    assert.equal(cat.get('Projects'), undefined, 'it is gone from the store');
    assert.match(await c.run('a5', 'DELETE Projects'), /^a5 NO/m, 'deleting an absent mailbox is refused');
    assert.match(await c.run('a6', 'DELETE INBOX'), /^a6 NO/m, 'INBOX cannot be deleted');
    assert.ok(cat.get('INBOX') !== undefined, 'INBOX still exists after the refused delete');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('RENAME INBOX moves its messages to the target and leaves INBOX empty', async () => {
  const cat = SqliteCatalog.open(new DatabaseSync(':memory:'));
  cat.get('INBOX')!.append(Buffer.from('Subject: keep me\r\n\r\nbody\r\n', 'latin1'));
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const c = client(server.port);
  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a1', 'LOGIN u p');
    assert.match(await c.run('a2', 'RENAME INBOX "2026 Archive"'), /^a2 OK/m, 'INBOX rename succeeds');
    assert.equal(cat.get('INBOX')!.messages.length, 0, 'INBOX is emptied');
    assert.ok(cat.get('INBOX') !== undefined, 'but INBOX still exists (never deleted)');
    const archived = cat.get('2026 Archive');
    assert.ok(archived !== undefined && archived.messages.length === 1, 'the message moved into the target');
    assert.match(archived!.messages[0]!.raw.toString('latin1'), /keep me/, 'the moved message is intact');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('EXAMINE opens read-only: [READ-ONLY], no \\Seen on fetch, STORE/EXPUNGE refused', async () => {
  const cat = SqliteCatalog.open(new DatabaseSync(':memory:'));
  cat.get('INBOX')!.append(Buffer.from('Subject: t\r\n\r\nbody\r\n', 'latin1'));
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const c = client(server.port);
  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a1', 'LOGIN u p');
    assert.match(await c.run('a2', 'EXAMINE INBOX'), /^a2 OK \[READ-ONLY\]/m, 'EXAMINE reports READ-ONLY');
    // A non-PEEK body fetch must not set \Seen on a read-only mailbox.
    await c.run('a3', 'FETCH 1 BODY[]');
    assert.deepEqual([...cat.get('INBOX')!.messages[0]!.flags], [], 'no \\Seen side-effect under EXAMINE');
    assert.match(await c.run('a4', 'STORE 1 +FLAGS (\\Flagged)'), /^a4 NO/m, 'STORE is refused read-only');
    assert.match(await c.run('a5', 'EXPUNGE'), /^a5 NO/m, 'EXPUNGE is refused read-only');
    // SELECT of the same mailbox is read-write again.
    assert.match(await c.run('a6', 'SELECT INBOX'), /^a6 OK \[READ-WRITE\]/m, 'SELECT is read-write');
    assert.match(await c.run('a7', 'STORE 1 +FLAGS (\\Flagged)'), /^a7 OK/m, 'STORE works after SELECT');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('ENABLE, CHECK and UNSELECT are supported (RFC 9051 §6.3.1/§6.4.1/§6.4.2)', async () => {
  const cat = SqliteCatalog.open(new DatabaseSync(':memory:'));
  cat.get('INBOX')!.append(Buffer.from('Subject: t\r\n\r\nb\r\n', 'latin1'));
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const c = client(server.port);
  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a1', 'LOGIN u p');
    const en = await c.run('a2', 'ENABLE IMAP4rev2');
    assert.match(en, /\* ENABLED IMAP4rev2/, 'ENABLE echoes the enabled capability');
    await c.run('a3', 'SELECT INBOX');
    assert.match(await c.run('a4', 'CHECK'), /^a4 OK/m, 'CHECK is a no-op OK when selected');
    // UNSELECT deselects WITHOUT expunging — a following CHECK has no mailbox.
    assert.match(await c.run('a5', 'UNSELECT'), /^a5 OK/m, 'UNSELECT completes');
    assert.match(await c.run('a6', 'CHECK'), /^a6 BAD/m, 'the mailbox was deselected by UNSELECT');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});
