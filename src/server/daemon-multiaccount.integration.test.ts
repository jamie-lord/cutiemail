/**
 * End-to-end multi-account through the fully-assembled daemon (ADR 0009). Two real
 * accounts on one server, each with its own SQLite mail database. This exercises the
 * isolation property through the REAL storage + delivery path (not just the resolver):
 * inbound SMTP routes each message to the right user's INBOX, IMAPS serves each user
 * only their own mail, and a recipient with no account is rejected at RCPT.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { deliver } from '../client/deliver.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CONFIG: MailServerConfig = {
  dbPath: ':memory:',
  host: '127.0.0.1',
  smtpPort: 0,
  submissionPort: 0,
  imapPort: 0,
  domain: 'mail.example.test',
  accounts: [
    { user: 'alice', pass: 'alice-pass' },
    { user: 'bob', pass: 'bob-pass' },
  ],
  tls: { key: TEST_KEY, cert: TEST_CERT },
};

/** Log in over IMAPS, SELECT INBOX, and report the EXISTS count + the first message body. */
async function imapInbox(port: number, user: string, pass: string): Promise<{ ok: boolean; exists: number; body: string }> {
  const sock = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
  const chunks: Buffer[] = [];
  sock.on('data', (d) => chunks.push(Buffer.from(d)));
  sock.on('error', () => {});
  await new Promise<void>((r) => sock.once('secureConnect', () => r()));
  const all = (): string => Buffer.concat(chunks).toString('latin1');
  const waitFor = async (re: RegExp): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (re.test(all())) return;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${re} — got ${all()}`);
  };
  try {
    await waitFor(/\* OK/);
    sock.write(Buffer.from(`a1 LOGIN ${user} ${pass}\r\n`, 'latin1'));
    await waitFor(/a1 (OK|NO)/);
    if (/a1 NO/.test(all())) return { ok: false, exists: 0, body: '' };
    const beforeSel = Buffer.concat(chunks).length;
    sock.write(Buffer.from('a2 SELECT INBOX\r\n', 'latin1'));
    await waitFor(/a2 OK/);
    const selResp = Buffer.concat(chunks).subarray(beforeSel).toString('latin1');
    const exists = Number(/\* (\d+) EXISTS/.exec(selResp)?.[1] ?? '0');
    if (exists === 0) return { ok: true, exists: 0, body: '' };
    const beforeFetch = Buffer.concat(chunks).length;
    sock.write(Buffer.from('a3 FETCH 1 BODY[]\r\n', 'latin1'));
    await waitFor(/a3 OK/);
    return { ok: true, exists, body: Buffer.concat(chunks).subarray(beforeFetch).toString('latin1') };
  } finally {
    sock.end();
  }
}

test('two accounts receive isolated inbound mail, each visible only to its owner', async () => {
  const server = await startServer(CONFIG);
  try {
    const send = (rcpt: string, subject: string): Promise<{ ok: boolean; rcptCodes: readonly number[] }> =>
      deliver(
        { host: '127.0.0.1', port: server.inbound.port, tls: 'none' },
        { from: 'outsider@sender.test', recipients: [rcpt], data: Buffer.from(`Subject: ${subject}\r\n\r\nbody of ${subject}\r\n`, 'latin1'), clientName: 'sender.test' },
      );

    const toAlice = await send('alice@mail.example.test', 'for-alice');
    assert.ok(toAlice.ok, 'delivery to alice accepted');
    const toBob = await send('BOB@mail.example.test', 'for-bob'); // case-insensitive localpart
    assert.ok(toBob.ok, 'delivery to bob accepted (case-insensitive)');

    // A recipient with no account is rejected at RCPT — no catch-all.
    const toNobody = await send('nobody@mail.example.test', 'for-nobody');
    assert.ok(!toNobody.ok, 'delivery to an unknown local recipient fails');
    assert.ok(toNobody.rcptCodes.every((c) => c >= 500), `RCPT for an unknown account is 5yz: ${toNobody.rcptCodes}`);

    // Alice sees exactly her one message, not Bob's.
    const alice = await imapInbox(server.imap.port, 'alice', 'alice-pass');
    assert.ok(alice.ok, 'alice logs in');
    assert.equal(alice.exists, 1, 'alice has exactly one message');
    assert.match(alice.body, /for-alice/);
    assert.doesNotMatch(alice.body, /for-bob/, 'alice must not see bob\'s mail');

    // Bob sees exactly his one message, not Alice's.
    const bob = await imapInbox(server.imap.port, 'bob', 'bob-pass');
    assert.ok(bob.ok, 'bob logs in');
    assert.equal(bob.exists, 1, 'bob has exactly one message');
    assert.match(bob.body, /for-bob/);
    assert.doesNotMatch(bob.body, /for-alice/, 'bob must not see alice\'s mail');

    // Their stores are physically distinct instances.
    assert.notEqual(server.stores.get('alice'), server.stores.get('bob'));
  } finally {
    await server.close();
  }
});

test('a wrong password is rejected, and an enabled account on the same daemon still works', async () => {
  const server = await startServer(CONFIG);
  try {
    assert.equal((await imapInbox(server.imap.port, 'alice', 'WRONG')).ok, false, 'wrong password refused');
    assert.equal((await imapInbox(server.imap.port, 'alice', 'alice-pass')).ok, true, 'right password works');
  } finally {
    await server.close();
  }
});
