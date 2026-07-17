/**
 * RFC 9051 §6.4.5: fetching a body section with BODY[...] (no .PEEK) sets \Seen
 * as a side effect and reports the change; BODY.PEEK[...] does not. A client that
 * relies on the implicit mark-as-read (rather than an explicit STORE) depends on
 * this. The server parsed both forms identically, so a non-peek fetch never marked
 * the message read — this pins the distinction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function run(commands: string, done: string): Promise<{ acc: string; cat: MemoryCatalog }> {
  const cat = new MemoryCatalog();
  const inbox = cat.get('INBOX')!;
  inbox.append(Buffer.from('Subject: one\r\n\r\nbody one\r\n', 'latin1')); // uid 1
  inbox.append(Buffer.from('Subject: two\r\n\r\nbody two\r\n', 'latin1')); // uid 2
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('error', () => {});
  await new Promise<void>((r) => sock.once('connect', () => r()));
  sock.write(Buffer.from(commands, 'latin1'));
  for (let i = 0; i < 400 && !acc.includes(done); i++) await delay(5);
  sock.destroy();
  await server.close();
  return { acc, cat };
}

test('non-PEEK BODY[] sets \\Seen and reports it; BODY.PEEK[] does not', async () => {
  const { acc, cat } = await run(
    'a1 LOGIN u p\r\na2 SELECT INBOX\r\na3 UID FETCH 1 (BODY[])\r\na4 UID FETCH 2 (BODY.PEEK[])\r\na5 LOGOUT\r\n',
    'a5 OK',
  );
  const msgs = cat.get('INBOX')!.messages;
  assert.deepEqual([...msgs[0]!.flags], ['\\Seen'], 'a non-PEEK BODY[] fetch marks the message \\Seen');
  assert.deepEqual([...msgs[1]!.flags], [], 'a BODY.PEEK[] fetch leaves flags untouched');
  // The client is told about the flag the fetch triggered (an untagged FETCH FLAGS).
  assert.match(acc, /\* 1 FETCH \(FLAGS \(\\Seen\) UID 1\)/, 'the \\Seen change is reported back');
  assert.doesNotMatch(acc, /\* 2 FETCH \(FLAGS/, 'the PEEK fetch produces no flag update');
});

test('a non-PEEK fetch preserves existing flags when adding \\Seen', async () => {
  const cat = new MemoryCatalog();
  const inbox = cat.get('INBOX')!;
  inbox.append(Buffer.from('Subject: kept\r\n\r\nb\r\n', 'latin1'), ['\\Flagged']); // uid 1, already \Flagged
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('error', () => {});
  await new Promise<void>((r) => sock.once('connect', () => r()));
  sock.write(Buffer.from('a1 LOGIN u p\r\na2 SELECT INBOX\r\na3 UID FETCH 1 (BODY[TEXT])\r\na4 LOGOUT\r\n', 'latin1'));
  for (let i = 0; i < 400 && !acc.includes('a4 OK'); i++) await delay(5);
  sock.destroy();
  await server.close();
  const flags = new Set(cat.get('INBOX')!.messages[0]!.flags);
  assert.ok(flags.has('\\Flagged') && flags.has('\\Seen'), 'the pre-existing \\Flagged survives, \\Seen is added');
  assert.match(acc, /FLAGS \(\\Flagged \\Seen\)/, 'the reported flag set includes both, not just \\Seen');
});
