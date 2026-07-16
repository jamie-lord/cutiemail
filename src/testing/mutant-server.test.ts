/**
 * Tests for the mutant server itself.
 *
 * Before the mutant can serve as a negative control for the corpus, it must be
 * shown to do what it claims: be conformant with no defects, and exhibit exactly
 * the switched-on defect and nothing else. A mutant that is accidentally broken
 * in a second way would let a corpus test pass for the wrong reason.
 *
 * These drive it with the real Wire + reply reader, so they also serve as a
 * second integration exercise of the read stack against a more realistic server
 * than the scripted double.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMutant } from './mutant-server.ts';
import { Wire } from '../wire/transport.ts';
import { replyFramer, ehloKeywords } from '../wire/reply.ts';
import { crlf, lf, cat, b } from '../wire/bytes.ts';

async function connect(port: number): Promise<Wire> {
  return Wire.connect({ host: '127.0.0.1', port });
}
async function readReply(wire: Wire) {
  const r = await wire.read(replyFramer, 2000);
  assert.equal(r.kind, 'framed', `expected a reply, got ${r.kind}`);
  return (r as { value: import('../wire/reply.ts').Reply }).value;
}

test('clean mutant: a full transaction succeeds with well-formed replies', async () => {
  await withMutant({}, async (port) => {
    const wire = await connect(port);
    assert.equal((await readReply(wire)).code, 220);
    await wire.send(crlf`EHLO client.test`);
    const ehlo = await readReply(wire);
    assert.equal(ehlo.code, 250);
    assert.deepEqual(ehlo.anomalies.map((a) => a.kind), [], 'clean mutant must emit no reply anomalies');
    assert.ok(ehloKeywords(ehlo).has('PIPELINING'));

    await wire.send(crlf`MAIL FROM:<a@client.test>`);
    assert.equal((await readReply(wire)).code, 250);
    await wire.send(crlf`RCPT TO:<b@mutant.test>`);
    assert.equal((await readReply(wire)).code, 250);
    await wire.send(crlf`DATA`);
    assert.equal((await readReply(wire)).code, 354);
    await wire.send(cat(crlf`Subject: hi`, crlf``, crlf`body`, Buffer.from('.\r\n')));
    assert.equal((await readReply(wire)).code, 250);
    await wire.send(crlf`QUIT`);
    assert.equal((await readReply(wire)).code, 221);
    await wire.close();
  });
});

test('findEndOfData detects a 3-byte smuggle marker at the very end of the buffer (regression)', async () => {
  // Regression for the #findEndOfData off-by-one: the loop bound stopped at
  // buf.length-4 and never visited i=buf.length-3, so a 3-byte marker (LF.LF)
  // sitting in the final three bytes — sent as the LAST bytes with nothing after —
  // was missed, silently blessing a vulnerable server. Here the marker IS the tail.
  await withMutant({ defects: { honourBareLfEndOfData: true } }, async (port) => {
    const wire = await connect(port);
    assert.equal((await readReply(wire)).code, 220);
    await wire.send(crlf`EHLO client.test`);
    assert.equal((await readReply(wire)).code, 250);
    await wire.send(crlf`MAIL FROM:<a@client.test>`);
    assert.equal((await readReply(wire)).code, 250);
    await wire.send(crlf`RCPT TO:<b@mutant.test>`);
    assert.equal((await readReply(wire)).code, 250);
    await wire.send(crlf`DATA`);
    assert.equal((await readReply(wire)).code, 354);
    // "\n.\n" as the final three bytes of the buffer, nothing after it.
    await wire.send(Buffer.from('body\n.\n', 'latin1'));
    assert.equal((await readReply(wire)).code, 250, 'the bare-LF end-of-data marker at buffer-end must be honoured by the defect');
    await wire.close();
  });
});

test('clean mutant: MAIL before greeting is refused (correct ordering)', async () => {
  await withMutant({}, async (port) => {
    const wire = await connect(port);
    await readReply(wire); // 220
    await wire.send(crlf`MAIL FROM:<a@b>`);
    assert.equal((await readReply(wire)).code, 503, 'a conformant mutant rejects MAIL before EHLO');
    await wire.close();
  });
});

test('defect honourBareLf: a bare-LF-terminated command is acted upon', async () => {
  // The defect is only observable as a DIFFERENCE from the clean baseline: the
  // clean mutant ignores a bare LF (no CRLF => no command), the mutant honours it.
  await withMutant({ defects: { honourBareLf: true } }, async (port) => {
    const wire = await connect(port);
    await readReply(wire); // 220
    await wire.send(lf`EHLO client.test`); // bare LF terminator
    const r = await wire.read(replyFramer, 1000);
    assert.equal(r.kind, 'framed', 'the mutant honoured the bare LF and replied');
    assert.equal((r as { value: { code: number } }).value.code, 250);
    await wire.close();
  });
});

test('clean baseline: a bare-LF command is NOT acted upon', async () => {
  // The other half of the negative control: proving the clean server does the
  // right thing, so the defect test above is measuring the defect and not a
  // pre-existing bug.
  await withMutant({}, async (port) => {
    const wire = await connect(port);
    await readReply(wire); // 220
    await wire.send(lf`EHLO client.test`);
    const quiet = await wire.expectQuiet(200);
    assert.equal(quiet.quiet, true, 'a conformant server takes no action on a bare-LF command');
    await wire.close();
  });
});

test('defect outOfGrammarCode: replies carry a 260', async () => {
  await withMutant({ defects: { outOfGrammarCode: true } }, async (port) => {
    const wire = await connect(port);
    await readReply(wire); // 220 greeting is unaffected
    await wire.send(crlf`HELO client.test`);
    const r = await readReply(wire);
    assert.equal(r.code, 260);
    assert.ok(r.anomalies.some((a) => a.kind === 'code-out-of-grammar'));
    await wire.close();
  });
});

test('defect bareCodeReplies: replies omit their text', async () => {
  await withMutant({ defects: { bareCodeReplies: true } }, async (port) => {
    const wire = await connect(port);
    await readReply(wire);
    await wire.send(crlf`HELO client.test`);
    const r = await readReply(wire);
    assert.ok(r.anomalies.some((a) => a.kind === 'bare-code'));
    await wire.close();
  });
});

test('defect eightBitReplyText: reply text carries an 8-bit octet', async () => {
  await withMutant({ defects: { eightBitReplyText: true } }, async (port) => {
    const wire = await connect(port);
    await readReply(wire);
    await wire.send(crlf`HELO client.test`);
    const r = await readReply(wire);
    assert.ok(r.anomalies.some((a) => a.kind === 'non-ascii-in-text'));
    await wire.close();
  });
});

test('defect acceptMailBeforeGreeting: MAIL is accepted with no EHLO', async () => {
  await withMutant({ defects: { acceptMailBeforeGreeting: true } }, async (port) => {
    const wire = await connect(port);
    await readReply(wire);
    await wire.send(crlf`MAIL FROM:<a@b>`);
    assert.equal((await readReply(wire)).code, 250, 'the mutant wrongly accepts MAIL before greeting');
    await wire.close();
  });
});

test('defect acceptRcptBeforeMail: RCPT is accepted with no MAIL', async () => {
  await withMutant({ defects: { acceptRcptBeforeMail: true } }, async (port) => {
    const wire = await connect(port);
    await readReply(wire);
    await wire.send(crlf`EHLO client.test`);
    await readReply(wire);
    await wire.send(crlf`RCPT TO:<b@mutant.test>`);
    assert.equal((await readReply(wire)).code, 250, 'the mutant wrongly accepts RCPT before MAIL');
    await wire.close();
  });
});

test('defect ignoreRset: state survives RSET', async () => {
  await withMutant({ defects: { ignoreRset: true } }, async (port) => {
    const wire = await connect(port);
    await readReply(wire);
    await wire.send(crlf`EHLO c.test`); await readReply(wire);
    await wire.send(crlf`MAIL FROM:<a@b>`); await readReply(wire);
    await wire.send(crlf`RSET`); assert.equal((await readReply(wire)).code, 250);
    // If RSET were honoured, RCPT would now be refused (no MAIL). The mutant
    // ignored it, so RCPT is accepted — the observable defect.
    await wire.send(crlf`RCPT TO:<b@mutant.test>`);
    assert.equal((await readReply(wire)).code, 250, 'state wrongly survived RSET');
    await wire.close();
  });
});

test('defect mismatchedContinuation: EHLO reply has inconsistent codes', async () => {
  await withMutant({ defects: { mismatchedContinuation: true } }, async (port) => {
    const wire = await connect(port);
    await readReply(wire);
    await wire.send(crlf`EHLO c.test`);
    const r = await readReply(wire);
    assert.ok(r.anomalies.some((a) => a.kind === 'continuation-code-mismatch'));
    await wire.close();
  });
});

test('defect closeWithout421: an unknown command drops the connection with no reply', async () => {
  await withMutant({ defects: { closeWithout421: true } }, async (port) => {
    const wire = await connect(port);
    await readReply(wire);
    await wire.send(crlf`WATSUP`);
    const r = await wire.read(replyFramer, 1000);
    assert.ok(r.kind === 'closed' || r.kind === 'reset', 'the mutant closed without a 421');
    await wire.close();
  });
});

test('defect actOnUnterminatedLine: server replies before the CRLF', async () => {
  await withMutant({ defects: { actOnUnterminatedLine: true } }, async (port) => {
    const wire = await connect(port);
    await readReply(wire);
    await wire.send(Buffer.from('NOOP', 'latin1')); // no CRLF
    const r = await wire.read(replyFramer, 1000);
    assert.equal(r.kind, 'framed', 'the mutant acted on an unterminated line');
    await wire.close();
  });
});

test('defect keepStateAcrossStartTls: pre-TLS EHLO leaks a secret keyword', async () => {
  // The observable proxy for "state not discarded": a keyword that a correct
  // server would never carry across the handshake. The full STARTTLS-discard
  // test lives in the corpus (task #19); here we only prove the mutant exhibits
  // the leak so that test has something to catch.
  await withMutant({ defects: { keepStateAcrossStartTls: true } }, async (port) => {
    const wire = await connect(port);
    await readReply(wire);
    await wire.send(crlf`EHLO c.test`);
    const r = await readReply(wire);
    assert.ok(ehloKeywords(r).has('SECRET-PRE-TLS-KEYWORD'));
    await wire.close();
  });
});

void b; // available for byte-level defect authoring
