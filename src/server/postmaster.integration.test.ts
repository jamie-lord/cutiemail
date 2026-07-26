/**
 * The reserved `postmaster` mailbox, on the wire (RFC 5321 §2.3.5, §4.5.1).
 *
 * §4.5.1: "The requirement to accept mail for postmaster implies that RCPT commands that specify a
 * mailbox for postmaster at any of the domains for which the SMTP server provides mail service, as
 * well as the special case of 'RCPT TO:<Postmaster>' (with no domain specification), MUST be
 * supported." Note the RFC's own spelling of that special case: capitalised, because the local name
 * is case-insensitive.
 *
 * Accepting it is only half the obligation — mail accepted and then dropped is worse than mail
 * refused — so each case here follows through to DATA and reads the message back out of the mailbox
 * it should have landed in.
 *
 * The submission side is here for a defect this fix uncovered rather than for the RFC: a forward-path
 * with no domain was classified as REMOTE, so an authenticated client could get an undeliverable
 * address queued for relay.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { startServer, type MailServerConfig, type RunningServer } from '../main.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';
import { readMessages } from '../testing/read-messages.ts';

const DOMAIN = 'postmaster.one.example';
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Session {
  #acc = '';
  readonly sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => (this.#acc += d.toString('latin1')));
    sock.on('error', () => {});
  }
  /** Send a line and return the reply that follows it. */
  async command(line: string): Promise<string> {
    this.#acc = '';
    this.sock.write(`${line}\r\n`, 'latin1');
    return this.reply();
  }
  async reply(): Promise<string> {
    for (let i = 0; i < 600; i++) {
      const m = /^\d{3} .*$/m.exec(this.#acc);
      if (m !== null) return m[0];
      await delay(5);
    }
    throw new Error(`timed out; saw ${JSON.stringify(this.#acc)}`);
  }
}

async function connectInbound(port: number): Promise<Session> {
  const sock = net.connect(port, '127.0.0.1');
  const session = new Session(sock);
  await session.reply(); // greeting
  await session.command('EHLO suite.one.example');
  return session;
}

/** An authenticated submission session: STARTTLS, then AUTH PLAIN. */
async function connectSubmission(port: number, user: string, pass: string): Promise<Session> {
  const raw = net.connect(port, '127.0.0.1');
  const plain = new Session(raw);
  await plain.reply();
  await plain.command('EHLO client.one.example');
  await plain.command('STARTTLS');
  const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
  secure.on('error', () => {});
  await new Promise<void>((r) => secure.once('secureConnect', () => r()));
  const session = new Session(secure);
  await session.command('EHLO client.one.example');
  const token = Buffer.from(`\0${user}\0${pass}`, 'latin1').toString('base64');
  const auth = await session.command(`AUTH PLAIN ${token}`);
  assert.ok(auth.startsWith('235'), `authentication failed: ${auth}`);
  return session;
}

/** Deliver one message and return the final reply. */
async function sendMessage(session: Session, from: string, rcpt: string, subject: string): Promise<string> {
  const mail = await session.command(`MAIL FROM:<${from}>`);
  assert.ok(mail.startsWith('250'), `MAIL FROM refused: ${mail}`);
  const accepted = await session.command(`RCPT TO:<${rcpt}>`);
  if (!accepted.startsWith('250')) return accepted;
  await session.command('DATA');
  return session.command(`From: <${from}>\r\nSubject: ${subject}\r\n\r\nbody\r\n.`);
}

async function withServer(fn: (server: RunningServer) => Promise<void>): Promise<void> {
  const cfg: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: DOMAIN,
    // `you` is created first, so it is the primary and therefore the postmaster floor.
    accounts: [
      { user: 'you', pass: 'a-real-passphrase' },
      { user: 'someone', pass: 'another-passphrase' },
    ],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    dkimKeyResolver: async () => null,
    spfResolvers: { txt: async () => [], a: async () => [], mx: async () => [] },
    outboundMode: 'hold',
  };
  const server = await startServer(cfg);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

test('every spelling of postmaster is accepted on the inbound port and delivered', async () => {
  await withServer(async (server) => {
    assert.equal(server.postmaster, 'you', 'the primary account carries the reserved mailbox');
    const inbox = server.stores.get('you')!.catalog.get('INBOX')!;

    const cases: ReadonlyArray<{ readonly rcpt: string; readonly why: string }> = [
      { rcpt: 'postmaster', why: '§2.3.5: the bare form MUST be accepted' },
      { rcpt: 'Postmaster', why: "§4.5.1 spells the special case 'RCPT TO:<Postmaster>' itself" },
      { rcpt: 'POSTMASTER', why: 'a case-insensitive local name is case-insensitive throughout' },
      { rcpt: `postmaster@${DOMAIN}`, why: '§4.5.1: postmaster at each served domain' },
      { rcpt: `PostMaster@${DOMAIN}`, why: 'and that form is case-insensitive too' },
    ];

    for (const { rcpt, why } of cases) {
      const session = await connectInbound(server.inbound.port);
      try {
        const stored = await sendMessage(session, 'someone@two.example', rcpt, `to ${rcpt}`);
        assert.ok(stored.startsWith('250'), `<${rcpt}> should be accepted — ${why} (got ${stored})`);
      } finally {
        session.sock.destroy();
      }
    }

    // Accepted is only half of it: mail accepted and then dropped is worse than mail refused.
    const subjects = readMessages(inbox).map((m) => /^Subject: (.*)$/m.exec(m.raw.toString('latin1'))?.[1]);
    for (const { rcpt } of cases) {
      assert.ok(subjects.includes(`to ${rcpt}`), `the message for <${rcpt}> reached the postmaster's mailbox`);
    }
    assert.equal(readMessages(server.stores.get('someone')!.catalog.get('INBOX')!).length, 0, 'and went to the primary, not to everyone');
  });
});

test('a domain-less recipient that is not postmaster is still refused', async () => {
  await withServer(async (server) => {
    const session = await connectInbound(server.inbound.port);
    try {
      await session.command('MAIL FROM:<someone@two.example>');
      // The reserved mailbox is the ONE exception RFC 5321 grants; nothing else may omit a domain.
      for (const rcpt of ['you', 'nobody', 'postmasterly', 'post master']) {
        const reply = await session.command(`RCPT TO:<${rcpt}>`);
        assert.ok(reply.startsWith('550'), `<${rcpt}> must still be refused, got ${reply}`);
      }
    } finally {
      session.sock.destroy();
    }
  });
});

test('the bare form works with the null return-path, which is how a bounce reaches postmaster', async () => {
  // §4.5.1 pairs the reserved mailbox with the null path: a notification that cannot itself bounce.
  await withServer(async (server) => {
    const session = await connectInbound(server.inbound.port);
    try {
      const mail = await session.command('MAIL FROM:<>');
      assert.ok(mail.startsWith('250'), `the null return-path must be accepted: ${mail}`);
      const rcpt = await session.command('RCPT TO:<postmaster>');
      assert.ok(rcpt.startsWith('250'), `bare postmaster with a null path: ${rcpt}`);
    } finally {
      session.sock.destroy();
    }
  });
});

test('submission delivers a bare postmaster locally instead of queueing it for relay', async () => {
  await withServer(async (server) => {
    const session = await connectSubmission(server.submission.port, 'you', 'a-real-passphrase');
    try {
      const stored = await sendMessage(session, `you@${DOMAIN}`, 'postmaster', 'from submission');
      assert.ok(stored.startsWith('250'), `submission should accept it: ${stored}`);
      // The defect this pins: with no domain to compare against ours it was classified REMOTE and
      // enqueued for a relay that could never succeed.
      assert.equal(server.queue.size, 0, 'nothing was queued for relay');
      const subjects = readMessages(server.stores.get('you')!.catalog.get('INBOX')!).map((m) => /^Subject: (.*)$/m.exec(m.raw.toString('latin1'))?.[1]);
      assert.ok(subjects.includes('from submission'), 'it was delivered locally');
    } finally {
      session.sock.destroy();
    }
  });
});

test('submission refuses a domain-less recipient rather than queueing an undeliverable one', async () => {
  await withServer(async (server) => {
    const session = await connectSubmission(server.submission.port, 'you', 'a-real-passphrase');
    try {
      await session.command(`MAIL FROM:<you@${DOMAIN}>`);
      const reply = await session.command('RCPT TO:<nobody>');
      // RFC 5321 §4.1.2 requires a domain in the forward-path outside the postmaster exception.
      // Accepting it queued a message that could only ever fail, after its whole retry schedule.
      assert.ok(reply.startsWith('550'), `expected a refusal, got ${reply}`);
      assert.equal(server.queue.size, 0);
    } finally {
      session.sock.destroy();
    }
  });
});
