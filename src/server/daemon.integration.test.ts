/**
 * The fully-assembled daemon: startServer wires the store, accounts, and the three
 * listeners together exactly as `node src/main.ts` does. This test drives that
 * assembly on ephemeral ports — deliver a message to the inbound SMTP listener, then
 * LOGIN to IMAPS with a real account and FETCH it back byte-exact — and confirms a
 * wrong LOGIN is rejected. It is the proof that the daemon (not just the individual
 * servers) works end to end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { deliver } from '../client/deliver.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';
import { readMessages } from '../testing/read-messages.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CONFIG: MailServerConfig = {
  dbPath: ':memory:',
  host: '127.0.0.1',
  smtpPort: 0,
  submissionPort: 0,
  imapPort: 0,
  domain: 'mail.example.test',
  accounts: [{ user: 'alice', pass: 's3cret-passphrase' }],
  tls: { key: TEST_KEY, cert: TEST_CERT },
};

/** Connect IMAPS, LOGIN with the given creds, and return the tagged LOGIN response. */
async function imapsLogin(port: number, user: string, pass: string): Promise<{ ok: boolean; body: Buffer | null }> {
  const sock = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
  const chunks: Buffer[] = [];
  sock.on('data', (d) => chunks.push(Buffer.from(d)));
  sock.on('error', () => {});
  await new Promise<void>((r) => sock.once('secureConnect', () => r()));
  const all = (): Buffer => Buffer.concat(chunks);
  const waitFor = async (needle: string): Promise<string> => {
    for (let i = 0; i < 400; i++) {
      const at = all().indexOf(Buffer.from(needle, 'latin1'));
      if (at !== -1) return all().subarray(0, at + needle.length).toString('latin1');
      await delay(5);
    }
    throw new Error(`timed out waiting for ${needle}`);
  };
  await waitFor('* OK');
  sock.write(Buffer.from(`a1 LOGIN ${user} ${pass}\r\n`, 'latin1'));
  // Wait for the tagged LOGIN result (OK or NO).
  let loginOk: boolean | null = null;
  for (let i = 0; i < 400 && loginOk === null; i++) {
    const s = all().toString('latin1');
    if (s.includes('a1 OK')) loginOk = true;
    else if (s.includes('a1 NO')) loginOk = false;
    else await delay(5);
  }
  if (loginOk !== true) {
    sock.end();
    return { ok: false, body: null };
  }
  sock.write(Buffer.from('a2 SELECT INBOX\r\n', 'latin1'));
  await waitFor('a2 OK');
  const before = all().length;
  sock.write(Buffer.from('a3 FETCH 1 BODY[]\r\n', 'latin1'));
  await waitFor('a3 OK');
  const resp = all().subarray(before);
  const marker = /\{(\d+)\}\r\n/.exec(resp.toString('latin1'))!;
  const start = resp.indexOf(Buffer.from(marker[0], 'latin1')) + marker[0].length;
  sock.end();
  return { ok: true, body: Buffer.from(resp.subarray(start, start + Number(marker[1]))) };
}

test('daemon: deliver via inbound SMTP, read back via IMAPS with a real login', async () => {
  const server = await startServer(CONFIG);
  try {
    const data = Buffer.from('Subject: hello from the daemon\r\n\r\nthe whole thing runs\r\n', 'latin1');
    const sent = await deliver(
      { host: '127.0.0.1', port: server.inbound.port, tls: 'none' },
      { from: 'someone@example.net', recipients: ['alice@mail.example.test'], data, clientName: 'sender.example.net' },
    );
    assert.ok(sent.ok, `inbound delivery should succeed: ${sent.failure}`);
    assert.equal(readMessages(server.mailbox).length, 1, 'stored in the daemon mailbox');

    // The daemon prepends a Received trace line (§4.4) on inbound delivery, then
    // the original message follows byte-exact.
    const good = await imapsLogin(server.imap.port, 'alice', 's3cret-passphrase');
    assert.ok(good.ok, 'correct credentials log in');
    const body = good.body!.toString('latin1');
    assert.match(body, /^Received: from sender\.example\.net .*by mail\.example\.test with ESMTP id .*for <alice@mail\.example\.test>;/m, 'a Received trace line was prepended');
    assert.ok(good.body!.subarray(good.body!.indexOf(Buffer.from('Subject:'))).equals(data), 'the original message follows the trace line byte-exact');

    // Wrong password is rejected.
    const bad = await imapsLogin(server.imap.port, 'alice', 'wrong');
    assert.ok(!bad.ok, 'a wrong password is rejected at LOGIN');
  } finally {
    await server.close();
  }
});

test('daemon inbound rejects RCPT for a foreign domain (no relay / backscatter)', async () => {
  const server = await startServer(CONFIG);
  const rcptReply = async (rcpt: string): Promise<string> => {
    const sock = net.connect(server.inbound.port, '127.0.0.1');
    sock.on('error', () => {});
    let acc = '';
    sock.on('data', (d) => (acc += d.toString('latin1')));
    await new Promise<void>((r) => sock.once('connect', () => r()));
    const step = (s: string): Promise<void> =>
      new Promise((r) => {
        acc = '';
        sock.write(Buffer.from(s, 'latin1'));
        setTimeout(r, 40);
      });
    await delay(40);
    await step('EHLO probe\r\n');
    await step('MAIL FROM:<a@probe.test>\r\n');
    await step(`RCPT TO:<${rcpt}>\r\n`);
    const reply = acc.trim();
    sock.destroy();
    return reply;
  };
  try {
    // A KNOWN local account is accepted; an unknown localpart is rejected (no catch-all,
    // ADR 0009), and the account login is matched case-insensitively.
    assert.match(await rcptReply('alice@mail.example.test'), /^250 /, 'a known local account is accepted');
    assert.match(await rcptReply('ALICE@mail.example.test'), /^250 /, 'the localpart is matched case-insensitively');
    assert.match(await rcptReply('whoever@mail.example.test'), /^55[04] /, 'an unknown localpart is rejected (no catch-all)');
    // A foreign domain must be refused — we are not an open relay and will not
    // accept mail we cannot deliver.
    const foreign = await rcptReply('victim@gmail.com');
    assert.match(foreign, /^55[04] /, 'a foreign-domain recipient is rejected');
    assert.match(foreign, /relay/i, 'the rejection names relaying denied');
  } finally {
    await server.close();
  }
});
