/**
 * `account disable` exists to contain a compromised credential, so it must cut a session that is
 * ALREADY authenticated, not merely refuse the next LOGIN. The IMAP server re-checks the login's
 * enabled status on every authenticated command (a cheap registry lookup in the daemon) and drops
 * the connection with an untagged BYE the moment it goes disabled. Reproduce-first: without the
 * recheck, the disabled session keeps serving commands until the daemon restarts and this fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('disabling an account mid-session drops the live IMAP connection with BYE at its next command', async () => {
  const cat = new MemoryCatalog();
  let enabled = true;
  const server = await ImapServer.start(cat, {
    authenticate: (u, p) => u === 'alice' && p === 'right',
    isEnabled: (login) => login === 'alice' && enabled,
  });
  const sock = net.connect(server.port, '127.0.0.1');
  let acc = '';
  let closed = false;
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('close', () => (closed = true));
  sock.on('error', () => {});

  const runUntil = async (write: string, re: RegExp): Promise<void> => {
    const from = acc.length;
    sock.write(Buffer.from(write, 'latin1'));
    for (let i = 0; i < 400; i++) {
      if (re.test(acc.slice(from))) return;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${re} after ${write.trim()}: ${acc.slice(from)}`);
  };

  try {
    await runUntil('', /^\* OK/m); // greeting
    await runUntil('a1 LOGIN alice right\r\n', /^a1 OK/m);
    await runUntil('a2 NOOP\r\n', /^a2 OK/m); // a command works while enabled (control)

    enabled = false; // operator runs `account disable alice`

    const from = acc.length;
    sock.write(Buffer.from('a3 NOOP\r\n', 'latin1'));
    let sawBye = false;
    for (let i = 0; i < 400; i++) {
      if (/\* BYE account disabled/.test(acc.slice(from))) { sawBye = true; break; }
      await delay(5);
    }
    assert.ok(sawBye, 'the next command after disable draws an untagged BYE');
    // The tagged OK must NOT appear: the command is not served, the session is cut.
    assert.doesNotMatch(acc.slice(from), /^a3 OK/m, 'the disabled command is not executed');
    for (let i = 0; i < 400 && !closed; i++) await delay(5);
    assert.ok(closed, 'the connection is dropped, not left open');
  } finally {
    await server.close();
    sock.destroy();
  }
});
