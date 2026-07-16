/**
 * Outbound relay end to end: an authenticated submission addressed to a REMOTE
 * recipient is relayed onward to that recipient's mail server. This is the send
 * leg the daemon was missing — proof that "compose in a client, send to the
 * outside world" reaches a real downstream MX.
 *
 * We can't reach the real internet in a test, so the recipient MX is a capture
 * SmtpReceiver on an ephemeral port and the daemon's DNS is injected to resolve
 * every domain to it. Everything else — STARTTLS, SASL AUTH, MX ordering reuse,
 * the delivery transaction, dot round-trip — is the real code path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { SmtpReceiver } from './smtp-receiver.ts';
import type { DeliveredMessage } from './smtp-receiver.ts';
import { relayOutbound, routeRecipients } from './outbound.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const plainToken = (user: string, pass: string): string => Buffer.from(`\0${user}\0${pass}`, 'latin1').toString('base64');

class Reader {
  #acc = Buffer.alloc(0);
  constructor(sock: NodeJS.ReadableStream) {
    sock.on('data', (d: Buffer) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
  }
  async line(needle: string): Promise<void> {
    const n = Buffer.from(needle, 'latin1');
    for (let i = 0; i < 400; i++) {
      const at = this.#acc.indexOf(n);
      if (at !== -1) {
        this.#acc = this.#acc.subarray(at + n.length);
        return;
      }
      await delay(5);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
  }
}

const waitUntil = async (pred: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('routeRecipients splits on the local domain, case-insensitively', () => {
  const { local, remote } = routeRecipients(
    ['me@mail.example.test', 'me@MAIL.EXAMPLE.TEST', 'friend@elsewhere.example'],
    'mail.example.test',
  );
  assert.deepEqual(local, ['me@mail.example.test', 'me@MAIL.EXAMPLE.TEST']);
  assert.deepEqual(remote, ['friend@elsewhere.example']);
});

test('relayOutbound delivers to the recipient MX, byte-exact', async () => {
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => received.push(m), { domain: 'mx.elsewhere.example' });
  try {
    const data = Buffer.from('Subject: outbound\r\n\r\nrelayed to the world\r\n', 'latin1');
    const results = await relayOutbound(
      { from: 'me@mail.example.test', recipients: ['friend@elsewhere.example'], data },
      { clientName: 'mail.example.test', resolveHosts: async () => ['127.0.0.1'], port: mx.port },
    );
    assert.deepEqual(
      results.map((r) => r.ok),
      [true],
      `relay should succeed: ${JSON.stringify(results)}`,
    );
    assert.equal(received.length, 1, 'the MX received exactly one message');
    assert.equal(received[0]!.from, 'me@mail.example.test');
    assert.deepEqual(received[0]!.recipients, ['friend@elsewhere.example']);
    assert.deepEqual(received[0]!.data, data, 'message arrived at the MX byte-exact');
  } finally {
    await mx.close();
  }
});

test('relayOutbound reports failure (not throw) when a domain has no MX/address', async () => {
  const results = await relayOutbound(
    { from: 'me@mail.example.test', recipients: ['nobody@nowhere.invalid'], data: Buffer.from('x') },
    { clientName: 'mail.example.test', resolveHosts: async () => [] },
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]!.ok, false);
  assert.match(results[0]!.detail, /no MX or address record/);
});

test('daemon: authenticated submission relays a remote recipient and stores a local one', async () => {
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => received.push(m), { domain: 'mx.elsewhere.example' });

  const config: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [{ user: 'alice', pass: 'correct horse' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    // Every remote domain resolves to our capture MX.
    outbound: { resolveHosts: async () => ['127.0.0.1'], port: mx.port },
  };
  const server = await startServer(config);
  try {
    // Submit over STARTTLS + AUTH PLAIN, one message with a local AND a remote recipient.
    const raw = net.connect(server.submission.port, '127.0.0.1');
    raw.on('error', () => {});
    const rr = new Reader(raw);
    await rr.line('ESMTP\r\n');
    raw.write('EHLO thunderbird\r\n');
    await rr.line('250 STARTTLS\r\n');
    raw.write('STARTTLS\r\n');
    await rr.line('Ready to start TLS\r\n');
    const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
    secure.on('error', () => {});
    await new Promise<void>((r) => secure.once('secureConnect', () => r()));
    const sr = new Reader(secure);
    secure.write('EHLO thunderbird\r\n');
    await sr.line('250 AUTH PLAIN\r\n');
    secure.write('AUTH PLAIN ' + plainToken('alice', 'correct horse') + '\r\n');
    await sr.line('235');
    secure.write('MAIL FROM:<alice@mail.example.test>\r\n');
    await sr.line('2.1.0 Ok\r\n');
    secure.write('RCPT TO:<alice@mail.example.test>\r\n'); // local -> mailbox
    await sr.line('2.1.5 Ok\r\n');
    secure.write('RCPT TO:<friend@elsewhere.example>\r\n'); // remote -> relayed
    await sr.line('2.1.5 Ok\r\n');
    secure.write('DATA\r\n');
    await sr.line('354');
    secure.write('Subject: split\r\n\r\nlocal and remote at once\r\n.\r\n');
    await sr.line('message stored\r\n');
    secure.end();

    // Local recipient: in the mailbox.
    assert.equal(server.mailbox.messages.length, 1, 'the local copy was stored');
    // Remote recipient: relayed to the MX (relay is async after the 250).
    await waitUntil(() => received.length === 1, 'the remote copy to reach the MX');
    assert.deepEqual(received[0]!.recipients, ['friend@elsewhere.example'], 'only the remote recipient was relayed');
    assert.ok(received[0]!.data.includes(Buffer.from('local and remote at once')), 'the relayed body is the submitted message');
    // RFC 6409 fix-up: the client sent neither header; the MSA must have added
    // both (Gmail rejects mail without a Message-ID).
    const relayed = received[0]!.data.toString('latin1');
    assert.match(relayed, /^Message-ID: <[^>]+@mail\.example\.test>\r\n/m, 'a Message-ID was added at submission');
    assert.match(relayed, /^Date: /m, 'a Date was added at submission');
  } finally {
    await server.close();
    await mx.close();
  }
});
