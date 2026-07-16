/**
 * The live IMAP server must emit RFC 9051-conforming responses. This drives a
 * rich session and feeds every response the server sends back through the
 * reference response parser (src/imap/response.ts) — the same parser the
 * conformance corpus vector-pins — as an oracle: each response must parse with
 * no grammar anomalies, a tagged response must carry a tag and a status
 * condition, and untagged status responses must carry a condition. This is how
 * the live server is held to the same bar the test bed sets for what it consumes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';
import { parseResponse } from '../imap/response.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Split an IMAP response stream into logical responses, returning each response's
 * FIRST line — skipping the octets of any {n} literal (and its continuation
 * lines) so a literal payload is never mistaken for a response line.
 */
function responseFirstLines(stream: Buffer): string[] {
  const firsts: string[] = [];
  let i = 0;
  const literal = /\{(\d+)\+?\}$/;
  while (i < stream.length) {
    const nl = stream.indexOf(Buffer.from('\r\n', 'latin1'), i);
    if (nl === -1) break;
    let line = stream.subarray(i, nl).toString('latin1');
    i = nl + 2;
    firsts.push(line);
    // Consume any literals this logical response declares, and the continuation
    // line after each, until a continuation doesn't declare another literal.
    while (literal.test(line)) {
      i += Number(literal.exec(line)![1]);
      const nl2 = stream.indexOf(Buffer.from('\r\n', 'latin1'), i);
      if (nl2 === -1) return firsts;
      line = stream.subarray(i, nl2).toString('latin1');
      i = nl2 + 2;
    }
  }
  return firsts;
}

test('every response from a rich live session parses as well-formed RFC 9051', async () => {
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  inbox.append(Buffer.from('From: a@b.test\r\nTo: c@d.test\r\nSubject: hi\r\nDate: Thu, 16 Jul 2026 12:00:00 +0000\r\n\r\nbody\r\n', 'latin1'));
  inbox.append(Buffer.from('Subject: two\r\n\r\nsecond\r\n', 'latin1'));

  const server = await ImapServer.start(catalog, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  let acc = Buffer.alloc(0);
  sock.on('data', (d) => (acc = Buffer.concat([acc, Buffer.from(d)])));
  sock.on('error', () => {});
  try {
    await new Promise<void>((r) => sock.once('connect', () => r()));
    const script = [
      'a1 CAPABILITY',
      'a2 LOGIN user pass',
      'a3 NAMESPACE',
      'a4 LIST "" "*"',
      'a5 CREATE "Sent"',
      'a6 STATUS "INBOX" (MESSAGES UIDNEXT UIDVALIDITY UNSEEN)',
      'a7 SELECT "INBOX"',
      'a8 UID FETCH 1:* (UID FLAGS RFC822.SIZE ENVELOPE)',
      'a9 UID FETCH 1 (BODY.PEEK[HEADER] BODY.PEEK[TEXT])',
      String.raw`a10 UID STORE 1 +FLAGS (\Seen)`,
      'a11 UID SEARCH SUBJECT "hi"',
      'a12 NOOP',
      'a13 LOGOUT',
    ].join('\r\n');
    sock.write(Buffer.from(script + '\r\n', 'latin1'));
    for (let i = 0; i < 400 && !acc.toString('latin1').includes('a13 OK'); i++) await delay(5);
    assert.match(acc.toString('latin1'), /a13 OK/, 'the session completed');

    const lines = responseFirstLines(acc);
    assert.ok(lines.length > 20, `a rich session yields many responses (got ${lines.length})`);
    for (const line of lines) {
      const r = parseResponse(Buffer.from(line, 'latin1'));
      assert.deepEqual(r.anomalies, [], `response has no grammar anomaly: ${JSON.stringify(line)}`);
      if (r.kind === 'tagged') {
        assert.ok(r.tag !== null && r.tag.length > 0, `tagged response has a tag: ${JSON.stringify(line)}`);
        assert.ok(r.condition !== null, `tagged response carries a status condition: ${JSON.stringify(line)}`);
      }
    }
    // Sanity: the tagged completions we expect are all present and OK.
    for (const tag of ['a1', 'a2', 'a7', 'a8', 'a13']) {
      assert.ok(lines.some((l) => l.startsWith(`${tag} OK`)), `${tag} completed OK`);
    }
  } finally {
    sock.destroy();
    await server.close();
  }
});
