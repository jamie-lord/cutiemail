/**
 * Hard-error limit (Postfix's smtpd_hard_error_limit). The SMTP idle timer resets on
 * every received chunk, so a peer that trickles or floods junk commands holds its
 * connection slot indefinitely — bounded only by the global MAX_CONNECTIONS cap. This
 * was surfaced by a live pentest (a raw-socket junk-command flood held a slot with no
 * disconnect). The server must count client protocol errors and drop the connection
 * once a peer crosses the limit, while never disconnecting a well-behaved client.
 *
 * The limit is 20 (matching Postfix). These tests treat that value structurally:
 * >20 errors ⇒ a 421 close; a clean session with a handful of errors is untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { SmtpReceiver } from './smtp-receiver.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Open a session, send `lines` (CRLF-joined), collect all output until the socket
 *  closes or `idleMs` passes with no server-initiated close. Reports whether the
 *  server closed the connection itself. */
function session(port: number, lines: string[], idleMs = 300): Promise<{ out: string; serverClosed: boolean }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let out = '';
    let serverClosed = false;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ out, serverClosed });
    };
    sock.on('data', (d) => (out += d.toString('latin1')));
    sock.on('end', () => { serverClosed = true; });
    sock.on('close', finish);
    sock.on('error', () => {});
    sock.on('connect', () => {
      sock.write(Buffer.from(lines.join('\r\n') + '\r\n', 'latin1'));
      setTimeout(finish, idleMs);
    });
  });
}

test('a flood of unknown commands trips the hard-error limit and the server closes with 421', async () => {
  const server = await SmtpReceiver.start(() => {}, { domain: 'mx.example.test' });
  try {
    const { out, serverClosed } = await session(server.port, Array.from({ length: 30 }, () => 'FROBNICATE junk'));
    assert.match(out, /421 4\.7\.0 too many protocol errors/, 'server announced the hard-error disconnect');
    assert.ok(serverClosed, 'server closed the connection itself');
    // The server stopped processing after the limit: it did not answer all 30 junk lines.
    const fiveHundreds = (out.match(/^500 /gm) ?? []).length;
    assert.ok(fiveHundreds <= 20, `answered at most the limit of junk commands, got ${fiveHundreds}`);
  } finally {
    await server.close();
  }
});

test('recipient-probing (rejected RCPTs) trips the hard-error limit', async () => {
  const server = await SmtpReceiver.start(() => {}, {
    domain: 'mx.example.test',
    acceptRecipient: (a) => a.endsWith('@mx.example.test'),
  });
  try {
    const lines = ['EHLO probe', 'MAIL FROM:<a@b.test>'];
    for (let i = 0; i < 25; i++) lines.push(`RCPT TO:<user${i}@elsewhere.test>`);
    const { out, serverClosed } = await session(server.port, lines);
    assert.match(out, /421 4\.7\.0 too many protocol errors/, 'a recipient-spray is bounded');
    assert.ok(serverClosed, 'server closed the connection itself');
  } finally {
    await server.close();
  }
});

test('a well-behaved client with a few errors is NOT disconnected and still delivers', async () => {
  const delivered: unknown[] = [];
  const server = await SmtpReceiver.start((m) => { delivered.push(m); }, {
    domain: 'mx.example.test',
    acceptRecipient: (a) => a.endsWith('@mx.example.test'),
  });
  try {
    // A handful of errors (well under the limit of 20) then a clean transaction.
    const lines = [
      'EHLO client',
      'WHAT', 'HUH', 'NONSENSE', // 3 unknown commands
      'MAIL FROM:<a@b.test>',
      'RCPT TO:<c@mx.example.test>',
      'DATA',
      'Subject: ok',
      '',
      'hello body',
      '.',
      'QUIT',
    ];
    const { out } = await session(server.port, lines, 400);
    for (let i = 0; i < 200 && delivered.length === 0; i++) await delay(5);
    assert.doesNotMatch(out, /421 4\.7\.0 too many protocol errors/, 'a few errors must not disconnect a normal client');
    assert.equal(delivered.length, 1, 'the clean transaction still delivered');
    assert.match(out, /250 2\.0\.0 message stored/);
  } finally {
    await server.close();
  }
});
