/**
 * Reply reader invariants.
 *
 * The reader's contract is that it never repairs and never normalises. Each test
 * below pins one deviation the RFC's grammar forbids and asserts we *notice* it.
 * A reader that quietly forgave any of these would make the corpus report clean
 * runs against servers that are provably out of grammar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyFramer, frameReplyAtEof, severity, ehloKeywords, MAX_REPLY_LINE, MAX_REPLY_BYTES, ReplyTooLongError } from './reply.ts';
import type { Reply, AnomalyKind } from './reply.ts';

const frame = (s: string | Buffer): Reply => {
  const buf = typeof s === 'string' ? Buffer.from(s, 'latin1') : s;
  const r = replyFramer(buf);
  assert.ok(r !== null, 'expected a complete reply');
  return r.value;
};

const kinds = (r: Reply): AnomalyKind[] => r.anomalies.map((a) => a.kind);

test('a well-formed single-line reply has no anomalies', () => {
  const r = frame('250 OK\r\n');
  assert.equal(r.code, 250);
  assert.equal(r.multiline, false);
  assert.deepEqual(kinds(r), []);
  assert.equal(r.lines[0]!.text.toString(), 'OK');
});

test('a well-formed multiline reply has no anomalies', () => {
  const r = frame('250-mail.example.com\r\n250-PIPELINING\r\n250 SIZE 10240000\r\n');
  assert.equal(r.code, 250);
  assert.equal(r.multiline, true);
  assert.equal(r.lines.length, 3);
  assert.deepEqual(kinds(r), []);
});

test('framing consumes exactly one reply and no more', () => {
  const buf = Buffer.from('250 one\r\n250 two\r\n', 'latin1');
  const r = replyFramer(buf);
  assert.ok(r !== null);
  assert.equal(r.consumed, 9, 'must not swallow the following reply');
  assert.deepEqual(r.value.raw, Buffer.from('250 one\r\n'));
});

test('an incomplete reply returns null rather than guessing', () => {
  assert.equal(replyFramer(Buffer.from('250 OK')), null);
  assert.equal(replyFramer(Buffer.from('250-a\r\n250 ')), null);
  // A trailing CR is ambiguous until the next byte arrives: CRLF or bare CR?
  assert.equal(replyFramer(Buffer.from('250 OK\r')), null);
});

test('the second code digit is bounded 0-5 by the ABNF', () => {
  // %x32-35 %x30-35 %x30-39. A 260 is ungrammatical, which almost no client
  // notices because almost no client reads the ABNF.
  assert.deepEqual(kinds(frame('260 nope\r\n')), ['code-out-of-grammar']);
  assert.deepEqual(kinds(frame('275 nope\r\n')), ['code-out-of-grammar']);
  assert.deepEqual(kinds(frame('250 fine\r\n')), []);
  assert.deepEqual(kinds(frame('255 fine\r\n')), []);
});

test('the first code digit is bounded 2-5 by the ABNF', () => {
  assert.deepEqual(kinds(frame('100 nope\r\n')), ['code-out-of-grammar']);
  assert.deepEqual(kinds(frame('600 nope\r\n')), ['code-out-of-grammar']);
  assert.deepEqual(kinds(frame('421 fine\r\n')), []);
});

test('the code is still reported when ungrammatical', () => {
  // Discarding it would destroy the evidence the anomaly is about.
  const r = frame('260 nope\r\n');
  assert.equal(r.code, 260);
  assert.equal(severity(r), 2);
});

test('a bare LF terminator is recorded, not silently accepted', () => {
  const r = frame('250 OK\n');
  assert.ok(kinds(r).includes('bare-lf-terminator'));
  assert.equal(r.lines[0]!.terminator, 'lf');
  assert.equal(r.code, 250, 'still readable — we observe the violation, not refuse it');
});

test('a bare CR terminator is recorded', () => {
  const r = frame('250 OK\rnext');
  assert.ok(kinds(r).includes('bare-cr-terminator'));
  assert.equal(r.lines[0]!.terminator, 'cr');
});

test('a bare code with no text is recorded', () => {
  // §4.2 is self-contradictory here: prose says the text is required and calls
  // omitting it a violation; the ABNF says [ SP textstring ]. We record and let
  // the expectation layer decide — resolving it is not ours to do.
  const r = frame('250\r\n');
  assert.deepEqual(kinds(r), ['bare-code']);
  assert.equal(r.code, 250);
});

test('a code with a space but no text is distinguished from a bare code', () => {
  const r = frame('250 \r\n');
  assert.deepEqual(kinds(r), ['empty-text']);
  assert.equal(r.lines[0]!.separator, ' ');
});

test('an 8-bit octet in reply text is recorded', () => {
  // textstring = 1*(%d09 / %d32-126). This is where servers leak raw UTF-8
  // hostnames and unencoded local-parts.
  const r = frame(Buffer.from([0x32, 0x35, 0x30, 0x20, 0xc3, 0xa9, 0x0d, 0x0a]));
  assert.ok(kinds(r).includes('non-ascii-in-text'));
});

test('a NUL in reply text is recorded', () => {
  const r = frame(Buffer.from([0x32, 0x35, 0x30, 0x20, 0x41, 0x00, 0x42, 0x0d, 0x0a]));
  assert.ok(kinds(r).includes('non-ascii-in-text'));
});

test('HT is permitted in reply text', () => {
  // %d09 is explicitly allowed, which is easy to get wrong by testing >= 0x20.
  const r = frame(Buffer.from([0x32, 0x35, 0x30, 0x20, 0x41, 0x09, 0x42, 0x0d, 0x0a]));
  assert.deepEqual(kinds(r), []);
});

test('a mismatched continuation code is recorded', () => {
  const r = frame('250-first\r\n251-second\r\n250 last\r\n');
  assert.ok(kinds(r).includes('continuation-code-mismatch'));
});

test('a malformed separator ends the reply and is recorded', () => {
  const r = frame('250XOK\r\n');
  assert.ok(kinds(r).includes('malformed-separator'));
  assert.equal(r.lines.length, 1);
});

test('a four-digit code is code-not-three-digits, distinct from a bad second digit', () => {
  // §4.3.2-c forbids non-three-digit codes; the second-digit ABNF rule is a
  // different requirement. A digit after the 3 code bytes signals a 4+ digit
  // code and must be a distinct anomaly so the corpus can scope §4.3.2-c narrowly.
  const four = frame('2500 msg\r\n');
  assert.ok(kinds(four).includes('code-not-three-digits'));
  assert.ok(!kinds(four).includes('malformed-separator'), 'a digit is not a malformed separator');

  // A bad SECOND digit (260) is code-out-of-grammar, NOT code-not-three-digits —
  // it is a valid three-digit code that violates the ABNF, not §4.3.2-c.
  const second = frame('260 msg\r\n');
  assert.ok(kinds(second).includes('code-out-of-grammar'));
  assert.ok(!kinds(second).includes('code-not-three-digits'));
});

test('an over-long reply line is recorded against the 512-octet limit', () => {
  const pad = 'x'.repeat(MAX_REPLY_LINE); // well past 512 once code+CRLF added
  const r = frame(`250 ${pad}\r\n`);
  assert.ok(kinds(r).includes('reply-line-too-long'));
});

test('a reply line of exactly 512 octets including CRLF is not flagged', () => {
  // Boundary: §4.5.3.1.5 counts the CRLF within the 512.
  const text = 'x'.repeat(512 - 4 - 2);
  const line = `250 ${text}\r\n`;
  assert.equal(Buffer.byteLength(line), 512);
  assert.ok(!kinds(frame(line)).includes('reply-line-too-long'));
});

test('enhanced status codes are parsed when present', () => {
  const r = frame('250 2.1.0 Sender OK\r\n');
  assert.deepEqual(
    { class: r.enhanced?.class, subject: r.enhanced?.subject, detail: r.enhanced?.detail },
    { class: 2, subject: 1, detail: 0 },
  );
});

test('enhanced status parsing does not invent structure', () => {
  // A version number or a plain decimal in the text must not be mistaken for
  // an RFC 3463 code.
  assert.equal(frame('250 OK\r\n').enhanced, null);
  assert.equal(frame('220 mail.example.com ESMTP Postfix 3.7.2\r\n').enhanced, null);
  assert.equal(frame('250 1.2.3 bogus class\r\n').enhanced, null, 'class must be 2, 4 or 5');
  assert.equal(frame('250 2.1 short\r\n').enhanced, null, 'needs all three parts');
});

test('EHLO keywords are extracted, skipping the greeting line', () => {
  const r = frame(
    '250-mail.example.com greets you\r\n250-PIPELINING\r\n250-SIZE 10240000\r\n' +
      '250-starttls\r\n250 8BITMIME\r\n',
  );
  const kw = ehloKeywords(r);
  assert.ok(kw.has('PIPELINING'));
  assert.ok(kw.has('SIZE'));
  assert.ok(kw.has('STARTTLS'), 'keywords are case-insensitive per §2.4');
  assert.ok(kw.has('8BITMIME'));
  assert.ok(!kw.has('MAIL.EXAMPLE.COM'), 'the greeting line is not a keyword');
  assert.equal(kw.size, 4);
});

test('raw holds exactly the bytes consumed', () => {
  // The evidence of record. If this ever drifts, triage in task #23 is blind.
  const input = '250-a\r\n250 b\r\n';
  const r = frame(input);
  assert.deepEqual(r.raw, Buffer.from(input, 'latin1'));
});

test('the flood guard bounds an unterminated single line (buffered length, not offset)', () => {
  // Regression for the pressure-test finding: the guard tested consumed offset,
  // which stays 0 for a single never-terminated line, so it never fired. A
  // buffer over MAX_REPLY_BYTES with no terminator must throw.
  const flood = Buffer.alloc(MAX_REPLY_BYTES + 10, 0x78); // all 'x', no CRLF
  assert.throws(() => replyFramer(flood), ReplyTooLongError);
  // Just under the cap and unterminated: still incomplete, returns null.
  assert.equal(replyFramer(Buffer.alloc(100, 0x78)), null);
});

test('frameReplyAtEof surfaces a bare-CR-terminated final reply that normal framing leaves pending', () => {
  // Regression for the pressure-test finding: "250 OK\r" then FIN. The normal
  // framer waits for the next byte (CRLF or bare CR?) and returns null; at EOF
  // that byte never comes, so the reply — and its anomaly — would be dropped.
  const partial = Buffer.from('250 OK\r', 'latin1');
  assert.equal(replyFramer(partial), null, 'normal framer waits for more');
  const atEof = frameReplyAtEof(partial);
  assert.ok(atEof !== null, 'EOF framer produces the reply');
  assert.equal(atEof.value.code, 250);
  assert.ok(
    atEof.value.anomalies.some((a) => a.kind === 'bare-cr-terminator'),
    'the bare-cr-terminator anomaly is observed, not dropped',
  );
});

test('frameReplyAtEof still returns null on genuinely empty input', () => {
  assert.equal(frameReplyAtEof(Buffer.alloc(0)), null);
});

test('a multiline reply mixing CRLF and bare LF flags only the offending line', () => {
  const r = frame('250-ok\r\n250-bad\n250 fine\r\n');
  const lf = r.anomalies.filter((a) => a.kind === 'bare-lf-terminator');
  assert.equal(lf.length, 1);
  assert.equal(lf[0]!.line, 1, 'anomaly must point at the line that caused it');
});
