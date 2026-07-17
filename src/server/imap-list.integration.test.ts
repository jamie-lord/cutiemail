/**
 * LIST wildcard matching (RFC 9051 §6.3.9 / §7.3.1). A client walks the mailbox
 * hierarchy with patterns — `%` for one level, `*` across levels, a literal prefix to
 * scope it. Dovecot's imaptest surfaced that the server only handled a bare `*`/`%`
 * and treated every other pattern as an exact name, so `INBOX/%`, `parent*`, and the
 * like matched nothing — hierarchical folder discovery in a real client would return
 * an empty tree. This pins the wildcard semantics and the \HasChildren attribute.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

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
  get seen(): string {
    return this.#acc.toString('latin1');
  }
  async run(tag: string, command: string): Promise<string[]> {
    const before = this.#acc.length;
    this.send(`${command}\r\n`);
    for (let i = 0; i < 400; i++) {
      const fresh = this.#acc.subarray(before).toString('latin1');
      if (fresh.split('\r\n').some((l) => l.startsWith(`${tag} `))) {
        return fresh.split('\r\n').filter((l) => l.startsWith('*'));
      }
      await delay(5);
    }
    throw new Error(`timed out on ${command}`);
  }
}

/** The names a `* LIST (...) "/" name` set of untagged replies refers to. */
function listedNames(rows: string[]): string[] {
  return rows
    .filter((r) => r.startsWith('* LIST'))
    .map((r) => r.replace(/^\* LIST \([^)]*\) "\/" /, '').replace(/^"|"$/g, ''));
}

async function openServer(): Promise<{ server: Awaited<ReturnType<typeof ImapServer.start>>; s: Session }> {
  const catalog = new MemoryCatalog();
  for (const name of ['Sent', 'Drafts']) catalog.create(name);
  const server = await ImapServer.start(catalog, { authenticate: () => true });
  const s = new Session(net.connect(server.port, '127.0.0.1'));
  await new Promise<void>((r) => setTimeout(r, 30));
  await s.run('a1', 'a1 LOGIN u p');
  // Build a small hierarchy: parent, parent/a, parent/b, parent/a/deep.
  for (const n of ['parent', 'parent/a', 'parent/b', 'parent/a/deep']) await s.run('c', `c CREATE ${n}`);
  return { server, s };
}

test('LIST "" * matches across the hierarchy separator', async () => {
  const { server, s } = await openServer();
  try {
    const names = listedNames(await s.run('t', 't LIST "" parent*'));
    assert.deepEqual(new Set(names), new Set(['parent', 'parent/a', 'parent/b', 'parent/a/deep']));
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('LIST "" % and a prefixed % stay within one hierarchy level', async () => {
  const { server, s } = await openServer();
  try {
    const top = listedNames(await s.run('t', 't LIST "" %'));
    assert.ok(top.includes('parent') && top.includes('INBOX') && top.includes('Sent'), 'top level present');
    assert.ok(!top.some((n) => n.includes('/')), `% must not cross the separator: ${top}`);

    const under = listedNames(await s.run('u', 'u LIST "" parent/%'));
    assert.deepEqual(new Set(under), new Set(['parent/a', 'parent/b']), 'parent/% is exactly the direct children');
    assert.ok(!under.includes('parent/a/deep'), '% does not reach grandchildren');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('LIST reports \\HasChildren for a parent and \\HasNoChildren for a leaf', async () => {
  const { server, s } = await openServer();
  try {
    const rows = await s.run('t', 't LIST "" parent*');
    const parentRow = rows.find((r) => r.endsWith('"/" parent')) ?? '';
    const leafRow = rows.find((r) => r.endsWith('"/" parent/b')) ?? '';
    assert.match(parentRow, /\\HasChildren/, 'parent has children');
    assert.doesNotMatch(parentRow, /\\HasNoChildren/);
    assert.match(leafRow, /\\HasNoChildren/, 'parent/b is a leaf');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('a literal LIST pattern matches exactly one mailbox', async () => {
  const { server, s } = await openServer();
  try {
    assert.deepEqual(listedNames(await s.run('t', 't LIST "" parent/a')), ['parent/a']);
    assert.deepEqual(listedNames(await s.run('u', 'u LIST "" nonexistent')), []);
  } finally {
    s.sock.destroy();
    await server.close();
  }
});
