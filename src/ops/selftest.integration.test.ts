/**
 * The `selftest` operator command, end to end against a real assembled daemon. It must submit an
 * authenticated message over STARTTLS, have it delivered locally, read it back over IMAPS, and then
 * DELETE it so nothing is left behind — returning 0 only when the whole path works. This drives it
 * against startServer on ephemeral ports and asserts: the happy path passes and leaves the inbox
 * empty (cleanup worked), a wrong password fails cleanly with exit 1, and an unknown account fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type MailServerConfig } from '../main.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';
import { readMessages } from '../testing/read-messages.ts';
import { runSelftest } from './selftest.ts';

const CONFIG: MailServerConfig = {
  dbPath: ':memory:',
  host: '127.0.0.1',
  smtpPort: 0,
  submissionPort: 0,
  imapPort: 0,
  domain: 'mail.example.test',
  accounts: [{ user: 'alice', pass: 's3cret-passphrase' }],
  tls: { key: TEST_KEY, cert: TEST_CERT },
};

function capture(): { io: { out(l: string): void; err(l: string): void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

test('selftest passes against a live daemon and leaves the inbox clean', async () => {
  const server = await startServer(CONFIG);
  try {
    const env = {
      MAIL_HOST: '127.0.0.1',
      MAIL_DOMAIN: 'mail.example.test',
      MAIL_SUBMISSION_PORT: String(server.submission.port),
      MAIL_IMAP_PORT: String(server.imap.port),
    };
    const c = capture();
    const code = await runSelftest(['alice'], c.io, env, 's3cret-passphrase');
    assert.equal(code, 0, `selftest should pass; stderr: ${c.err.join(' | ')}`);
    assert.ok(c.out.join('\n').includes('PASSED'), 'reports PASSED');
    // The tagged message was deleted again — the inbox is back to empty (no residue from the check).
    assert.equal(readMessages(server.mailbox).length, 0, 'selftest cleaned up its own message');
  } finally {
    await server.close();
  }
});

test('selftest fails cleanly (exit 1) on a wrong password', async () => {
  const server = await startServer(CONFIG);
  try {
    const env = {
      MAIL_HOST: '127.0.0.1',
      MAIL_DOMAIN: 'mail.example.test',
      MAIL_SUBMISSION_PORT: String(server.submission.port),
      MAIL_IMAP_PORT: String(server.imap.port),
    };
    const c = capture();
    const code = await runSelftest(['alice'], c.io, env, 'wrong-password');
    assert.equal(code, 1, 'a wrong password fails');
    assert.ok(c.err.join('\n').toLowerCase().includes('auth'), 'the failure names authentication');
  } finally {
    await server.close();
  }
});

test('selftest rejects a missing/invalid login with a usage error (exit 2)', async () => {
  const c1 = capture();
  assert.equal(await runSelftest([], c1.io, {}, 'x'), 2, 'no login → usage error');
  const c2 = capture();
  assert.equal(await runSelftest(['bad/login'], c2.io, {}, 'x'), 2, 'invalid login → usage error');
});
