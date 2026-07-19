/**
 * App-specific passwords authenticate over the wire (ADR 0017), end to end through the SAME
 * registry-backed verify closure the daemon wires (`(u, p) => registry.verifyPassword(u, p)`,
 * main.ts). This proves the feature works where it matters — a real IMAP LOGIN — not only in the
 * registry unit test, and that a revocation takes effect live (the daemon reads the registry per
 * attempt). Because every live auth path funnels through that one closure, an app password that
 * logs in here logs in on submission too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';
import { AccountRegistry } from '../store/account-registry.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function connect(port: number): { sock: net.Socket; run: (cmds: string, doneTag: string) => Promise<string> } {
  const sock = net.connect(port, '127.0.0.1');
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('error', () => {});
  const run = async (cmds: string, doneTag: string): Promise<string> => {
    const from = acc.length;
    sock.write(Buffer.from(cmds, 'latin1'));
    for (let i = 0; i < 400; i++) {
      if (new RegExp(`^${doneTag} (OK|NO|BAD)`, 'm').test(acc.slice(from))) return acc.slice(from);
      await delay(5);
    }
    throw new Error(`timed out on ${doneTag}: ${acc.slice(from)}`);
  };
  return { sock, run };
}

test('an app password logs in over IMAP via the real registry verify; revocation takes effect live', async () => {
  const reg = AccountRegistry.open(new DatabaseSync(':memory:'));
  reg.upsert('alice', 'primary-password', 'mail-alice.db', { iterations: 1 });
  const phone = reg.addAppPassword('alice', 'phone', 1000, { iterations: 1 });
  const cat = new MemoryCatalog();
  // The exact closure the daemon uses (main.ts): auth against the registry, so app passwords are
  // accepted with no change to the IMAP server itself.
  const server = await ImapServer.start(cat, { authenticate: (u, p) => reg.verifyPassword(u, p) });

  const login = async (user: string, pass: string): Promise<boolean> => {
    const c = connect(server.port);
    try {
      await new Promise<void>((r) => c.sock.once('connect', () => r()));
      return /^x OK/m.test(await c.run(`x LOGIN ${user} ${pass}\r\n`, 'x'));
    } finally {
      c.sock.destroy();
    }
  };

  try {
    assert.equal(await login('alice', phone), true, 'the app password logs in');
    assert.equal(await login('alice', 'primary-password'), true, 'the primary still logs in');
    assert.equal(await login('alice', 'not-the-secret'), false, 'a wrong secret is refused');

    // Revoke it while the server runs — the next attempt fails (the daemon reads per attempt).
    assert.equal(reg.removeAppPassword('alice', 'phone'), true);
    assert.equal(await login('alice', phone), false, 'the revoked app password no longer logs in');
    assert.equal(await login('alice', 'primary-password'), true, 'the primary is unaffected by revocation');
  } finally {
    await server.close();
  }
});
