/**
 * SPECIAL-USE (RFC 6154). A client discovers where Sent/Drafts/Trash/Junk/Archive
 * live from the attributes the server puts on LIST, and files mail there instead of
 * inventing "Sent Items"/"Deleted Messages" duplicates. That only works if the server
 * advertises the SPECIAL-USE capability, tags the folders in LIST, and honours the
 * (SPECIAL-USE) selection option that asks for just those folders.
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
  async waitFor(needle: string): Promise<string> {
    for (let i = 0; i < 400; i++) {
      if (this.seen.includes(needle)) return this.seen;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)} in ${JSON.stringify(this.seen)}`);
  }
}

/** A catalog with the conventional special-use folders provisioned, as the daemon does. */
function seededCatalog(): MemoryCatalog {
  const catalog = new MemoryCatalog();
  for (const name of ['Sent', 'Drafts', 'Trash', 'Junk', 'Archive']) catalog.create(name);
  return catalog;
}

test('CAPABILITY advertises SPECIAL-USE', async () => {
  const server = await ImapServer.start(new MemoryCatalog(), { authenticate: () => true });
  const s = new Session(net.connect(server.port, '127.0.0.1'));
  try {
    await s.waitFor('* OK');
    s.send('a1 CAPABILITY\r\n');
    const resp = await s.waitFor('a1 OK');
    assert.match(resp, /SPECIAL-USE/, 'the SPECIAL-USE capability is advertised');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('LIST tags each special-use folder with its RFC 6154 attribute', async () => {
  const server = await ImapServer.start(seededCatalog(), { authenticate: () => true });
  const s = new Session(net.connect(server.port, '127.0.0.1'));
  try {
    await s.waitFor('* OK');
    s.send('a1 LOGIN u p\r\na2 LIST "" *\r\n');
    const resp = await s.waitFor('a2 OK');
    assert.match(resp, /\* LIST \([^)]*\\Sent[^)]*\) "\/" Sent/, 'Sent carries \\Sent');
    assert.match(resp, /\* LIST \([^)]*\\Drafts[^)]*\) "\/" Drafts/, 'Drafts carries \\Drafts');
    assert.match(resp, /\* LIST \([^)]*\\Trash[^)]*\) "\/" Trash/, 'Trash carries \\Trash');
    assert.match(resp, /\* LIST \([^)]*\\Junk[^)]*\) "\/" Junk/, 'Junk carries \\Junk');
    assert.match(resp, /\* LIST \([^)]*\\Archive[^)]*\) "\/" Archive/, 'Archive carries \\Archive');
    // INBOX has no special-use attribute.
    assert.match(resp, /\* LIST \(\\HasNoChildren\) "\/" INBOX/, 'INBOX is listed without a special-use attribute');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('LIST (SPECIAL-USE) returns only the special-use folders, not INBOX', async () => {
  const server = await ImapServer.start(seededCatalog(), { authenticate: () => true });
  const s = new Session(net.connect(server.port, '127.0.0.1'));
  try {
    await s.waitFor('* OK');
    s.send('a1 LOGIN u p\r\na2 LIST (SPECIAL-USE) "" *\r\n');
    const resp = await s.waitFor('a2 OK');
    const listed = resp.slice(resp.indexOf('a2 ') === -1 ? 0 : resp.indexOf('LIST'));
    assert.match(resp, /\* LIST \([^)]*\\Sent[^)]*\) "\/" Sent/, 'Sent is included');
    assert.match(resp, /\* LIST \([^)]*\\Trash[^)]*\) "\/" Trash/, 'Trash is included');
    // The filter excludes the non-special INBOX.
    assert.doesNotMatch(listed, /"\/" INBOX/, 'INBOX is filtered out by the (SPECIAL-USE) selection');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});
