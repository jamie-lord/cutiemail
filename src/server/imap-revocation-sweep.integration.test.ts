/**
 * Revocation must not depend on the session sending another command.
 *
 * `imap-disable-session.integration.test.ts` covers the case that always worked: an authenticated
 * session that ISSUES a command is refused at that command. But the check lived only on that path,
 * and two very ordinary states never reach it:
 *
 *  - an IDLE session, which short-circuits to `continue` before the gate — and IDLE is the resting
 *    state of every mainstream IMAP client, so it is exactly where a hijacked session will be when
 *    the operator reacts;
 *  - any session dribbling bytes that never complete a line, which also defeats the inactivity
 *    autologout because the timer is reset by received bytes rather than by progress.
 *
 * A third gap had no command-driven fix at all: `account set-password` is the other half of a
 * compromise response, and on its own it cut nothing, because nothing compared the session's
 * credential against the current one. So disable → rotate → re-enable left the attacker's session
 * working with a credential that no longer existed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';
import { MailboxNotifier } from './mailbox-notifier.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Client {
  readonly sock: net.Socket;
  readonly acc: () => string;
  readonly closed: () => boolean;
  runUntil: (write: string, re: RegExp) => Promise<void>;
}

function connect(port: number): Client {
  const sock = net.connect(port, '127.0.0.1');
  let acc = '';
  let closed = false;
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('close', () => (closed = true));
  sock.on('error', () => {});
  return {
    sock,
    acc: () => acc,
    closed: () => closed,
    runUntil: async (write: string, re: RegExp): Promise<void> => {
      const from = acc.length;
      if (write !== '') sock.write(Buffer.from(write, 'latin1'));
      for (let i = 0; i < 400; i++) {
        if (re.test(acc.slice(from))) return;
        await delay(5);
      }
      throw new Error(`timed out waiting for ${re}: ${acc.slice(from)}`);
    },
  };
}

/** Wait for the server's revocation sweep to observe a change. */
async function waitClosed(c: Client, whatFor: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (c.closed()) return;
    await delay(25);
  }
  throw new Error(`session was never cut after ${whatFor}`);
}

test('an IDLE session is cut when the account is disabled, without sending another command', async () => {
  const cat = new MemoryCatalog();
  let enabled = true;
  const server = await ImapServer.start(cat, {
    authenticate: async (u, p) => u === 'alice' && p === 'right',
    isEnabled: (login) => login === 'alice' && enabled,
    notifier: new MailboxNotifier(),
    revocationSweepMs: 25,
  });
  const c = connect(server.port);
  try {
    await c.runUntil('', /^\* OK/m);
    await c.runUntil('a1 LOGIN alice right\r\n', /^a1 OK/m);
    await c.runUntil('a2 SELECT INBOX\r\n', /^a2 OK/m);
    await c.runUntil('a3 IDLE\r\n', /^\+ /m); // parked in IDLE — the gate is never reached from here
    assert.equal(c.closed(), false, 'control: an enabled account keeps its IDLE session');

    enabled = false;
    await waitClosed(c, 'the account was disabled while idling');
    assert.match(c.acc(), /\* BYE account disabled/, 'and it is told why');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('a session that never completes a command line is cut too (the autologout cannot be relied on)', async () => {
  const cat = new MemoryCatalog();
  let enabled = true;
  const server = await ImapServer.start(cat, {
    authenticate: async (u, p) => u === 'alice' && p === 'right',
    isEnabled: (login) => login === 'alice' && enabled,
    revocationSweepMs: 25,
  });
  const c = connect(server.port);
  try {
    await c.runUntil('', /^\* OK/m);
    await c.runUntil('a1 LOGIN alice right\r\n', /^a1 OK/m);
    // A single byte with no CRLF: never a command, but enough to reset the inactivity timer
    // indefinitely. Keep dribbling throughout, exactly as an attacker holding the socket would.
    const dribble = setInterval(() => c.sock.write('Z'), 50);
    try {
      enabled = false;
      await waitClosed(c, 'the account was disabled while dribbling bytes');
    } finally {
      clearInterval(dribble);
    }
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('rotating the password alone cuts a live session, even while the account stays enabled', async () => {
  const cat = new MemoryCatalog();
  // The credential fingerprint the daemon derives from the registry row; rotating the password
  // changes it. The account is never disabled here — rotation is the whole containment action.
  let tag = 'credential-v1';
  const server = await ImapServer.start(cat, {
    authenticate: async (u, p) => u === 'alice' && p === 'right',
    isEnabled: () => true,
    credentialTag: () => tag,
    revocationSweepMs: 25,
  });
  const c = connect(server.port);
  try {
    await c.runUntil('', /^\* OK/m);
    await c.runUntil('a1 LOGIN alice right\r\n', /^a1 OK/m);
    await c.runUntil('a2 SELECT INBOX\r\n', /^a2 OK/m);
    assert.equal(c.closed(), false, 'control: the session survives while the credential is unchanged');

    tag = 'credential-v2'; // `account set-password alice`
    await waitClosed(c, 'the password was rotated');
    assert.match(c.acc(), /\* BYE credentials revoked/);
  } finally {
    c.sock.destroy();
    await server.close();
  }
});
