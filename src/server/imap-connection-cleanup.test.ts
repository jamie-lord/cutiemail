/**
 * Connection-teardown leak guard. Per-connection state — the socket in `#sockets`, an IDLE
 * subscription in the notifier, an APPEND reservation, the autologout timer — must ALL be released
 * when the connection goes away, including on an ABRUPT close (RST, no LOGOUT/DONE), which is how
 * real clients and slow-loris attackers actually disappear. If any isn't, a server that has served
 * many connections slowly accumulates them — the classic soak leak.
 *
 * This churns connections that SELECT + IDLE (creating a subscription) then vanish abruptly, and
 * asserts both live-connection and live-subscription counts return to zero — across repeated cycles,
 * so nothing accumulates run to run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';
import { MailboxNotifier } from './mailbox-notifier.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Connect, LOGIN, SELECT INBOX, IDLE — leaving one live connection with one live subscription. */
function idleConn(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let stage = 0;
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (stage === 0 && /\* OK/.test(buf)) {
        stage = 1;
        buf = '';
        sock.write(Buffer.from('a LOGIN u p\r\n', 'latin1'));
      } else if (stage === 1 && /a OK/.test(buf)) {
        stage = 2;
        buf = '';
        sock.write(Buffer.from('b SELECT INBOX\r\n', 'latin1'));
      } else if (stage === 2 && /b OK/.test(buf)) {
        stage = 3;
        buf = '';
        sock.write(Buffer.from('c IDLE\r\n', 'latin1'));
      } else if (stage === 3 && /\+ /.test(buf)) {
        resolve(sock); // now idling → subscribed
      }
    });
    sock.on('error', reject);
  });
}

test('connections and IDLE subscriptions are fully released on abrupt close, across cycles', async () => {
  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(new MemoryCatalog(), { authenticate: () => true, notifier });
  try {
    const K = 25;
    for (let cycle = 0; cycle < 3; cycle++) {
      const conns = await Promise.all(Array.from({ length: K }, () => idleConn(server.port)));
      // All K are now connected and idling: both counts reflect them.
      assert.equal(server.connectionCount, K, `cycle ${cycle}: ${K} live connections`);
      assert.equal(notifier.subscriberCount, K, `cycle ${cycle}: ${K} live IDLE subscriptions`);

      // Vanish abruptly — no DONE, no LOGOUT, just a reset. The teardown must still fire.
      for (const s of conns) s.destroy();

      // Wait for the OS 'close' events to propagate and cleanup to run.
      for (let i = 0; i < 200 && (server.connectionCount > 0 || notifier.subscriberCount > 0); i++) await delay(10);
      assert.equal(server.connectionCount, 0, `cycle ${cycle}: every connection released after abrupt close`);
      assert.equal(notifier.subscriberCount, 0, `cycle ${cycle}: every IDLE subscription released after abrupt close`);
    }
  } finally {
    await server.close();
  }
});
