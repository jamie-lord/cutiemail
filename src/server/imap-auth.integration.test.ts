/**
 * IMAP authentication enforcement (RFC 9051 §3, §6.2).
 *
 * The load-bearing security property: a client in the Not Authenticated state cannot
 * touch a mailbox. Before this was enforced, a bare "SELECT INBOX / FETCH 1 BODY[]"
 * with no LOGIN returned the message — anyone reaching the IMAPS port could read all
 * mail. This pins that unauthenticated commands are refused, and that both LOGIN and
 * AUTHENTICATE PLAIN (initial-response and continuation forms) grant access.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function connect(port: number): { sock: net.Socket; run: (cmds: string, doneTag: string) => Promise<string> } {
  const sock = net.connect(port, '127.0.0.1');
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('error', () => {});
  const run = async (cmds: string, doneTag: string): Promise<string> => {
    const from = acc.length;
    sock.write(Buffer.from(cmds, 'latin1'));
    for (let i = 0; i < 400; i++) {
      if (new RegExp(`^${doneTag} (OK|NO|BAD)`, 'm').test(acc.slice(from))) return acc.slice(from);
      await delay(5);
    }
    throw new Error(`timed out on ${doneTag}: ${acc.slice(from)}`);
  };
  return { sock, run };
}

const plainToken = (user: string, pass: string): string => Buffer.from(`\0${user}\0${pass}`, 'latin1').toString('base64');

test('an unauthenticated client cannot SELECT or FETCH (no mailbox access before login)', async () => {
  const cat = new MemoryCatalog();
  cat.get('INBOX')!.append(Buffer.from('Subject: secret\r\n\r\nconfidential contents\r\n', 'latin1'));
  const server = await ImapServer.start(cat, { authenticate: (u, p) => u === 'alice' && p === 'right' });
  const c = connect(server.port);
  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    const sel = await c.run('a1 SELECT INBOX\r\n', 'a1');
    assert.match(sel, /^a1 NO/m, 'SELECT before authentication is refused');
    const fetch = await c.run('a2 FETCH 1 BODY[]\r\n', 'a2');
    assert.match(fetch, /^a2 NO/m, 'FETCH before authentication is refused');
    assert.doesNotMatch(fetch, /confidential contents/, 'no message content leaks to an unauthenticated client');
    // Pre-auth commands are still allowed.
    assert.match(await c.run('a3 CAPABILITY\r\n', 'a3'), /^a3 OK/m, 'CAPABILITY is allowed pre-auth');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('AUTHENTICATE PLAIN grants access — initial-response and continuation forms', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: (u, p) => u === 'alice' && p === 'right' });
  // Initial-response form: AUTHENTICATE PLAIN <base64>.
  {
    const c = connect(server.port);
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    assert.match(await c.run(`b1 AUTHENTICATE PLAIN ${plainToken('alice', 'right')}\r\n`, 'b1'), /^b1 OK/m, 'IR form authenticates');
    assert.match(await c.run('b2 SELECT INBOX\r\n', 'b2'), /^b2 OK/m, 'and the session is now authenticated');
    c.sock.destroy();
  }
  // Continuation form: AUTHENTICATE PLAIN -> "+" -> base64.
  {
    const c = connect(server.port);
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    c.sock.write(Buffer.from('c1 AUTHENTICATE PLAIN\r\n', 'latin1'));
    await delay(40);
    assert.match(await c.run(`${plainToken('alice', 'right')}\r\n`, 'c1'), /^c1 OK/m, 'continuation form authenticates');
    c.sock.destroy();
  }
  // Wrong credentials are refused.
  {
    const c = connect(server.port);
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    assert.match(await c.run(`d1 AUTHENTICATE PLAIN ${plainToken('alice', 'wrong')}\r\n`, 'd1'), /^d1 NO/m, 'bad credentials are refused');
    c.sock.destroy();
  }
  await server.close();
});
