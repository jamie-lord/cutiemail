/**
 * Shutdown tells connected clients why (RFC 9051 §7.1.5).
 *
 * A server closing a connection for its own reasons SHOULD send an untagged BYE first. Without it a
 * client sees a socket vanish mid-session, which is indistinguishable from a network fault and is
 * generally reported to the user as one. This matters more now than it used to: a version cutover
 * (ADR 0025) restarts the daemon on purpose, and a clean handover should not surface as an error on
 * somebody's phone.
 *
 * The other half is that saying goodbye must not become a way to hold the shutdown open. A client
 * that stops reading gets a bounded grace period and is then reclaimed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

/** Connect and LOGIN, resolving with the socket and everything it has been sent. */
function loggedIn(port: number): Promise<{ sock: net.Socket; text: () => string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let stage = 0;
    sock.on('error', reject);
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (stage === 0 && /\* OK/.test(buf)) {
        stage = 1;
        sock.write(Buffer.from('a LOGIN u p\r\n', 'latin1'));
      } else if (stage === 1 && /a OK/.test(buf)) {
        stage = 2;
        resolve({ sock, text: () => buf });
      }
    });
  });
}

test('a shutdown sends BYE to every connected session before closing it', async () => {
  const server = await ImapServer.start(new MemoryCatalog(), { authenticate: async () => true });
  const sessions = await Promise.all([loggedIn(server.port), loggedIn(server.port), loggedIn(server.port)]);
  const closed = sessions.map(
    (s) => new Promise<void>((resolve) => s.sock.once('close', () => resolve())),
  );

  await server.close();
  await Promise.all(closed);

  for (const [i, session] of sessions.entries()) {
    assert.match(session.text(), /\* BYE Server shutting down/, `session ${i} was told the server was going away`);
  }
});

test('a client that stops reading cannot hold the shutdown open', async () => {
  const server = await ImapServer.start(new MemoryCatalog(), { authenticate: async () => true });
  const { sock } = await loggedIn(server.port);
  // Stop consuming, and never close: the shape of a wedged or half-dead client. Without the
  // bounded grace period, `close()` would wait on this socket for as long as it chose to exist.
  sock.pause();

  const started = Date.now();
  await server.close();
  const took = Date.now() - started;
  assert.ok(took < 5000, `close() completed in ${took}ms rather than waiting on an unresponsive client`);
  sock.destroy();
});
