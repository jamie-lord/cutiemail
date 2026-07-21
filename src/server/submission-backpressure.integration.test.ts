/**
 * Outbound-queue backpressure. The relay drains serially (~11/s on a
 * small VM); without a bound, an authenticated account submitting faster grows the queue — and,
 * since each row holds the whole signed body, the disk — without limit. Submission now returns a
 * transient 451 once the queue is at capacity, so a well-behaved sender retries and no mail is lost
 * and no disk is exhausted. This drives the real daemon: fill the queue (relay pointed at a dead
 * port so nothing drains), then the next outbound message must be refused 451 — while LOCAL
 * delivery, which needs no queue, keeps working.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { startServer, type MailServerConfig } from '../main.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const token = (u: string, p: string): string => Buffer.from(`\0${u}\0${p}`, 'latin1').toString('base64');

function reader(sock: NodeJS.ReadableStream): (needle: string) => Promise<string> {
  let acc = '';
  sock.on('data', (d: Buffer) => (acc += d.toString('latin1')));
  return (needle) =>
    new Promise((resolve, reject) => {
      const t = setInterval(() => {
        const at = acc.indexOf(needle);
        if (at !== -1) {
          clearInterval(t);
          const line = acc.slice(0, at + needle.length);
          acc = acc.slice(at + needle.length);
          resolve(line);
        }
      }, 3);
      setTimeout(() => {
        clearInterval(t);
        reject(new Error(`timeout "${needle}": ${acc.slice(-80)}`));
      }, 8000);
    });
}

/** Submit one message over STARTTLS+AUTH and return the reply code to the end-of-DATA. */
async function submit(port: number, from: string, to: string): Promise<string> {
  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  const rr = reader(raw);
  await rr('ESMTP\r\n');
  raw.write(Buffer.from('EHLO t\r\n', 'latin1'));
  await rr('250 STARTTLS\r\n');
  raw.write(Buffer.from('STARTTLS\r\n', 'latin1'));
  await rr('TLS\r\n');
  const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
  secure.on('error', () => {});
  await new Promise<void>((r) => secure.once('secureConnect', () => r()));
  const sr = reader(secure);
  secure.write(Buffer.from('EHLO t\r\n', 'latin1'));
  await sr('250 AUTH PLAIN\r\n');
  secure.write(Buffer.from('AUTH PLAIN ' + token('alice', 'pw') + '\r\n', 'latin1'));
  await sr('235');
  secure.write(Buffer.from(`MAIL FROM:<${from}>\r\n`, 'latin1'));
  await sr('250 ');
  secure.write(Buffer.from(`RCPT TO:<${to}>\r\n`, 'latin1'));
  await sr('250 ');
  secure.write(Buffer.from('DATA\r\n', 'latin1'));
  await sr('354');
  await sr('\r\n'); // consume the rest of the 354 line so it isn't mistaken for the reply
  secure.write(Buffer.from(`From: alice@sender.example\r\nTo: ${to}\r\nSubject: x\r\n\r\nbody\r\n.\r\n`, 'latin1'));
  const reply = await sr('\r\n');
  secure.end();
  return reply.trim().slice(0, 3);
}

test('submission returns 451 when the outbound queue is at capacity, but still delivers locally', async () => {
  // A dead port: open then immediately close, so relay attempts fail transiently and entries stay.
  const deadPort = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

  const cfg: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'sender.example',
    accounts: [{ user: 'alice', pass: 'pw', mailDbPath: ':memory:' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    outbound: { resolveHosts: async () => ['127.0.0.1'], port: deadPort },
    relayIntervalMs: 1_000_000, // don't let the timer interfere; entries stay put
    maxQueueDepth: 3,
  };
  const server = await startServer(cfg);
  try {
    // Three remote messages fill the queue to the cap (nothing drains — relay target is dead).
    for (let i = 0; i < 3; i++) {
      assert.equal(await submit(server.submission.port, 'alice@sender.example', `dest${i}@remote.example`), '250', `msg ${i} queued`);
    }
    assert.ok(server.queue.size >= 3, `queue filled (size ${server.queue.size})`);

    // The fourth remote message is refused with a transient 451 — not lost, the sender retries.
    assert.equal(await submit(server.submission.port, 'alice@sender.example', 'dest9@remote.example'), '451', 'over-cap outbound is 451');

    // But a LOCAL message needs no queue, so it is still accepted even with the queue full.
    assert.equal(await submit(server.submission.port, 'alice@sender.example', 'alice@sender.example'), '250', 'local delivery unaffected by a full outbound queue');
  } finally {
    await server.close();
  }
});
