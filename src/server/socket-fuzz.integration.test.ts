/**
 * Stateful socket fuzzing of the live servers. The pure-parser fuzz harness
 * (message/fuzz.test.ts) can't reach the server LOOPS — and that's exactly where
 * the real bugs lived (the sequence-set and APPEND-literal OOMs manifested only
 * in the IMAP command handler, not the parsers in isolation). This drives many
 * deterministic random command streams — a mix of valid verbs with fuzzed
 * arguments, pure garbage, oversized lines, and partial literals — through the
 * real sockets and asserts the invariant that matters: the server never crashes
 * or hangs. If any fuzzed stream provoked an uncaught exception the whole test
 * process would die; after the barrage a fresh clean session must still work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { SmtpReceiver } from './smtp-receiver.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function rng(seed: number): () => number {
  let s = seed >>> 0 || 0x1234567;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}
const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

/** A grab-bag of argument fragments, some valid, some hostile. */
function fuzzArg(rand: () => number): string {
  const kinds = [
    () => String(Math.floor(rand() * 1e12)), // huge numbers (the sequence-set DoS class)
    () => `${Math.floor(rand() * 9)}:${Math.floor(rand() * 1e11)}`, // huge ranges
    () => '1:*',
    () => '"' + 'x'.repeat(Math.floor(rand() * 40)) + '"', // quoted string
    () => '(' + '\\Seen '.repeat(Math.floor(rand() * 6)) + ')', // flag lists / brackets
    () => 'BODY.PEEK[' + pick(rand, ['HEADER', 'TEXT', '', 'HEADER.FIELDS (From To)', '1.2.3']) + ']',
    () => `{${Math.floor(rand() * 1e9)}}`, // literal declarations (the APPEND DoS class)
    () => `{${Math.floor(rand() * 8)}+}`, // non-sync literal
    () => 'INBOX',
    () => '<' + 'a'.repeat(Math.floor(rand() * 20)) + '@example.test>',
    () => Array.from({ length: Math.floor(rand() * 12) }, () => String.fromCharCode(32 + Math.floor(rand() * 95))).join(''),
  ];
  return pick(rand, kinds)();
}

function fuzzImapLine(rand: () => number, n: number): string {
  const verbs = ['CAPABILITY', 'LOGIN u p', 'SELECT', 'EXAMINE', 'FETCH', 'UID FETCH', 'STORE', 'UID STORE', 'SEARCH', 'UID SEARCH', 'CREATE', 'APPEND', 'COPY', 'UID COPY', 'MOVE', 'EXPUNGE', 'UID EXPUNGE', 'STATUS', 'LIST', 'LSUB', 'NAMESPACE', 'ID', 'IDLE', 'DONE', 'CLOSE', 'NOOP', 'SUBSCRIBE', 'garbage', ''];
  if (rand() < 0.15) return Array.from({ length: Math.floor(rand() * 20) }, () => String.fromCharCode(Math.floor(rand() * 256))).join(''); // raw noise
  const nargs = Math.floor(rand() * 3);
  const args = Array.from({ length: nargs }, () => fuzzArg(rand)).join(' ');
  return `t${n} ${pick(rand, verbs)} ${args}`.trim();
}

function fuzzSmtpLine(rand: () => number): string {
  const verbs = ['EHLO x', 'HELO x', 'MAIL FROM:', 'RCPT TO:', 'DATA', 'RSET', 'NOOP', 'QUIT', 'AUTH PLAIN', 'AUTH', 'STARTTLS', 'VRFY', 'EXPN', 'garbage'];
  if (rand() < 0.15) return Array.from({ length: Math.floor(rand() * 20) }, () => String.fromCharCode(Math.floor(rand() * 256))).join('');
  return `${pick(rand, verbs)}${fuzzArg(rand)}`;
}

/** Run one fuzzed session; resolve when the socket closes or a short idle passes. */
async function fuzzSession(port: number, lines: string[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve();
    };
    sock.on('error', finish);
    sock.on('close', finish);
    sock.on('connect', () => {
      // Send the whole fuzzed stream, then give the server a moment to process.
      sock.write(Buffer.from(lines.join('\r\n') + '\r\n', 'latin1'));
      setTimeout(finish, 30);
    });
    sock.on('data', () => {}); // drain
  });
}

test('IMAP survives 60 fuzzed command streams and a clean session still works', async () => {
  const server = await ImapServer.start(new MemoryCatalog(), { authenticate: () => true });
  const rand = rng(0xf00d);
  try {
    for (let i = 0; i < 60; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, k) => fuzzImapLine(rand, k));
      await fuzzSession(server.port, lines);
    }
    // The process survived every stream. Prove the server is still fully alive.
    const c = net.connect(server.port, '127.0.0.1');
    let acc = '';
    c.on('data', (d) => (acc += d.toString('latin1')));
    c.on('error', () => {});
    await new Promise<void>((r) => c.once('connect', () => r()));
    c.write(Buffer.from('z1 LOGIN u p\r\nz2 SELECT INBOX\r\nz3 NOOP\r\n', 'latin1'));
    for (let i = 0; i < 400 && !acc.includes('z3 OK'); i++) await delay(5);
    assert.match(acc, /z3 OK/, 'the IMAP server is fully responsive after the fuzz barrage');
    c.destroy();
  } finally {
    await server.close();
  }
});

test('SMTP survives 60 fuzzed command streams and a clean transaction still works', async () => {
  const delivered: unknown[] = [];
  const server = await SmtpReceiver.start((m) => delivered.push(m), { domain: 'mx.example.test' });
  const rand = rng(0xbeef);
  try {
    for (let i = 0; i < 60; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => fuzzSmtpLine(rand));
      await fuzzSession(server.port, lines);
    }
    const c = net.connect(server.port, '127.0.0.1');
    let acc = '';
    c.on('data', (d) => (acc += d.toString('latin1')));
    c.on('error', () => {});
    await new Promise<void>((r) => c.once('connect', () => r()));
    c.write(Buffer.from('EHLO client\r\nMAIL FROM:<a@b.test>\r\nRCPT TO:<c@mx.example.test>\r\nDATA\r\nSubject: ok\r\n\r\nbody\r\n.\r\n', 'latin1'));
    for (let i = 0; i < 400 && delivered.length === 0; i++) await delay(5);
    assert.equal(delivered.length, 1, 'the SMTP server still delivers a clean message after the fuzz barrage');
    c.destroy();
  } finally {
    await server.close();
  }
});
