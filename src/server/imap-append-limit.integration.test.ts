/**
 * The APPEND literal cap follows the configured message-size limit (UX pressure test:
 * MAX_APPEND_LITERAL was a hardcoded 25 MiB while MAIL_MAX_SIZE made the SMTP side
 * configurable — so an operator who raised the limit for an imapsync migration of large
 * legacy messages hit an invisible second ceiling on the IMAP import path).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class C {
  #acc = '';
  readonly sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (d) => (this.#acc += d.toString('latin1')));
    sock.on('error', () => {});
  }
  send(s: string): void {
    this.sock.write(Buffer.from(s, 'latin1'));
  }
  async until(re: RegExp): Promise<string> {
    for (let i = 0; i < 400; i++) {
      if (re.test(this.#acc)) {
        const seg = this.#acc;
        this.#acc = '';
        return seg;
      }
      await delay(5);
    }
    throw new Error(`timed out on ${re}: ${this.#acc}`);
  }
}

test('a configured maxAppendLiteral is enforced, and a literal under it still works', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: () => true, maxAppendLiteral: 1024 });
  const c = new C(net.connect(server.port, '127.0.0.1'));
  try {
    await c.until(/\* OK/);
    c.send('a1 LOGIN u p\r\n');
    await c.until(/^a1 OK/m);
    // Over the configured cap: refused up front with the limit named.
    c.send('a2 APPEND INBOX {2048}\r\n');
    const refused = await c.until(/^a2 (OK|NO|BAD)/m);
    assert.match(refused, /^a2 NO \[LIMIT\]/m, `an over-cap literal is refused: ${refused}`);
    assert.match(refused, /1024-octet/, 'the refusal names the configured cap, not the default');
    // Under the cap: accepted (the cap is a limit, not a breakage).
    const msg = 'Subject: small\r\n\r\nfits\r\n';
    c.send(`a3 APPEND INBOX {${Buffer.byteLength(msg)}}\r\n`);
    await c.until(/\+ Ready/);
    c.send(`${msg}\r\n`);
    const ok = await c.until(/^a3 (OK|NO|BAD)/m);
    assert.match(ok, /^a3 OK/m, `an under-cap literal appends: ${ok}`);
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test('the default cap (25 MiB) still applies when none is configured', async () => {
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const c = new C(net.connect(server.port, '127.0.0.1'));
  try {
    await c.until(/\* OK/);
    c.send('a1 LOGIN u p\r\n');
    await c.until(/^a1 OK/m);
    c.send(`a2 APPEND INBOX {${26_214_401}}\r\n`);
    const refused = await c.until(/^a2 (OK|NO|BAD)/m);
    assert.match(refused, /^a2 NO \[LIMIT\]/m);
    assert.match(refused, /26214400-octet/, 'the default cap is unchanged');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});
