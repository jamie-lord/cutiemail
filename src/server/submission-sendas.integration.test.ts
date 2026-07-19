/**
 * Submission sender-authorization end to end (ADR 0015). An authenticated user may send only
 * AS an address they own — their login, an alias, or a `base+tag` subaddress — on our domain.
 *
 * This is a SECURITY test. Before this gate, submission never checked From against the
 * authenticated user, so any authenticated account could put ANY address in From — including
 * another account's (the cross-account spoof). The negative cases below all previously
 * returned "250 message stored"; they must now return a permanent 550. The positive cases
 * prove legitimate send-as (the whole point of aliases) still works.
 *
 * The recipient is a LOCAL account, so the transaction exercises the authorization guard with
 * no DNS or outbound relay — fully hermetic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type MailServerConfig } from '../main.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const DOMAIN = 'mail.example.test';
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const plainToken = (u: string, p: string): string => Buffer.from(`\0${u}\0${p}`, 'latin1').toString('base64');

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
  /** Wait for the next full 3-digit reply line and return its code. */
  async replyCode(): Promise<string> {
    for (let i = 0; i < 400; i++) {
      const m = /(^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(this.#acc.toString('latin1'));
      if (m) {
        this.#acc = this.#acc.subarray(this.#acc.indexOf(Buffer.from(m[0], 'latin1')) + Buffer.byteLength(m[0], 'latin1'));
        return m[2]!;
      }
      await delay(5);
    }
    throw new Error('timed out waiting for a reply code');
  }
}

/** Authenticate as `authUser` over STARTTLS, then run one transaction with the given envelope
 *  MAIL FROM and DATA payload; resolve with the reply CODE to the terminating dot (250/550…). */
async function submit(
  port: number,
  authUser: string,
  authPass: string,
  mailFrom: string,
  rcpt: string,
  data: string,
): Promise<string> {
  const raw = net.connect(port, '127.0.0.1');
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
  secure.write('AUTH PLAIN ' + plainToken(authUser, authPass) + '\r\n');
  await sr.line('235');
  secure.write(`MAIL FROM:<${mailFrom}>\r\n`);
  await sr.replyCode();
  secure.write(`RCPT TO:<${rcpt}>\r\n`);
  await sr.replyCode();
  secure.write('DATA\r\n');
  await sr.line('354');
  // `data` already uses CRLF and ends with a CRLF — append only the dot terminator.
  secure.write(data + '.\r\n');
  const code = await sr.replyCode();
  secure.end();
  return code;
}

test('submission sender-authorization: owned senders accepted, spoofs rejected 550', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sendas-'));
  try {
    // alice (with alias sales→alice) and bob, provisioned in the registry.
    const dbPath = join(dir, 'control.db');
    const setup = openMailDb(dbPath);
    const reg = AccountRegistry.open(setup);
    reg.upsert('alice', 'pw-alice', join(dir, 'mail-alice.db'), { iterations: 1 });
    reg.upsert('bob', 'pw-bob', join(dir, 'mail-bob.db'), { iterations: 1 });
    reg.addAlias('sales', 'alice');
    setup.close();

    const config: MailServerConfig = {
      dbPath,
      host: '127.0.0.1',
      smtpPort: 0,
      submissionPort: 0,
      imapPort: 0,
      domain: DOMAIN,
      accounts: [],
      tls: { key: TEST_KEY, cert: TEST_CERT },
    };
    const server = await startServer(config);
    const port = server.submission.port;
    // Deliver to a local mailbox (bob) so no relay/DNS is needed.
    const rcpt = `bob@${DOMAIN}`;
    const body = (from: string, extra = ''): string => `From: ${from}\r\n${extra}To: ${rcpt}\r\nSubject: t\r\n\r\nhi\r\n`;

    try {
      // --- Authorized: the login itself, an alias, a subaddress. ---
      assert.equal(
        await submit(port, 'alice', 'pw-alice', `alice@${DOMAIN}`, rcpt, body(`alice@${DOMAIN}`)),
        '250', 'sending as your own login is accepted');
      assert.equal(
        await submit(port, 'alice', 'pw-alice', `alice@${DOMAIN}`, rcpt, body(`Sales Team <sales@${DOMAIN}>`)),
        '250', 'sending as an alias you own is accepted (with a display name)');
      assert.equal(
        await submit(port, 'alice', 'pw-alice', `sales@${DOMAIN}`, rcpt, body(`sales@${DOMAIN}`)),
        '250', 'the envelope may be the alias too');
      assert.equal(
        await submit(port, 'alice', 'pw-alice', `alice@${DOMAIN}`, rcpt, body(`alice+newsletter@${DOMAIN}`)),
        '250', 'a +tag subaddress of your login is accepted');

      // --- Rejected: the spoofs that were silently accepted before ADR 0015. ---
      assert.equal(
        await submit(port, 'alice', 'pw-alice', `alice@${DOMAIN}`, rcpt, body(`bob@${DOMAIN}`)),
        '550', 'CROSS-ACCOUNT SPOOF: alice may not send as bob');
      assert.equal(
        await submit(port, 'alice', 'pw-alice', `alice@${DOMAIN}`, rcpt, body(`ceo@evil.com`)),
        '550', 'a foreign-domain From is rejected');
      assert.equal(
        await submit(port, 'alice', 'pw-alice', `bob@${DOMAIN}`, rcpt, body(`alice@${DOMAIN}`)),
        '550', 'the ENVELOPE sender must be owned too (bob is not alice)');
      assert.equal(
        await submit(port, 'alice', 'pw-alice', `alice@${DOMAIN}`, rcpt,
          `From: alice@${DOMAIN}\r\nFrom: bob@${DOMAIN}\r\nTo: ${rcpt}\r\n\r\nhi\r\n`),
        '550', 'two From headers (the display-spoof vector) are rejected');
      assert.equal(
        await submit(port, 'alice', 'pw-alice', `alice@${DOMAIN}`, rcpt,
          `From: "alice <alice@${DOMAIN}>" <bob@${DOMAIN}>\r\nTo: ${rcpt}\r\n\r\nhi\r\n`),
        '550', 'the display-name decoy is judged by the shown address (bob), and rejected');
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
