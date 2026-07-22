/**
 * The OUTBOUND client conformance corpus, with negative controls.
 *
 * The mirror of the receiver corpus: each case drives our reference delivery
 * client (the system under test) against a scripted peer and proves two things —
 * the client is CONFORMANT with no defects, and the matching client-defect is
 * DETECTED. A case with no defect proof is only half a test.
 *
 * Traceability: each case cites a compile-checked rfc5321 RequirementId — the same
 * requirements reclassified to `wire-client` in ADR 0008. The receiver suite
 * cannot observe these (it connects outward to a server); this suite can, because
 * it drives the client.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver } from './deliver.ts';
import { withPeer } from '../testing/client-peer.ts';
import { CR, LF } from '../wire/bytes.ts';
import { requirement } from '../register/rfc5321.ts';
import type { RequirementId } from '../register/rfc5321.ts';

const cites = (id: RequirementId): void => assert.ok(requirement(id).id === id);
const connectTo = (port: number): { host: string; port: number; tls: 'none' } => ({ host: '127.0.0.1', port, tls: 'none' });

const REQUEST = {
  from: 'sender@example.com',
  recipients: ['rcpt@example.net'],
  data: Buffer.from('Subject: hi\r\n\r\nhello world\r\n', 'latin1'),
  clientName: 'client.example.org',
};

/** A bare LF is an LF not immediately preceded by CR — the §2.3.8 violation. */
function hasBareLf(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === LF && buf[i - 1] !== CR) return true;
  }
  return false;
}

test('sanity: a conformant delivery completes and the peer captures the message', async () => {
  await withPeer({}, async (peer) => {
    const r = await deliver(connectTo(peer.port), REQUEST);
    assert.ok(r.ok, `delivery should succeed: ${r.failure}`);
    assert.equal(r.openingVerb, 'EHLO');
    assert.equal(peer.deliveries.length, 1);
    assert.equal(peer.deliveries[0]!.from, 'sender@example.com');
    assert.deepEqual([...peer.deliveries[0]!.recipients], ['rcpt@example.net']);
    assert.ok(peer.deliveries[0]!.rawData.includes(Buffer.from('hello world')), 'the body arrives intact');
  });
});

test('R-5321-2.2.1-c: the client opens with EHLO, not HELO (and heloOnly is caught)', async () => {
  cites('R-5321-2.2.1-c');
  // Conformant: the FIRST command the peer receives is EHLO.
  await withPeer({}, async (peer) => {
    await deliver(connectTo(peer.port), REQUEST);
    const first = peer.received.toString('latin1').split(/\r?\n/)[0] ?? '';
    assert.ok(first.startsWith('EHLO'), `expected EHLO first, got "${first}"`);
  });
  // Negative control: heloOnly opens with HELO — detectable.
  await withPeer({}, async (peer) => {
    await deliver(connectTo(peer.port), REQUEST, { heloOnly: true });
    const first = peer.received.toString('latin1').split(/\r?\n/)[0] ?? '';
    assert.ok(first.startsWith('HELO'), 'heloOnly defect must be detectable');
  });
});

test('R-5321-3.2-c: the client falls back to HELO when EHLO is refused (and noHeloFallback is caught)', async () => {
  cites('R-5321-3.2-c');
  // Conformant: peer refuses EHLO with 500; client falls back to HELO and completes.
  await withPeer({ ehloStatus: 500 }, async (peer) => {
    const r = await deliver(connectTo(peer.port), REQUEST);
    assert.ok(r.heloFellBack, 'client should fall back to HELO');
    assert.ok(r.ok, `delivery should still complete via HELO: ${r.failure}`);
    assert.equal(peer.deliveries.length, 1);
  });
  // Negative control: noHeloFallback gives up instead.
  await withPeer({ ehloStatus: 500 }, async (peer) => {
    const r = await deliver(connectTo(peer.port), REQUEST, { noHeloFallback: true });
    assert.ok(!r.ok && !r.heloFellBack, 'noHeloFallback defect must be detectable');
    assert.equal(peer.deliveries.length, 0);
  });
});

test('R-5321-2.3.8-c: the client transmits CRLF only, never a bare LF (and emitBareLf is caught)', async () => {
  cites('R-5321-2.3.8-c');
  // Conformant: no bare LF anywhere in what the peer received.
  await withPeer({}, async (peer) => {
    await deliver(connectTo(peer.port), REQUEST);
    assert.ok(!hasBareLf(peer.received), 'a conformant client emits no bare LF');
  });
  // Negative control: emitBareLf terminates commands with bare LF.
  await withPeer({}, async (peer) => {
    await deliver(connectTo(peer.port), REQUEST, { emitBareLf: true });
    assert.ok(hasBareLf(peer.received), 'emitBareLf defect must be detectable');
  });
});

test('R-5321-4.5.2-a: the client dot-stuffs a leading period on transmit (skipDotStuffing caught)', async () => {
  cites('R-5321-4.5.2-a');
  // A body whose lines begin with a period — the transmit-side smuggling surface.
  const dotted = {
    ...REQUEST,
    data: Buffer.from('Subject: dots\r\n\r\n.hidden\r\n..already\r\nnormal\r\n', 'latin1'),
  };
  // Conformant: each leading period is doubled on the wire.
  await withPeer({}, async (peer) => {
    await deliver(connectTo(peer.port), dotted);
    const wire = peer.deliveries[0]!.rawData.toString('latin1');
    assert.ok(wire.includes('\r\n..hidden\r\n'), 'a leading period is doubled (.hidden -> ..hidden)');
    assert.ok(wire.includes('\r\n...already\r\n'), 'an existing double is stuffed too (..already -> ...already)');
    assert.ok(wire.includes('\r\nnormal\r\n'), 'a non-dotted line is untouched');
  });
  // Negative control: skipDotStuffing sends the raw periods — a smuggling vector.
  await withPeer({}, async (peer) => {
    await deliver(connectTo(peer.port), dotted, { skipDotStuffing: true });
    const wire = peer.deliveries[0]!.rawData.toString('latin1');
    assert.ok(wire.includes('\r\n.hidden\r\n'), 'the defect leaves the single leading period unstuffed — detectable');
    assert.ok(!wire.includes('..hidden'), 'no stuffing happened under the defect');
  });
});

test('R-5321-3.3-u: the terminator reuses the final line CRLF — no spurious blank line is delivered', async () => {
  cites('R-5321-3.3-u');
  // A well-formed message ending in CRLF. The terminating <CRLF>.<CRLF> shares that
  // final CRLF, so the client must put ".<CRLF>" on the wire — not a whole extra
  // <CRLF>.<CRLF>, which would append a blank line to the delivered message.
  const ends = { ...REQUEST, data: Buffer.from('Subject: exact\r\n\r\nlast line\r\n', 'latin1') };
  await withPeer({}, async (peer) => {
    await deliver(connectTo(peer.port), ends);
    const wire = peer.received.toString('latin1');
    assert.ok(wire.endsWith('last line\r\n.\r\n'), `expected a bare ".CRLF" terminator, got ${JSON.stringify(wire.slice(-24))}`);
    assert.ok(!wire.includes('last line\r\n\r\n.\r\n'), 'the client must not double the final CRLF');
    // The peer stores exactly what was sent — byte-exact, one trailing CRLF.
    assert.deepEqual(peer.deliveries[0]!.rawData, ends.data, 'the delivered message is byte-identical, no blank line added');
  });
  // A message NOT already ending in CRLF: the client supplies one, so the peer still
  // sees a proper final line (the message is normalised, not truncated).
  const noEnd = { ...REQUEST, data: Buffer.from('Subject: exact\r\n\r\nno newline', 'latin1') };
  await withPeer({}, async (peer) => {
    await deliver(connectTo(peer.port), noEnd);
    assert.deepEqual(peer.deliveries[0]!.rawData, Buffer.from('Subject: exact\r\n\r\nno newline\r\n', 'latin1'), 'a missing final CRLF is supplied');
  });
});

test('R-5321-2.1-h: the client is lock-step — no command sent before the prior reply (pipeline caught)', async () => {
  cites('R-5321-2.1-h');
  // The peer withholds the MAIL reply and snapshots what it has received at reply
  // time. A lock-step client, blocked on that reply, cannot have sent RCPT yet.
  let snapshot: Buffer = Buffer.alloc(0);
  await withPeer({ withholdMailReplyMs: 120, onMailReceived: (r) => (snapshot = r) }, async (peer) => {
    await deliver(connectTo(peer.port), REQUEST);
    void peer;
  });
  assert.ok(!snapshot.includes(Buffer.from('RCPT')), 'a lock-step client has not sent RCPT while awaiting the MAIL reply');

  // Negative control: pipelineWithoutWaiting fires RCPT before the MAIL reply arrives.
  let defectSnapshot: Buffer = Buffer.alloc(0);
  await withPeer({ withholdMailReplyMs: 120, onMailReceived: (r) => (defectSnapshot = r) }, async (peer) => {
    await deliver(connectTo(peer.port), REQUEST, { pipelineWithoutWaiting: true });
    void peer;
  });
  assert.ok(defectSnapshot.includes(Buffer.from('RCPT')), 'pipelineWithoutWaiting defect must be detectable');
});

test('R-5321-3.3-u: the client terminates DATA with <CRLF>.<CRLF> (and skipTerminatingDot is caught)', async () => {
  cites('R-5321-3.3-u');
  // Conformant: the peer sees end-of-data and captures the message.
  await withPeer({}, async (peer) => {
    await deliver(connectTo(peer.port), REQUEST);
    assert.equal(peer.deliveries.length, 1, 'the terminated DATA is captured');
    assert.ok(peer.received.includes(Buffer.from('\r\n.\r\n')), 'the terminating dot is on the wire');
  });
  // Negative control: skipTerminatingDot omits it — the peer never completes the message.
  await withPeer({}, async (peer) => {
    // Short client timeout: with no terminator the final read would otherwise wait.
    await deliver(connectTo(peer.port), REQUEST, { skipTerminatingDot: true }, 400);
    assert.equal(peer.deliveries.length, 0, 'skipTerminatingDot defect must be detectable (no end-of-data)');
  });
});

test('R-5321-3.3-y: the client sends no message data after a 5yz (and ignore5yzAndSendData is caught)', async () => {
  cites('R-5321-3.3-y');
  // Conformant: peer refuses MAIL with 550; client must NOT open DATA.
  await withPeer({ mailStatus: 550 }, async (peer) => {
    const r = await deliver(connectTo(peer.port), REQUEST);
    assert.ok(!r.sentData, 'no data after a 5yz');
    assert.equal(peer.deliveries.length, 0);
    assert.ok(!peer.received.includes(Buffer.from('DATA')), 'the client never issued DATA');
  });
  // Negative control: ignore5yzAndSendData barrels on to DATA anyway.
  await withPeer({ mailStatus: 550 }, async (peer) => {
    const r = await deliver(connectTo(peer.port), REQUEST, { ignore5yzAndSendData: true });
    assert.ok(r.sentData || peer.received.includes(Buffer.from('DATA')), 'ignore5yzAndSendData defect must be detectable');
  });
});

test('post-EOD reply timeout is INDETERMINATE, not a plain refusal (RFC 5321 §4.5.3.2.6)', async () => {
  // The peer accepts DATA, consumes the whole message + terminating dot, then WITHHOLDS the 250
  // (a slow content scanner). With a short post-EOD timeout the client must report the outcome as
  // indeterminate - the peer may already hold the message - rather than as a normal failure that
  // a caller would resend and duplicate.
  await withPeer({ withholdDataReplyMs: 5_000 }, async (peer) => {
    const r = await deliver(connectTo(peer.port), REQUEST, {}, undefined, { postDataReplyTimeoutMs: 150 });
    assert.equal(r.ok, false, 'no 250 was seen, so not a success');
    assert.equal(r.dataIndeterminate, true, 'a post-terminator timeout is indeterminate');
    assert.equal(r.dataCode, null, 'no data code was received');
    assert.match(r.failure ?? '', /indeterminate/, 'the failure names the indeterminate outcome');
    // The message DID reach the peer (the duplicate risk is real precisely because it arrived).
    assert.equal(peer.deliveries.length, 1, 'the terminated message was received by the peer');
  });
  // Contrast: a peer that replies in time is a clean success, NOT indeterminate.
  await withPeer({}, async (peer) => {
    const r = await deliver(connectTo(peer.port), REQUEST, {}, undefined, { postDataReplyTimeoutMs: 5_000 });
    assert.ok(r.ok, `a timely 250 is a success: ${r.failure}`);
    assert.equal(r.dataIndeterminate, false, 'a replied-to delivery is never indeterminate');
  });
});

test('a rejected greeting is QUIT-ed, and the code drives classification (fix 8)', async () => {
  // 554 "no service": a permanent greeting rejection. The client must QUIT (RFC 5321 §3.1), not
  // drop the connection, and surface the 5yz code for the relay to bounce on.
  await withPeer({ greetingStatus: 554 }, async (peer) => {
    const r = await deliver(connectTo(peer.port), REQUEST);
    assert.equal(r.ok, false);
    assert.equal(r.greetingCode, 554, 'the greeting code is reported');
    assert.equal(r.quit, true, 'the client QUITs a rejected greeting');
    // The QUIT is fire-and-forget (no reply awaited), so poll briefly for the peer to receive it.
    for (let i = 0; i < 50 && !peer.received.includes(Buffer.from('QUIT')); i++) await new Promise((res) => setTimeout(res, 5));
    assert.ok(peer.received.includes(Buffer.from('QUIT')), 'QUIT is actually on the wire');
    assert.equal(peer.deliveries.length, 0, 'no transaction after a rejected greeting');
  });
  // 421 "not available": a transient greeting rejection - still QUIT, code surfaced as 4yz.
  await withPeer({ greetingStatus: 421 }, async (peer) => {
    const r = await deliver(connectTo(peer.port), REQUEST);
    assert.equal(r.ok, false);
    assert.equal(r.greetingCode, 421, 'the 4yz greeting code is reported (relay defers on it)');
    assert.equal(r.quit, true);
  });
});

test('SMTPUTF8 gate: an internationalized envelope is refused, not mojibaked onto the wire (fix 9)', async () => {
  // The client does not yet transmit SMTPUTF8, so an internationalized envelope address must be
  // refused rather than latin1-mangled onto the wire.
  const intlFrom = { ...REQUEST, from: 'jamⅰe@exämple.com' };
  await withPeer({}, async (peer) => {
    const r = await deliver(connectTo(peer.port), intlFrom);
    assert.equal(r.ok, false);
    assert.match(r.failure ?? '', /SMTPUTF8|internationalized/i, 'the refusal names the reason');
    assert.equal(peer.deliveries.length, 0, 'nothing was transmitted');
    assert.ok(!peer.received.includes(Buffer.from('MAIL FROM')), 'no MAIL FROM with a mangled address was sent');
  });
  const intlRcpt = { ...REQUEST, recipients: ['reçipient@example.net'] };
  await withPeer({}, async (peer) => {
    const r = await deliver(connectTo(peer.port), intlRcpt);
    assert.equal(r.ok, false, 'an internationalized recipient is refused too');
    assert.equal(peer.deliveries.length, 0);
  });
  // Negative control: the same shape with an ASCII envelope delivers normally.
  await withPeer({}, async (peer) => {
    const r = await deliver(connectTo(peer.port), REQUEST);
    assert.ok(r.ok, `an ASCII envelope must still deliver: ${r.failure}`);
    assert.equal(peer.deliveries.length, 1);
  });
});
