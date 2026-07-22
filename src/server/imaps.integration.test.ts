/**
 * IMAP over implicit TLS (IMAPS — port 993 in production, what Thunderbird and Apple
 * Mail connect with). A message delivered via SMTP is fetched back over an encrypted
 * IMAP connection, byte-exact. This is the last transport piece for real-client
 * compatibility: the read leg speaks TLS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { DatabaseSync } from 'node:sqlite';
import { deliver } from '../client/deliver.ts';
import { SmtpReceiver } from './smtp-receiver.ts';
import { ImapServer } from './imap-server.ts';
import { SqliteMailbox } from '../store/sqlite-mailbox.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchOverTls(port: number): Promise<Buffer> {
  const sock = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
  const chunks: Buffer[] = [];
  sock.on('data', (d) => chunks.push(Buffer.from(d)));
  sock.on('error', () => {});
  await new Promise<void>((r) => sock.once('secureConnect', () => r()));
  const all = (): Buffer => Buffer.concat(chunks);
  const waitFor = async (needle: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (all().includes(Buffer.from(needle, 'latin1'))) return;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${needle}`);
  };
  await waitFor('* OK');
  sock.write(Buffer.from('a1 LOGIN user pass\r\na2 SELECT INBOX\r\n', 'latin1'));
  await waitFor('a2 OK');
  const before = all().length;
  sock.write(Buffer.from('a3 FETCH 1 BODY[]\r\n', 'latin1'));
  await waitFor('a3 OK');
  const resp = all().subarray(before);
  const marker = /\{(\d+)\}\r\n/.exec(resp.toString('latin1'))!;
  const start = resp.indexOf(Buffer.from(marker[0], 'latin1')) + marker[0].length;
  sock.end();
  return Buffer.from(resp.subarray(start, start + Number(marker[1])));
}

test('IMAPS: a delivered message is fetched back byte-exact over an encrypted IMAP connection', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  const smtp = await SmtpReceiver.start((m) => { mailbox.append(m.data); });
  const imap = await ImapServer.start(mailbox, { tls: { key: TEST_KEY, cert: TEST_CERT } });
  try {
    const data = Buffer.from('Subject: over imaps\r\n\r\nread me over TLS\r\n', 'latin1');
    const sent = await deliver(
      { host: '127.0.0.1', port: smtp.port, tls: 'none' },
      { from: 'a@example.com', recipients: ['b@example.net'], data, clientName: 'c.example.org' },
    );
    assert.ok(sent.ok, 'delivery should succeed');

    const fetched = await fetchOverTls(imap.port);
    assert.deepEqual(fetched, data, 'the message reads back byte-exact over TLS');
  } finally {
    await imap.close();
    await smtp.close();
    db.close();
  }
});

test('IMAPS: a TLS handshake that begins but never completes is dropped within the deadline', async () => {
  // A handshake slowloris: open the TCP connection, send a byte that opens a TLS record, then
  // withhold the rest forever. Without an explicit handshakeTimeout Node holds the slot for its
  // 120s default; the tight deadline drops it. A tiny timeout keeps the test fast.
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  const imap = await ImapServer.start(mailbox, { tls: { key: TEST_KEY, cert: TEST_CERT }, handshakeTimeoutMs: 300 });
  try {
    const sock = net.connect(imap.port, '127.0.0.1');
    sock.on('error', () => {}); // the server tearing down the half-open handshake surfaces as an error
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.write(Buffer.from([0x16])); // the first octet of a TLS record; nothing more is sent
    const start = Date.now();
    const closed = await new Promise<boolean>((resolve) => {
      sock.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000).unref();
    });
    assert.ok(closed, 'the half-open handshake socket is closed by the server');
    assert.ok(Date.now() - start < 2500, 'and dropped near the handshake deadline, not the 120s default');
    sock.destroy();
  } finally {
    await imap.close();
    db.close();
  }
});
