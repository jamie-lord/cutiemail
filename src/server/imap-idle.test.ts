/**
 * IMAP IDLE (RFC 2177): a client that has SELECTed a mailbox and issued IDLE is
 * told the instant the mailbox gains a message — pushed as an untagged EXISTS —
 * without polling. This is what makes new mail appear in Thunderbird instantly.
 * The notification comes from the same MailboxNotifier the daemon fires after an
 * inbound delivery, so this drives that real path: subscribe via IDLE, append +
 * notify, expect EXISTS, then DONE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';
import { MailboxNotifier } from './mailbox-notifier.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Session {
  #acc = Buffer.alloc(0);
  readonly sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
    sock.on('error', () => {});
  }
  send(s: string): void {
    this.sock.write(Buffer.from(s, 'latin1'));
  }
  async waitFor(needle: string): Promise<string> {
    for (let i = 0; i < 400; i++) {
      const s = this.#acc.toString('latin1');
      if (s.includes(needle)) return s;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)} in ${JSON.stringify(this.#acc.toString('latin1'))}`);
  }
}

test('IDLE pushes EXISTS when the mailbox gains a message, then DONE terminates', async () => {
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  inbox.append(Buffer.from('Subject: one\r\n\r\nx\r\n', 'latin1'));
  const notifier = new MailboxNotifier();

  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new Session(sock);
  try {
    await s.waitFor('* OK');
    s.send('a1 LOGIN test pw\r\n');
    await s.waitFor('a1 OK');
    s.send('a2 SELECT INBOX\r\n');
    await s.waitFor('a2 OK');

    s.send('a3 IDLE\r\n');
    await s.waitFor('+ idling');

    // A new message arrives via the inbound path and the daemon notifies.
    inbox.append(Buffer.from('Subject: two\r\n\r\ny\r\n', 'latin1'));
    notifier.notify('INBOX');
    const pushed = await s.waitFor('* 2 EXISTS');
    assert.match(pushed, /\* 2 EXISTS/, 'the new count was pushed unsolicited during IDLE');

    s.send('DONE\r\n');
    await s.waitFor('a3 OK IDLE terminated');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('IDLE without a notifier is refused, not hung', async () => {
  const catalog = new MemoryCatalog();
  const server = await ImapServer.start(catalog, { authenticate: () => true }); // no notifier
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new Session(sock);
  try {
    await s.waitFor('* OK');
    s.send('a1 LOGIN test pw\r\na2 SELECT INBOX\r\n');
    await s.waitFor('a2 OK');
    s.send('a3 IDLE\r\n');
    await s.waitFor('a3 NO');
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('a notification with no net change does not push a spurious EXISTS', async () => {
  const catalog = new MemoryCatalog();
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, { authenticate: () => true, notifier });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new Session(sock);
  try {
    await s.waitFor('* OK');
    s.send('a1 LOGIN test pw\r\na2 SELECT INBOX\r\na3 IDLE\r\n');
    await s.waitFor('+ idling');
    notifier.notify('INBOX'); // fired, but the mailbox count is unchanged
    await delay(40);
    s.send('DONE\r\n');
    const all = await s.waitFor('a3 OK');
    // Only the segment after IDLE began matters (SELECT itself sends * 0 EXISTS).
    const duringIdle = all.slice(all.indexOf('+ idling'));
    assert.doesNotMatch(duringIdle, /EXISTS/, 'no EXISTS pushed when nothing changed');
  } finally {
    sock.destroy();
    await server.close();
  }
});
