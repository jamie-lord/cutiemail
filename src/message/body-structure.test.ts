/**
 * BODYSTRUCTURE / BODY construction (RFC 9051 §7.5.2), built on the tested MIME split.
 * Covers the shapes a client actually renders from: a single text part, a multipart
 * with an attachment (the name/filename a client shows), a nested multipart, and the
 * default when Content-Type is absent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyResponse, bodyStructureResponse, resolvePart, buildBodyStructure } from './body-structure.ts';
import { parseMessage } from './parse.ts';
import { messageRequirement, type MessageRequirementId } from '../register/message/index.ts';
import { imapRequirement, type ImapRequirementId } from '../register/imap/index.ts';

const msg = (s: string): Buffer => Buffer.from(s.replace(/\n/g, '\r\n'), 'latin1');
// One `cites` for both registers (the coverage scanner keys on the literal `cites('R-...')`):
// message-format ids resolve against the message register, IMAP ids (R-9051-*) against the IMAP one.
const cites = (id: MessageRequirementId | ImapRequirementId): void => {
  const found = id.startsWith('R-9051-') ? imapRequirement(id as ImapRequirementId) : messageRequirement(id as MessageRequirementId);
  assert.ok(found.id === id);
};
/** The body FETCH BODY[<numeric section>] serves for an entity (its bytes after the blank line). */
const sectionBody = (raw: Buffer, path: number[]): string | null => {
  const e = resolvePart(raw, path);
  return e === null ? null : parseMessage(e).body.toString('latin1');
};

test('a single text/plain part reports type, params, encoding, size and line count', () => {
  const b = bodyStructureResponse(msg('Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: 7bit\n\nHello\nWorld\n'));
  assert.match(b, /^\("TEXT" "PLAIN" \("charset" "utf-8"\) NIL NIL "7BIT" \d+ 2 /, 'text part with 2 lines');
});

test('an absent Content-Type defaults to text/plain (RFC 2045 §5.2)', () => {
  const b = bodyStructureResponse(msg('Subject: bare\n\njust text\n'));
  assert.match(b, /^\("TEXT" "PLAIN"/, 'the default media type is text/plain');
});

test('R-2046-5.1-a: a header-less part in a multipart/digest defaults to message/rfc822, not text/plain', () => {
  cites('R-2046-5.1-a');
  // The part carries no Content-Type. In a digest it is an encapsulated message (§5.1.5), so it must
  // be reported as MESSAGE/RFC822 with an ENVELOPE — not the TEXT/PLAIN a mixed part would default to.
  const part = '--D\n\nFrom: inner@example.test\nSubject: forwarded\n\ninner body\n';
  const digest = bodyStructureResponse(msg(`Content-Type: multipart/digest; boundary="D"\n\n${part}--D--\n`));
  assert.match(digest, /"MESSAGE" "RFC822"/, 'the header-less digest part is message/rfc822');
  assert.match(digest, /"forwarded"/, 'and its ENVELOPE (subject) is carried, proving it was recursed as a message');
  // Negative control: the identical header-less part in a multipart/mixed keeps the text/plain
  // default, so the change is the digest context and not the part itself.
  const mixed = bodyStructureResponse(msg(`Content-Type: multipart/mixed; boundary="D"\n\n${part}--D--\n`));
  assert.match(mixed, /"TEXT" "PLAIN"/, 'the same part in multipart/mixed defaults to text/plain');
  assert.doesNotMatch(mixed, /"MESSAGE" "RFC822"/, 'and is NOT treated as an encapsulated message');
});

test('resolvePart navigates message/rfc822 sub-parts the way BODYSTRUCTURE advertises them (§6.4.5)', () => {
  cites('R-9051-6.4.5-c');
  // The differential this closes: BODYSTRUCTURE advertises a message/rfc822 part's encapsulated
  // sub-parts (n.1, n.2), but resolvePart used to treat message/rfc822 as an opaque leaf — so
  // FETCH BODY[n.1] returned the WHOLE encapsulated message and BODY[n.2] an empty literal, the
  // bytes disagreeing with the structure. RFC 9051 §6.4.5: a MESSAGE/RFC822 adds no numbering
  // level, so BODY[n.1] is the first part of the encapsulated message.

  // (a) A header-less multipart/digest member (RFC 2046 §5.1.5 — the leading blank line makes it
  //     header-less, exactly the RFC 2046 digest example's shape) encapsulating a multipart/mixed.
  const digest = msg(
    'Content-Type: multipart/digest; boundary=D\n\n--D\n\n' +
      'From: alice@one.example\nSubject: report\nContent-Type: multipart/mixed; boundary=E\n\n' +
      '--E\nContent-Type: text/plain\n\nAAAA\n--E\nContent-Type: application/x-danger\n\nBBBBBBBBBBBBBBBB\n--E--\n--D--\n',
  );
  const digestStruct = bodyStructureResponse(digest);
  assert.match(digestStruct, /"MESSAGE" "RFC822".*"TEXT" "PLAIN"[^)]* 4 1.*"APPLICATION" "X-DANGER"[^)]* 16/, 'structure advertises 1.1 (4 bytes) and 1.2 (16 bytes)');
  assert.equal(sectionBody(digest, [1, 1]), 'AAAA', 'BODY[1.1] is the advertised 4-byte text/plain, not the whole message');
  assert.equal(sectionBody(digest, [1, 2]), 'BBBBBBBBBBBBBBBB', 'BODY[1.2] is the advertised 16-byte part, not empty');

  // (b) An EXPLICIT message/rfc822 part encapsulating a single text/plain: BODY[1.1] is the
  //     encapsulated body (the collapse holds for single-part encapsulated messages too).
  const explicit = msg(
    'Content-Type: multipart/mixed; boundary=B\n\n--B\nContent-Type: message/rfc822\n\n' +
      'From: x@inner.example\nSubject: s\n\ninner body\n--B--\n',
  );
  assert.match(bodyStructureResponse(explicit), /"MESSAGE" "RFC822"/, 'part 1 is message/rfc822');
  assert.equal(sectionBody(explicit, [1, 1]), 'inner body', 'BODY[1.1] is the encapsulated body');
  // And BODY[1] is the whole encapsulated message (a message/rfc822 part is addressable itself).
  assert.match(sectionBody(explicit, [1]) ?? '', /^From: x@inner\.example/, 'BODY[1] is the encapsulated message');
});

test('a multipart with an attachment exposes the filename and disposition', () => {
  const raw = msg(
    'Content-Type: multipart/mixed; boundary="B"\n\n' +
      '--B\nContent-Type: text/plain\n\nthe message\n' +
      '--B\nContent-Type: application/pdf; name="report.pdf"\nContent-Transfer-Encoding: base64\nContent-Disposition: attachment; filename="report.pdf"\n\nJVBERi0K\n' +
      '--B--\n',
  );
  const bs = bodyStructureResponse(raw);
  // Two children then the subtype, then the multipart params.
  assert.match(bs, /"MIXED" \("boundary" "B"\)/, 'the multipart subtype and boundary are reported');
  assert.match(bs, /"APPLICATION" "PDF" \("name" "report\.pdf"\)/, 'the attachment media type and name');
  assert.match(bs, /"BASE64" \d+ NIL \("attachment" \("filename" "report\.pdf"\)\)/, 'the transfer encoding and disposition with filename');
  // The basic BODY form omits the disposition/extension fields.
  const body = bodyResponse(raw);
  assert.match(body, /\("TEXT" "PLAIN" NIL NIL NIL "7BIT" \d+ \d+\)\("APPLICATION" "PDF"/, 'BODY lists both parts without extension fields');
  assert.doesNotMatch(body, /attachment/, 'BODY (non-extensible) omits the disposition');
});

test('a nested multipart/alternative inside multipart/mixed recurses', () => {
  const raw = msg(
    'Content-Type: multipart/mixed; boundary="OUT"\n\n' +
      '--OUT\nContent-Type: multipart/alternative; boundary="IN"\n\n' +
      '--IN\nContent-Type: text/plain\n\nplain\n' +
      '--IN\nContent-Type: text/html\n\n<p>html</p>\n' +
      '--IN--\n' +
      '--OUT\nContent-Type: image/png; name="pic.png"\nContent-Transfer-Encoding: base64\n\niVBOR\n' +
      '--OUT--\n',
  );
  const bs = bodyStructureResponse(raw);
  assert.match(bs, /"ALTERNATIVE"/, 'the inner multipart/alternative is present');
  assert.match(bs, /"TEXT" "PLAIN".*"TEXT" "HTML"/s, 'both alternatives are nested inside it');
  assert.match(bs, /"IMAGE" "PNG" \("name" "pic\.png"\)/, 'the sibling image part is present');
  assert.match(bs, /"MIXED"/, 'the outer container is multipart/mixed');
});

test('a message/rfc822 attachment carries the forwarded message envelope and structure', () => {
  const inner = 'From: orig@sender.test\r\nTo: me@x.test\r\nSubject: forwarded subject\r\nDate: Wed, 01 Jan 2025 10:00:00 +0000\r\n\r\nforwarded body\r\n';
  const raw = Buffer.from(
    'Content-Type: multipart/mixed; boundary=B\r\n\r\n' +
      '--B\r\nContent-Type: text/plain\r\n\r\nsee forwarded\r\n' +
      '--B\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment\r\n\r\n' +
      inner +
      '--B--\r\n',
    'latin1',
  );
  const bs = bodyStructureResponse(raw);
  assert.match(bs, /"MESSAGE" "RFC822"/, 'the forwarded part is message/rfc822');
  // The nested ENVELOPE exposes the forwarded subject/sender without a download.
  assert.match(bs, /"forwarded subject"/, "the forwarded message's subject is in the nested envelope");
  assert.match(bs, /"orig" "sender\.test"/, 'the forwarded sender is present');
  // The nested body structure follows the envelope.
  assert.match(bs, /"MESSAGE" "RFC822".*"forwarded subject".*"TEXT" "PLAIN"/s, 'the nested body structure follows the envelope');
});

test('a multipart whose boundary matches no parts yields a valid leaf, not an empty multipart', () => {
  // RFC 9051 body-type-mpart requires >= 1 nested body; "("MIXED" ...)" (no leading
  // nested body) desyncs a strict client's FETCH parse. A boundary that matches nothing
  // must degrade to a single leaf.
  const bs = bodyStructureResponse(msg('Content-Type: multipart/mixed; boundary=NOPE\n\njust text, no boundary here\n'));
  assert.ok(bs.startsWith('("TEXT" "PLAIN"'), 'the empty multipart is reported as a text leaf, a valid structure');
  assert.doesNotMatch(bs, /^\(\s*"MIXED"/, 'never an empty multipart with a string where a nested body is required');
});

test('a NUL or control octet in a header/filename is not emitted raw in a quoted string', () => {
  // A raw NUL is illegal in an IMAP quoted string and desyncs a strict FETCH parser.
  const raw = msg('Content-Type: application/octet-stream; name="ev\x00il.exe"\nContent-Transfer-Encoding: base64\n\nAAAA\n');
  const bs = bodyStructureResponse(raw);
  assert.ok(!bs.includes('\x00'), 'no raw NUL survives into the BODYSTRUCTURE');
  assert.match(bs, /"ev il\.exe"/, 'the control octet was collapsed to a space');
});

test('a bogus non-transparent CTE on a multipart is not copied onto the MULTIPART node (RFC 2045 §6.4)', () => {
  // base64 on a multipart is EXPRESSLY FORBIDDEN (composite types only carry 7bit/8bit/binary).
  // The emitted MULTIPART node must default to a transparent encoding, never the bogus label.
  const raw = msg('Content-Type: multipart/mixed; boundary=B\nContent-Transfer-Encoding: base64\n\n--B\nContent-Type: text/plain\n\nhi\n--B--\n');
  const node = buildBodyStructure(raw);
  assert.ok(node.multipart, 'the container is a multipart node');
  assert.equal(node.encoding, '7BIT', 'the forbidden base64 is not copied onto the composite node');
  // A legitimate transparent encoding IS preserved.
  const raw8 = msg('Content-Type: multipart/mixed; boundary=B\nContent-Transfer-Encoding: 8bit\n\n--B\nContent-Type: text/plain\n\nhi\n--B--\n');
  assert.equal(buildBodyStructure(raw8).encoding, '8BIT', 'a transparent 8bit label is kept');
});

test('a pathologically deep multipart is bounded, not a stack overflow (DoS guard)', () => {
  let m = 'Content-Type: text/plain\r\n\r\nleaf\r\n';
  for (let i = 0; i < 5000; i++) {
    const b = `B${i}`;
    m = `Content-Type: multipart/mixed; boundary=${b}\r\n\r\n--${b}\r\n${m}--${b}--\r\n`;
  }
  // Must return a value (bounded at the depth cap), never throw a RangeError.
  const bs = bodyStructureResponse(Buffer.from(m, 'latin1'));
  assert.ok(bs.length > 0 && bs.startsWith('('), 'a deeply nested message yields a bounded structure, not a crash');
});

test('a deep message/rfc822 chain is bounded by the depth cap, not a stack overflow', () => {
  // Distinct from the multipart nesting bomb: buildBodyStructure ALSO recurses through the
  // message/rfc822 branch (encapsulated ENVELOPE + nested structure). MAX_MIME_DEPTH guards
  // that recursion too; a 250-deep chain must engage the cap, never overflow the stack, and
  // still serialise to balanced IMAP output.
  let m = 'Content-Type: text/plain\r\n\r\nleaf\r\n';
  for (let i = 0; i < 250; i++) {
    m = `Content-Type: message/rfc822\r\n\r\n${m}`;
  }
  const raw = Buffer.from(m, 'latin1');
  const bs = bodyStructureResponse(raw); // must not throw a RangeError
  assert.ok(bs.startsWith('(') && bs.length > 0, 'a deep message/rfc822 chain yields a bounded structure');
  // The output parens are balanced (no desync from the truncated-at-cap recursion).
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < bs.length; i++) {
    const ch = bs[i];
    if (inQuote) {
      if (ch === '\\') i++;
      else if (ch === '"') inQuote = false;
    } else if (ch === '"') inQuote = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    assert.ok(depth >= 0, 'never an unbalanced close paren');
  }
  assert.equal(depth, 0, 'the deep message/rfc822 structure has balanced parentheses');
  // The basic BODY form is likewise bounded and balanced.
  assert.ok(bodyResponse(raw).startsWith('('), 'BODY form is also bounded');
});

test('BODYSTRUCTURE and resolvePart never crash on fuzzed / malformed MIME', () => {
  // Deterministic mulberry32 PRNG (no Math.random) so a failure reproduces.
  let a = 0xb0d5 >>> 0;
  const rng = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const frags = [
    'Content-Type: multipart/mixed; boundary=B\r\n', 'Content-Type: text/plain\r\n', 'Content-Type: ///\r\n',
    'Content-Type: message/rfc822\r\n', 'Content-Transfer-Encoding: base64\r\n', 'Content-Disposition: attachment; filename=\r\n',
    '--B\r\n', '--B--\r\n', '--\r\n', '\r\n', 'body bytes\r\n', 'boundary=', 'name="x"', String.fromCharCode(0), 'x'.repeat(50),
  ];
  for (let i = 0; i < 800; i++) {
    let raw = '';
    const n = 1 + Math.floor(rng() * 20);
    for (let j = 0; j < n; j++) raw += frags[Math.floor(rng() * frags.length)]!;
    const buf = Buffer.from(raw, 'latin1');
    // None of these must throw; the structure must serialise to a parenthesised value.
    const bs = bodyStructureResponse(buf);
    assert.ok(bs.startsWith('('), `structure must be a parenthesised value for input #${i}`);
    bodyResponse(buf);
    resolvePart(buf, [1]);
    resolvePart(buf, [1, 2, 1]);
  }
});

test('FETCH BODYSTRUCTURE is bounded on a deeply nested message/rfc822 chain (depth×payload DoS)', () => {
  // 100 nested message/rfc822 wrappers around a large payload would re-parse the payload at every
  // level — an unbounded per-FETCH CPU DoS. The cumulative-byte budget bounds it.
  const payload = 'X'.repeat(4 * 1024 * 1024);
  let m = `Content-Type: text/plain\r\n\r\n${payload}`;
  for (let i = 0; i < 100; i++) m = `Content-Type: message/rfc822\r\n\r\n${m}`;
  const start = process.hrtime.bigint();
  const out = bodyStructureResponse(Buffer.from(m, 'latin1'));
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(out.length > 0, 'a bounded structure is still produced');

  // Assert the SHAPE the budget produces, not the clock. The cumulative-byte budget stops the
  // descent partway and emits an opaque stub, so a bounded run reports far fewer message/rfc822
  // levels than the 100 that were nested — 31 with the current budget and payload. That is
  // deterministic; elapsed time is not, and this file runs in a parallel suite where a threshold
  // sized to an idle machine flakes. (Measured: bounded ~1.7s producing 31 levels, budget removed
  // ~5.3s producing all 100 — so this assertion catches the defect the timing one was aiming at,
  // and catches it whatever the machine is doing.)
  const levels = (out.match(/MESSAGE" "RFC822/g) ?? []).length;
  assert.ok(levels > 0, 'the chain is walked at all');
  assert.ok(levels < 60, `the descent must stop partway, not walk all 100 levels (saw ${levels})`);

  // A generous backstop against a genuinely super-linear blow-up, not a performance target.
  assert.ok(ms < 30_000, `a deep nested-message chain must be bounded (took ${ms.toFixed(0)}ms)`);
});

test('FETCH BODYSTRUCTURE is bounded on a multipart with millions of parts (part-count DoS)', () => {
  // Millions of "--X" delimiters would materialise millions of part Buffers. MAX_PARTS_PER_ENTITY
  // (via parseMultipart's maxParts) bounds the split, so both memory and CPU stay bounded.
  const body = '--X\r\n'.repeat(3_000_000);
  const raw = Buffer.from(`Content-Type: multipart/mixed; boundary="X"\r\n\r\n${body}`, 'latin1');
  const start = process.hrtime.bigint();
  const out = bodyStructureResponse(raw);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.match(out, /"MIXED"/, 'a bounded multipart structure is still produced');
  // The SHAPE the cap produces, not the clock: three million delimiters were fed in and at most
  // MAX_PARTS_PER_ENTITY (10,000) parts may come out. That is deterministic on any machine, where a
  // millisecond threshold sized to an idle one flakes in a parallel suite — as the neighbouring
  // case above already records.
  const parts = (out.match(/\("TEXT"/g) ?? []).length;
  assert.ok(parts > 0, 'the multipart is walked at all');
  // Three million delimiters in, at most 10,001 parts out: MAX_PARTS_PER_ENTITY is 10,000 and the
  // scan collects the one that trips the cap before stopping, whose part then absorbs the rest of
  // the body. Bounded by a constant, not proportional to the input — which is the whole property.
  assert.ok(parts <= 10_001, `the part count is capped, not proportional to the 3,000,000 delimiters fed in (saw ${parts})`);
  // A generous backstop against a genuinely super-linear blow-up, not a performance target.
  assert.ok(ms < 30_000, `a million-part multipart must be bounded (took ${ms.toFixed(0)}ms)`);
});

test('resolvePart is bounded on a deep nested-multipart path (FETCH BODY[1.1.1...] DoS)', () => {
  // resolvePart re-parses a near-full payload at each nesting level; a deep path would otherwise be
  // a depth×payload CPU DoS. The cumulative-byte budget bounds it (returns null past the budget).
  const payload = 'Z'.repeat(4 * 1024 * 1024);
  let m = `Content-Type: text/plain\r\n\r\n${payload}`;
  for (let i = 0; i < 99; i++) m = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${m}\r\n--b${i}--\r\n`;
  const start = process.hrtime.bigint();
  const resolved = resolvePart(Buffer.from(m, 'latin1'), new Array(99).fill(1));
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  // What the budget DOES, which the timing-only form never asserted: past it, resolvePart gives up
  // and returns null rather than descending. A machine under load changes how long that takes and
  // not whether it happens.
  assert.equal(resolved, null, 'the descent stops at the budget instead of walking 99 levels');
  // And the shallow path still resolves, so the assertion above is the budget biting rather than
  // resolvePart failing at everything.
  assert.notEqual(resolvePart(Buffer.from(m, 'latin1'), [1]), null, 'a shallow path still resolves');
  // A generous backstop against a genuinely super-linear blow-up, not a performance target.
  assert.ok(ms < 30_000, `a deep BODY[] path must be bounded (took ${ms.toFixed(0)}ms)`);
});
