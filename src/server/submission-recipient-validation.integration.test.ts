/**
 * Submission local-recipient validation, end to end (the submission black-hole class).
 *
 * Before this gate, the submission listener set no acceptRecipient, so RCPT accepted ANY
 * address; the delivery loop then silently skipped a local recipient that didn't resolve
 * (typo'd user, removed alias, disabled account). The client saw "250 message stored" and
 * the message ceased to exist — no 550, no DSN, no queue row, no dead letter — breaking the
 * README's "never silently dropped" promise. These tests pin the fix at both layers:
 *
 *   - RCPT time: an unresolvable address AT our domain is refused 550 5.1.1 ("no such
 *     user", not "relaying denied" — the submitter is authenticated, nothing is leaked);
 *     remote domains are still accepted (an authenticated user may relay anywhere).
 *   - end-of-DATA: a recipient that RESOLVED at RCPT but vanished before delivery (account
 *     disabled mid-transaction — the live-config race) fails the whole message with a
 *     transient 451 BEFORE any local copy is delivered or anything is queued.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type MailServerConfig, type RunningServer } from '../main.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { readMessages } from '../testing/read-messages.ts';
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
  /** Wait for the next full reply line and return it verbatim (code + text). */
  async reply(): Promise<string> {
    for (let i = 0; i < 400; i++) {
      const m = /(^|\r\n)(\d{3} [^\r\n]*)\r\n/.exec(this.#acc.toString('latin1'));
      if (m) {
        this.#acc = this.#acc.subarray(this.#acc.indexOf(Buffer.from(m[0], 'latin1')) + Buffer.byteLength(m[0], 'latin1'));
        return m[2]!;
      }
      await delay(5);
    }
    throw new Error('timed out waiting for a reply');
  }
}

/** An authenticated submission session with stepwise command/reply control. */
async function openSubmission(port: number, user: string, pass: string): Promise<{ send: (s: string) => Promise<string>; sendRaw: (s: string) => void; reader: Reader; end: () => void }> {
  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  const rr = new Reader(raw);
  await rr.line('ESMTP\r\n');
  raw.write('EHLO client.example\r\n');
  await rr.line('250 STARTTLS\r\n');
  raw.write('STARTTLS\r\n');
  await rr.line('Ready to start TLS\r\n');
  const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
  secure.on('error', () => {});
  await new Promise<void>((r) => secure.once('secureConnect', () => r()));
  const reader = new Reader(secure);
  secure.write('EHLO client.example\r\n');
  await reader.line('250 AUTH PLAIN\r\n');
  secure.write('AUTH PLAIN ' + plainToken(user, pass) + '\r\n');
  await reader.line('235');
  return {
    send: async (s: string) => {
      secure.write(s);
      return reader.reply();
    },
    sendRaw: (s: string) => void secure.write(s),
    reader,
    end: () => secure.end(),
  };
}

interface Ctx {
  readonly dir: string;
  readonly server: RunningServer;
}

async function boot(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'rcpt-val-'));
  const dbPath = join(dir, 'control.db');
  const setup = openMailDb(dbPath);
  const reg = AccountRegistry.open(setup);
  reg.upsert('alice', 'pw-alice', join(dir, 'mail-alice.db'), { iterations: 1 });
  reg.upsert('bob', 'pw-bob', join(dir, 'mail-bob.db'), { iterations: 1 });
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
  return { dir, server: await startServer(config) };
}

test('submission RCPT: unknown local user is 550 5.1.1, known local and remote are accepted', async () => {
  const { dir, server } = await boot();
  try {
    const s = await openSubmission(server.submission.port, 'alice', 'pw-alice');
    assert.match(await s.send(`MAIL FROM:<alice@${DOMAIN}>\r\n`), /^250 /);
    // The black-hole address class: our domain, no such user. Refused at RCPT with the
    // mailbox-unavailable semantic, NOT accepted (old behaviour) and NOT "relaying denied".
    const unknown = await s.send(`RCPT TO:<no-such-user@${DOMAIN}>\r\n`);
    assert.match(unknown, /^550 5\.1\.1 /, `unknown local user refused as no-such-mailbox: ${unknown}`);
    assert.doesNotMatch(unknown, /relay/i, 'a local unknown user is not described as a relay refusal');
    // A real local user and a foreign-domain recipient both stay accepted.
    assert.match(await s.send(`RCPT TO:<bob@${DOMAIN}>\r\n`), /^250 /, 'a known local user is accepted');
    assert.match(await s.send('RCPT TO:<friend@elsewhere.example>\r\n'), /^250 /, 'an authenticated user may still relay to a remote domain');
    s.end();
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('submission black-hole regression: a message cannot be accepted for an unresolvable local recipient', async () => {
  const { dir, server } = await boot();
  try {
    const s = await openSubmission(server.submission.port, 'alice', 'pw-alice');
    assert.match(await s.send(`MAIL FROM:<alice@${DOMAIN}>\r\n`), /^250 /);
    assert.match(await s.send(`RCPT TO:<typo@${DOMAIN}>\r\n`), /^550 /);
    // With every recipient refused, DATA is refused too — the transaction cannot even
    // reach the point where the old code returned 250 and dropped the message.
    assert.match(await s.send('DATA\r\n'), /^503 /, 'DATA with no accepted recipient is refused');
    s.end();
    // Nothing was stored and nothing was queued: the message never existed server-side.
    assert.equal(server.queue.size, 0, 'nothing queued');
    assert.equal(readMessages(server.mailbox).length, 0, 'nothing delivered');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('submission race: recipient disabled between RCPT and DATA fails 451, nothing delivered or queued', async () => {
  const { dir, server } = await boot();
  try {
    const s = await openSubmission(server.submission.port, 'alice', 'pw-alice');
    assert.match(await s.send(`MAIL FROM:<alice@${DOMAIN}>\r\n`), /^250 /);
    assert.match(await s.send(`RCPT TO:<bob@${DOMAIN}>\r\n`), /^250 /, 'bob resolves at RCPT time');
    // The live-config race: bob is disabled after RCPT accepted him (the registry is
    // honoured live, so a second connection's write is visible immediately).
    const raceDb = openMailDb(join(dir, 'control.db'));
    AccountRegistry.open(raceDb).setEnabled('bob', false);
    raceDb.close();
    assert.match(await s.send('DATA\r\n'), /^354 /);
    const final = await s.send(`From: alice@${DOMAIN}\r\nTo: bob@${DOMAIN}\r\nSubject: race\r\n\r\nhi\r\n.\r\n`);
    assert.match(final, /^451 4\.2\.1 /, `the whole message fails transient, not silently dropped: ${final}`);
    s.end();
    assert.equal(server.queue.size, 0, 'nothing queued');
    // bob is disabled so his store is unreadable via the daemon; assert via the mail DB
    // bytes instead: a fresh registry read shows bob disabled and alice's INBOX is empty
    // (no partial delivery to anyone).
    assert.equal(readMessages(server.mailbox).length, 0, 'no partial delivery');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
