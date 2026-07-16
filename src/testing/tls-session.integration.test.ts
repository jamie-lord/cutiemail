/**
 * Integration: the RFC 3207 §4.2 post-handshake session reset, using the mutant's
 * opt-in TLS termination (a real server-side handshake with a self-signed test
 * cert). "Upon completion of the TLS handshake, the SMTP protocol is reset to the
 * initial state" — so a conformant server, after STARTTLS + handshake, requires a
 * FRESH EHLO before it will accept MAIL; the pre-TLS greeting is gone.
 *
 * Observable as: MAIL FROM issued inside TLS WITHOUT a fresh EHLO draws 503 (need
 * HELO/EHLO first) on a conformant server, but is wrongly accepted (250) by a
 * server that retains its pre-TLS state (the keepStateAcrossStartTls defect — the
 * STARTTLS session-fixation / state-confusion class).
 *
 * This uses Wire directly (not the corpus Conn) so it can pass
 * rejectUnauthorized:false for the self-signed mutant cert. A real server with a
 * valid cert would be tested through the ordinary corpus path once that is wired
 * for calibration (docs/decisions/0006).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wire } from '../wire/transport.ts';
import { replyFramer, frameReplyAtEof } from '../wire/reply.ts';
import type { Reply } from '../wire/reply.ts';
import { MutantServer } from './mutant-server.ts';
import type { Defects } from './mutant-server.ts';

async function readReply(wire: Wire): Promise<Reply> {
  const r = await wire.read(replyFramer, 5000, frameReplyAtEof);
  if (r.kind !== 'framed') throw new Error(`expected a reply, got ${r.kind}`);
  return r.value;
}

/** Drive greeting -> EHLO -> STARTTLS -> TLS handshake, then MAIL WITHOUT a fresh
 *  EHLO, and return the reply code the server gives that MAIL. */
async function mailAfterTlsWithoutEhlo(defects: Defects): Promise<number> {
  const mutant = await MutantServer.start({ defects, terminateTls: true, validRecipients: ['recipient@example.com'] });
  try {
    const wire = await Wire.connect({ host: '127.0.0.1', port: mutant.port, tls: 'none' });
    try {
      await readReply(wire); // 220 greeting
      await wire.send(Buffer.from('EHLO client.test\r\n', 'latin1'));
      await readReply(wire); // 250
      await wire.send(Buffer.from('STARTTLS\r\n', 'latin1'));
      const tlsReady = await readReply(wire);
      assert.equal(tlsReady.code, 220, 'STARTTLS should draw 220');
      await wire.startTls({ rejectUnauthorized: false }); // self-signed test cert
      // Inside TLS, no fresh EHLO — a reset server must refuse MAIL as out of sequence.
      await wire.send(Buffer.from('MAIL FROM:<probe@conformance-suite.invalid>\r\n', 'latin1'));
      return (await readReply(wire)).code;
    } finally {
      await wire.close();
    }
  } finally {
    await mutant.close();
  }
}

test('RFC 3207 §4.2: a conformant server resets to initial state after TLS — MAIL without a fresh EHLO draws 503', async () => {
  const code = await mailAfterTlsWithoutEhlo({});
  assert.equal(code, 503, `after the TLS handshake the session should be reset (a fresh EHLO required), got ${code}`);
});

test('keepStateAcrossStartTls is DETECTED: the server retains pre-TLS greeting state, wrongly accepting MAIL without a fresh EHLO', async () => {
  const code = await mailAfterTlsWithoutEhlo({ keepStateAcrossStartTls: true });
  assert.equal(code, 250, `the defect retains pre-TLS state, so MAIL is accepted (250) instead of refused, got ${code}`);
});
