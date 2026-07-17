/**
 * The full round-trip: deliver a message via SMTP, then read it back via IMAP — the
 * "send and receive with existing clients" goal, proven end to end against real
 * socket servers and real SQLite storage. The reference delivery client stores a
 * message through the live SMTP receiver into a SqliteMailbox; a minimal IMAP client
 * then LOGINs, SELECTs, and FETCHes BODY[] from the live IMAP server serving that
 * same mailbox. The bytes fetched must equal the bytes delivered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { deliver } from '../client/deliver.ts';
import { SmtpReceiver } from './smtp-receiver.ts';
import { ImapServer } from './imap-server.ts';
import { SqliteMailbox } from '../store/sqlite-mailbox.ts';
import { MailboxNotifier } from './mailbox-notifier.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A minimal IMAP client: LOGIN, SELECT INBOX, FETCH 1 BODY[]; returns the body bytes. */
async function fetchFirstBody(port: number): Promise<Buffer> {
  const sock = net.connect(port, '127.0.0.1');
  const chunks: Buffer[] = [];
  sock.on('data', (d) => chunks.push(Buffer.from(d)));
  sock.on('error', () => {});
  const all = (): Buffer => Buffer.concat(chunks);
  const waitFor = (needle: string): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (all().includes(Buffer.from(needle, 'latin1'))) resolve();
        else setTimeout(check, 5);
      };
      check();
    });

  await waitFor('* OK');
  sock.write(Buffer.from('a1 LOGIN user pass\r\n', 'latin1'));
  await waitFor('a1 OK');
  sock.write(Buffer.from('a2 SELECT INBOX\r\n', 'latin1'));
  await waitFor('a2 OK');
  const before = all().length;
  sock.write(Buffer.from('a3 FETCH 1 BODY[]\r\n', 'latin1'));
  await waitFor('a3 OK');
  const resp = all().subarray(before);

  // Parse the BODY[] literal: "... {N}\r\n<N bytes>)".
  const marker = /\{(\d+)\}\r\n/.exec(resp.toString('latin1'));
  assert.ok(marker !== null, 'a literal marker is present in the FETCH response');
  const n = Number(marker[1]);
  const start = resp.indexOf(Buffer.from(marker[0], 'latin1')) + marker[0].length;
  const body = resp.subarray(start, start + n);
  sock.write(Buffer.from('a4 LOGOUT\r\n', 'latin1'));
  sock.end();
  return Buffer.from(body);
}

test('round-trip: a message sent via SMTP is read back byte-exact via IMAP', async () => {
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db, 55);
  const smtp = await SmtpReceiver.start((msg) => { mailbox.append(msg.data, ['\\Recent']); });
  const imap = await ImapServer.start(mailbox);
  try {
    const data = Buffer.from(
      'From: alice@example.com\r\nTo: bob@example.net\r\nSubject: round trip\r\n\r\n' +
        'This message was sent over SMTP and read back over IMAP.\r\n.dotted line preserved\r\n',
      'latin1',
    );
    const sent = await deliver(
      { host: '127.0.0.1', port: smtp.port, tls: 'none' },
      { from: 'alice@example.com', recipients: ['bob@example.net'], data, clientName: 'client.example.org' },
    );
    assert.ok(sent.ok, `SMTP delivery should succeed: ${sent.failure}`);
    assert.equal(mailbox.messages.length, 1, 'the message is in storage');

    const fetched = await fetchFirstBody(imap.port);
    assert.deepEqual(fetched, data, 'the bytes read back via IMAP equal the bytes sent via SMTP');
  } finally {
    await imap.close();
    await smtp.close();
    db.close();
  }
});

test('cross-subsystem: SMTP delivery wakes a CONDSTORE-enabled idling IMAP client, which fetches the new mail with MODSEQ', async () => {
  // The path a real desktop client lives on: SELECT + IDLE, and new mail (arriving over
  // SMTP from the internet) appears instantly. This wires the receiver's delivery to the
  // same MailboxNotifier the daemon uses, and drives a CONDSTORE session through it.
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db, 42);
  const notifier = new MailboxNotifier();
  const smtp = await SmtpReceiver.start((msg) => {
    mailbox.append(msg.data);
    notifier.notify('INBOX'); // exactly what main.ts does after an inbound delivery
  });
  const imap = await ImapServer.start(mailbox, { authenticate: () => true, notifier });
  const sock = net.connect(imap.port, '127.0.0.1');
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('error', () => {});
  const run = async (tag: string, cmd: string): Promise<string> => {
    const from = acc.length;
    sock.write(Buffer.from(`${tag} ${cmd}\r\n`, 'latin1'));
    for (let i = 0; i < 400; i++) {
      const idx = acc.indexOf(`${tag} `, from);
      if (idx >= 0 && /\r\n/.test(acc.slice(idx))) return acc.slice(from);
      await delay(5);
    }
    throw new Error(`timeout ${cmd}`);
  };
  const waitFor = async (needle: string, from: number): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (acc.indexOf(needle, from) >= 0) return;
      await delay(5);
    }
    throw new Error(`timeout waiting ${needle}`);
  };
  try {
    for (let i = 0; i < 400 && !acc.includes('* OK'); i++) await delay(5);
    await run('a1', 'LOGIN user pass');
    await run('a2', 'SELECT INBOX (CONDSTORE)'); // empty mailbox, CONDSTORE on
    const idleFrom = acc.length;
    sock.write(Buffer.from('a3 IDLE\r\n', 'latin1'));
    await waitFor('+ idling', idleFrom);

    // A message arrives over SMTP from "the internet".
    const data = Buffer.from('From: a@x.test\r\nTo: user@here.test\r\nSubject: live\r\n\r\nhello over SMTP\r\n', 'latin1');
    const sent = await deliver({ host: '127.0.0.1', port: smtp.port, tls: 'none' }, { from: 'a@x.test', recipients: ['user@here.test'], data, clientName: 'c.test' });
    assert.ok(sent.ok, 'SMTP delivery succeeds');

    // The idling client is told, in real time, that a message exists.
    await waitFor('* 1 EXISTS', idleFrom);
    sock.write(Buffer.from('DONE\r\n', 'latin1'));
    await waitFor('a3 OK', idleFrom); // IDLE terminated

    // It fetches the new message and — CONDSTORE being enabled — gets a MODSEQ with it.
    const fetch = await run('a4', 'FETCH 1 (FLAGS)');
    assert.match(fetch, /MODSEQ \(\d+\)/, 'the CONDSTORE session gets MODSEQ on the fetched new mail');
  } finally {
    sock.destroy();
    await imap.close();
    await smtp.close();
    db.close();
  }
});
