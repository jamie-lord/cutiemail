/**
 * The brute-force auth throttle wired into the live daemon: after enough failed logins
 * from one IP, further attempts on BOTH the IMAP and submission auth paths are refused
 * without checking the password — even a CORRECT password — until the window drains. The
 * "even a correct password is refused while blocked" assertion is the load-bearing control:
 * it proves the refusal is the throttle, not just wrong credentials.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { startServer } from '../main.ts';
import type { MailServerConfig } from '../main.ts';
import { AuthThrottle } from './auth-throttle.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const PW = 'correct horse battery staple';

function config(throttle: AuthThrottle): MailServerConfig {
  return {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [{ user: 'alice', pass: PW }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    authThrottle: throttle,
  };
}

/** Open an implicit-TLS line connection, returning read/write helpers. */
async function tlsConn(port: number): Promise<{ send: (s: string) => void; until: (re: RegExp) => Promise<string>; end: () => void }> {
  const sock = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
  let buf = '';
  await new Promise<void>((res, rej) => {
    sock.once('secureConnect', res);
    sock.once('error', rej);
  });
  sock.setEncoding('utf8');
  sock.on('data', (d: string) => (buf += d));
  const until = (re: RegExp): Promise<string> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        if (re.test(buf)) return resolve(buf);
        setTimeout(check, 10);
      };
      setTimeout(() => reject(new Error(`timeout waiting for ${re}; got: ${buf}`)), 3000);
      check();
    });
  return { send: (s) => sock.write(s), until, end: () => sock.end() };
}

const b64Plain = (u: string, p: string): string => Buffer.from(`\0${u}\0${p}`, 'latin1').toString('base64');

/** Line helpers over an arbitrary socket (plaintext or a TLS upgrade of it). */
function lines(sock: net.Socket | tls.TLSSocket): { send: (s: string) => void; until: (re: RegExp) => Promise<string>; reset: () => void; raw: net.Socket | tls.TLSSocket } {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d: string) => (buf += d));
  return {
    send: (s) => sock.write(s),
    reset: () => (buf = ''),
    raw: sock,
    until: (re) =>
      new Promise((resolve, reject) => {
        const check = (): void => {
          if (re.test(buf)) return resolve(buf);
          setTimeout(check, 10);
        };
        setTimeout(() => reject(new Error(`timeout waiting for ${re}; got: ${buf}`)), 3000);
        check();
      }),
  };
}

/** Connect to the submission port and complete EHLO → STARTTLS → EHLO, returning the TLS line helper. */
async function submissionTls(port: number): Promise<ReturnType<typeof lines>> {
  const raw = net.connect({ port, host: '127.0.0.1' });
  await new Promise<void>((res, rej) => {
    raw.once('connect', res);
    raw.once('error', rej);
  });
  const plain = lines(raw);
  await plain.until(/^220 /m);
  plain.send('EHLO tester\r\n');
  await plain.until(/250 .*\r\n(?![0-9])/);
  plain.reset();
  plain.send('STARTTLS\r\n');
  await plain.until(/^220 /m);
  raw.removeAllListeners('data');
  const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
  await new Promise<void>((res, rej) => {
    secure.once('secureConnect', res);
    secure.once('error', rej);
  });
  const tlsLines = lines(secure);
  tlsLines.send('EHLO tester\r\n');
  await tlsLines.until(/250 .*\r\n(?![0-9])/);
  tlsLines.reset();
  return tlsLines;
}

test('IMAP: after the failure threshold, even the CORRECT password is refused with [UNAVAILABLE]', async () => {
  const throttle = new AuthThrottle({ maxFailures: 3, now: () => 1000 }); // frozen clock → window never drains mid-test
  const server = await startServer(config(throttle));
  try {
    const port = server.imap.port;
    // Three failed logins from this IP (loopback) reach the threshold.
    for (let i = 0; i < 3; i++) {
      const c = await tlsConn(port);
      await c.until(/\* OK/);
      c.send('a LOGIN alice wrongpass\r\n');
      await c.until(/a NO \[AUTHENTICATIONFAILED\]/);
      c.end();
    }
    // Now blocked: a correct-password login is refused without checking it.
    const c = await tlsConn(port);
    await c.until(/\* OK/);
    c.send(`a LOGIN alice "${PW}"\r\n`);
    const resp = await c.until(/a (OK|NO)/);
    assert.match(resp, /a NO \[UNAVAILABLE\]/, 'a correct password must be refused while the IP is blocked');
    assert.doesNotMatch(resp, /a OK/);
    c.end();
  } finally {
    await server.close();
  }
});

test('IMAP: a success does NOT reset the throttle — brute force cannot be laundered through a login', async () => {
  // The security fix (audit run-1, finding 2): a success prunes only EXPIRED failures.
  // If a success wiped recent ones, an attacker holding one valid credential could reset
  // the guessing budget against other accounts. Here maxFailures=3 at a fixed clock:
  // 2 failures + a success (keeps both) + 1 failure = 3 → blocked, so even the correct
  // password is then refused. Under the old delete()-on-success this final login was OK.
  const throttle = new AuthThrottle({ maxFailures: 3, now: () => 1000 });
  const server = await startServer(config(throttle));
  try {
    const port = server.imap.port;
    // Two failures (below threshold)…
    for (let i = 0; i < 2; i++) {
      const c = await tlsConn(port);
      await c.until(/\* OK/);
      c.send('a LOGIN alice wrongpass\r\n');
      await c.until(/a NO/);
      c.end();
    }
    // …then a success (which must NOT clear the two recent failures)…
    const ok = await tlsConn(port);
    await ok.until(/\* OK/);
    ok.send(`a LOGIN alice "${PW}"\r\n`);
    await ok.until(/a OK/);
    ok.end();
    // …then one more failure reaches the threshold (2 kept + 1 = 3) → the IP is blocked.
    const third = await tlsConn(port);
    await third.until(/\* OK/);
    third.send('a LOGIN alice wrongpass\r\n');
    await third.until(/a NO/);
    third.end();
    // A subsequent attempt with the CORRECT password is refused — the budget was not reset.
    const c = await tlsConn(port);
    await c.until(/\* OK/);
    c.send(`a LOGIN alice "${PW}"\r\n`);
    assert.match(await c.until(/a (OK|NO)/), /a NO/, 'the success did not reset the budget; the IP is blocked');
    c.end();
  } finally {
    await server.close();
  }
});

test('submission: after the threshold, AUTH is refused with a transient 454 (even a correct password)', async () => {
  const throttle = new AuthThrottle({ maxFailures: 3, now: () => 1000 });
  const server = await startServer(config(throttle));
  try {
    const port = server.submission.port;
    for (let i = 0; i < 3; i++) {
      const c = await submissionTls(port);
      c.send(`AUTH PLAIN ${b64Plain('alice', 'wrongpass')}\r\n`);
      await c.until(/535 /);
      c.raw.end();
    }
    const c = await submissionTls(port);
    c.send(`AUTH PLAIN ${b64Plain('alice', PW)}\r\n`);
    assert.match(await c.until(/(235|454|535) /), /454 /, 'a correct password is refused with 454 while blocked');
    c.raw.end();
  } finally {
    await server.close();
  }
});
