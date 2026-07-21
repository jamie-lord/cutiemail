/**
 * The external-shaped MIME torture corpus, run through the LIVE parse + serialize
 * path. Where fuzz.test.ts throws random bytes at the parsers and torture.test.ts
 * runs a small inline curated set through the serializers, this runs a vendored
 * corpus of real-world-SHAPED messages (see ./fixtures/index.ts for provenance and
 * why each is interesting) and asserts a DEFINED outcome for every one.
 *
 * The corpus invariant, across the whole set:
 *   - parseMessage never throws and returns a Message (no crash, no hang);
 *   - ENVELOPE, BODYSTRUCTURE and BODY are always well-formed IMAP (framing-safe:
 *     no bare CR/LF, no C0/DEL control octet, balanced parens and quotes);
 *   - no bytes-vs-strings corruption (a raw NUL never reaches the wire).
 *
 * Beyond the blanket invariant, each block below pins the OPINIONATED outcome for
 * a class of message and COMMENTS why cutiemail decides it that way — a rejection
 * or a scope cut here is an intended, recorded decision, not a silent failure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { parseMessage, hasHeader, hasAnomaly } from './parse.ts';
import type { Message } from './model.ts';
import { analyzeMime, hasMimeAnomaly } from './mime.ts';
import { parseMultipart } from './multipart.ts';
import { decodeEncodedWords } from './encoded-word.ts';
import { buildEnvelope, serializeEnvelope } from '../imap/envelope.ts';
import { bodyStructureResponse, bodyResponse } from './body-structure.ts';
import { loadCorpus, loadFixture, FIXTURE_NAMES } from './fixtures/index.ts';

/**
 * Assert a fragment is safe to place in an IMAP response stream — the same
 * framing invariant torture.test.ts enforces: no bare CR/LF or other C0/DEL
 * control octet (which desyncs the stream), and balanced parens and double quotes.
 * (Our builders emit only quoted strings, NIL and atoms — never literals — so a
 * plain quote/paren balance check is exact.)
 *
 * NOTE ON 8-BIT: this deliberately tolerates octets >= 0x80. cutiemail is an
 * EAI/SMTPUTF8-era server: raw UTF-8 in a header is passed through, not mangled.
 * The framing-critical octets are C0 (0x00-0x1f) and DEL (0x7f), which the
 * serializers DO strip; those are what this checker pins.
 */
function assertWellFormedImap(fragment: string, label: string): void {
  for (let i = 0; i < fragment.length; i++) {
    const c = fragment.charCodeAt(i);
    assert.ok(c !== 0x0d && c !== 0x0a, `${label}: bare CR/LF at ${i} would desync the stream: ${JSON.stringify(fragment)}`);
    assert.ok(c >= 0x20 && c !== 0x7f, `${label}: control octet 0x${c.toString(16)} at ${i}: ${JSON.stringify(fragment)}`);
  }
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i];
    if (inQuote) {
      if (ch === '\\') i++;
      else if (ch === '"') inQuote = false;
    } else if (ch === '"') inQuote = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      assert.ok(depth >= 0, `${label}: unbalanced ')' : ${JSON.stringify(fragment)}`);
    }
  }
  assert.equal(depth, 0, `${label}: unbalanced parentheses: ${JSON.stringify(fragment)}`);
  assert.ok(!inQuote, `${label}: unterminated quoted string: ${JSON.stringify(fragment)}`);
}

/** Header value (first, latin1, unfolded-lite) — a small test convenience. */
function headerValue(msg: Message, name: string): string | null {
  const lower = name.toLowerCase();
  for (const h of msg.headers) {
    if (h.name.toString('latin1').trim().toLowerCase() === lower) {
      return h.value.toString('latin1').replace(/\r\n(?=[ \t])/g, '');
    }
  }
  return null;
}

// ── The corpus loads, and every fixture on disk is accounted for ────────────────

test('the corpus loads byte-exact and every fixture has recorded provenance', () => {
  const corpus = loadCorpus();
  assert.ok(corpus.length >= 30, `a meaningful corpus size: ${corpus.length}`);
  assert.equal(corpus.length, FIXTURE_NAMES.length, 'one loaded fixture per metadata entry');
  for (const f of corpus) {
    assert.ok(f.raw.length > 0, `${f.name}: non-empty bytes`);
    assert.ok(f.meta.why.length > 20, `${f.name}: has a WHY`);
    assert.ok(f.meta.modeledOn.length > 0, `${f.name}: names the pattern it derives from`);
  }
});

test('every .eml file on disk has a metadata entry (no undocumented fixtures)', () => {
  // Read the directory and confirm it matches the metadata keys exactly, so a
  // fixture can never be dropped in without recording why it exists.
  const dirUrl = new URL('./fixtures/', import.meta.url);
  const onDisk = readdirSync(dirUrl).filter((n) => n.endsWith('.eml')).sort();
  assert.deepEqual(onDisk, [...FIXTURE_NAMES], 'the .eml files and the metadata table are in lockstep');
});

// ── The blanket invariant: no crash, always well-formed IMAP ────────────────────

test('BLANKET INVARIANT: every fixture parses and serializes to well-formed IMAP', () => {
  for (const { name, raw } of loadCorpus()) {
    // parseMessage must not throw and must return a Message shape.
    let msg: Message;
    assert.doesNotThrow(() => {
      msg = parseMessage(raw);
    }, `${name}: parseMessage must not throw`);
    msg = parseMessage(raw);
    assert.ok(Array.isArray(msg.headers) && Buffer.isBuffer(msg.body) && Array.isArray(msg.anomalies), `${name}: Message shape`);

    // ENVELOPE.
    const env = serializeEnvelope(buildEnvelope(msg.headers));
    assertWellFormedImap(env, `ENVELOPE[${name}]`);
    assert.ok(env.startsWith('(') && env.endsWith(')'), `${name}: ENVELOPE is a parenthesised list`);

    // BODYSTRUCTURE (extended) and BODY (basic) — both from the raw bytes.
    const bs = bodyStructureResponse(raw);
    assertWellFormedImap(bs, `BODYSTRUCTURE[${name}]`);
    assert.ok(bs.startsWith('(') && bs.endsWith(')'), `${name}: BODYSTRUCTURE is a parenthesised list`);
    const bo = bodyResponse(raw);
    assertWellFormedImap(bo, `BODY[${name}]`);
    assert.ok(bo.startsWith('(') && bo.endsWith(')'), `${name}: BODY is a parenthesised list`);
  }
});

test('BLANKET INVARIANT: no raw NUL or C0/DEL control ever reaches the wire', () => {
  // A bytes-vs-strings regression (a NUL from a crafted header/filename surviving
  // into a quoted string) is exactly the corruption this corpus exists to catch.
  for (const { name, raw } of loadCorpus()) {
    const msg = parseMessage(raw);
    const outputs = [serializeEnvelope(buildEnvelope(msg.headers)), bodyStructureResponse(raw), bodyResponse(raw)];
    for (const out of outputs) {
      for (let i = 0; i < out.length; i++) {
        const c = out.charCodeAt(i);
        assert.ok(!(c < 0x20) && c !== 0x7f, `${name}: control 0x${c.toString(16)} leaked to the wire`);
      }
    }
  }
});

// ── Opinionated, per-class outcomes (asserted AND commented as intended) ─────────

test('nesting: a within-cap deep multipart recurses to a balanced structure', () => {
  const bs = bodyStructureResponse(loadFixture('deeply-nested-16.eml').raw);
  assertWellFormedImap(bs, 'deeply-nested-16');
  // 16 real container levels means at least 16 opening parens before the core leaf.
  assert.ok(bs.startsWith('('.repeat(16)), 'the 16 nested containers each open a sublist');
  assert.ok(bs.includes('the deep core'.length.toString()), 'the innermost leaf size is reported');
});

test('nesting: a message past MAX_MIME_DEPTH engages the DoS cap, no stack overflow', () => {
  const raw = loadFixture('deeply-nested-past-cap.eml').raw;
  // The whole point: 250 levels must NOT recurse the serializer into a crash.
  let bs = '';
  assert.doesNotThrow(() => {
    bs = bodyStructureResponse(raw);
  }, 'a 250-deep nesting bomb must not overflow the stack');
  assertWellFormedImap(bs, 'deeply-nested-past-cap');
  // Past the cap the part is reported as an opaque octet-stream leaf, not recursed.
  assert.ok(bs.includes('OCTET-STREAM'), 'the depth cap reports an opaque leaf');
});

test('rfc822: a forwarded message/rfc822 carries a nested ENVELOPE + BODYSTRUCTURE', () => {
  const raw = loadFixture('message-rfc822-forward.eml').raw;
  const bs = bodyStructureResponse(raw);
  assertWellFormedImap(bs, 'message-rfc822-forward');
  assert.ok(bs.includes('"MESSAGE" "RFC822"'), 'the forwarded part is typed message/rfc822');
  // The inner message has a "Last, First" quoted display name — a literal comma
  // inside quotes must NOT be split into two bogus addresses.
  assert.ok(bs.includes('"Inner, Person"'), 'the inner comma-in-quotes display name survives intact');
});

test('rfc2047: adjacent encoded-words concatenate with inter-word whitespace dropped', () => {
  const raw = loadFixture('rfc2047-adjacent-words.eml').raw;
  const subj = headerValue(parseMessage(raw), 'Subject')!;
  const dec = decodeEncodedWords(Buffer.from(subj, 'latin1'));
  assert.equal(dec.text.toString('latin1').trim(), 'If you can read this you understand the example.');
});

test('rfc2047: a token with internal whitespace stays LITERAL (never silently decoded)', () => {
  const raw = loadFixture('rfc2047-internal-whitespace.eml').raw;
  const subj = headerValue(parseMessage(raw), 'Subject')!;
  const dec = decodeEncodedWords(Buffer.from(subj, 'latin1'));
  assert.ok(dec.anomalies.includes('internal-whitespace'), 'the malformed token is flagged');
  // Left literal — the "=?...?=" is still present in the output, not decoded away.
  assert.ok(dec.text.toString('latin1').includes('=?UTF-8?Q?not valid?='), 'the malformed token passes through literally');
});

test('rfc2047: an overlong encoded-word is flagged but does not crash', () => {
  const raw = loadFixture('rfc2047-overlong-word.eml').raw;
  const subj = headerValue(parseMessage(raw), 'Subject')!;
  const dec = decodeEncodedWords(Buffer.from(subj, 'latin1'));
  assert.ok(dec.anomalies.includes('overlong-word'), 'the >75-char word is flagged');
});

test('rfc2047: encoded-words are NOT decoded inside ENVELOPE (decoding is a separate layer)', () => {
  // ENVELOPE must carry the raw header bytes; decoding RFC 2047 is an explicit later
  // step, so a display-name encoded-word appears verbatim in the address structure.
  const raw = loadFixture('rfc2047-display-name-comma.eml').raw;
  const env = serializeEnvelope(buildEnvelope(parseMessage(raw).headers));
  assertWellFormedImap(env, 'rfc2047-display-name-comma');
  assert.ok(env.includes('=?UTF-8?Q?Do=C3=AB=2C_John?='), 'the encoded display-name is preserved verbatim');
  // Two To addresses (the encoded one + plain@z.test) — the =2C comma inside the
  // encoded word must not have split the first address in two.
  assert.ok(env.includes('"john" "x.test"') && env.includes('"jane" "y.test"') && env.includes('"plain" "z.test"'), 'addresses split correctly, not on the encoded comma');
});

test('rfc2231: a parameter continuation is NOT reassembled (a recorded scope cut) but is well-formed', () => {
  // cutiemail does not implement RFC 2231 continuation reassembly. The DEFINED
  // outcome: name*0 / name*1 are treated as ordinary (unrecognised) parameters and
  // the emitted BODYSTRUCTURE stays balanced — no crash, no malformed output.
  for (const name of ['rfc2231-continuation.eml', 'rfc2231-charset-lang.eml']) {
    const bs = bodyStructureResponse(loadFixture(name).raw);
    assertWellFormedImap(bs, name);
  }
});

test('boundaries: regex-metacharacter and overlong boundaries match literally', () => {
  const metaBs = bodyStructureResponse(loadFixture('boundary-metachars.eml').raw);
  assertWellFormedImap(metaBs, 'boundary-metachars');
  assert.ok(metaBs.startsWith('(('), 'the metachar boundary split a real child part');

  // An overlong (>70-char) boundary is flagged at the multipart layer but still splits.
  const over = loadFixture('overlong-boundary.eml');
  const body = parseMessage(over.raw).body;
  const res = parseMultipart(body, '_'.repeat(80));
  assert.ok(res.anomalies.includes('overlong-boundary'), 'the >70-char boundary is flagged');
  assert.equal(res.parts.length, 1, 'yet the part is still split out');
});

test('boundaries: a missing terminal delimiter still splits parts (flagged not-closed)', () => {
  const raw = loadFixture('missing-terminal-boundary.eml').raw;
  const res = parseMultipart(parseMessage(raw).body, 'B');
  assert.equal(res.parts.length, 2, 'both parts recovered despite no closing --B--');
  assert.equal(res.closed, false, 'the container is recorded as not closed');
  assert.ok(res.anomalies.includes('no-closing-delimiter'), 'the missing terminal boundary is flagged');
  assertWellFormedImap(bodyStructureResponse(raw), 'missing-terminal-boundary');
});

test('boundaries: a multipart whose boundary never appears is a text/plain leaf, not a childless MULTIPART', () => {
  // Emitting a childless `("MIXED" …)` would put a string where RFC 9051 requires a
  // nested body, desyncing a strict client. cutiemail falls back to a text/plain leaf.
  const bs = bodyStructureResponse(loadFixture('multipart-zero-parts.eml').raw);
  assertWellFormedImap(bs, 'multipart-zero-parts');
  assert.ok(bs.startsWith('("TEXT" "PLAIN"'), 'reported as a single leaf, not an empty multipart');
});

test('boundaries: preamble/epilogue that merely resemble a delimiter are discarded', () => {
  const res = parseMultipart(parseMessage(loadFixture('boundary-in-preamble.eml').raw).body, 'sep');
  assert.equal(res.parts.length, 1, 'only the real --sep part counts');
  assert.ok(res.preamble.toString('latin1').includes('--sep-ish'), 'the near-miss stays in the preamble');
});

test('line endings: a bare-LF blank line is NOT the header/body separator (anti-smuggling)', () => {
  // Opinionated (R-5322-2.1-b): only a CRLF empty line separates headers from body.
  // An LF-only message therefore has no separator — recorded, not silently split.
  const msg = parseMessage(loadFixture('bare-lf-endings.eml').raw);
  assert.ok(hasAnomaly(msg, 'bare-lf'), 'bare-LF endings are recorded');
  assert.ok(hasAnomaly(msg, 'no-empty-line'), 'no CRLF separator ⇒ no header/body split');
  assert.equal(msg.body.length, 0, 'nothing escapes into the body');
});

test('line endings: bare-CR-only (classic Mac) endings are recorded, not treated as terminators', () => {
  const msg = parseMessage(loadFixture('bare-cr-endings.eml').raw);
  assert.ok(hasAnomaly(msg, 'bare-cr'), 'bare-CR endings are recorded');
  assert.ok(hasAnomaly(msg, 'no-empty-line'), 'a lone CR is not a line terminator for the split');
  // The serializers must still be safe on this shape.
  assertWellFormedImap(serializeEnvelope(buildEnvelope(msg.headers)), 'bare-cr ENVELOPE');
});

test('line endings: a message mixing CRLF/LF/CR records both bare-lf and bare-cr and never crashes', () => {
  const msg = parseMessage(loadFixture('mixed-endings.eml').raw);
  assert.ok(hasAnomaly(msg, 'bare-lf') && hasAnomaly(msg, 'bare-cr'), 'both stray terminators are recorded');
  assertWellFormedImap(bodyStructureResponse(loadFixture('mixed-endings.eml').raw), 'mixed-endings');
});

test('octets: NUL in a header/body is recorded and STRIPPED from the wire', () => {
  const raw = loadFixture('nul-in-header-and-body.eml').raw;
  const msg = parseMessage(raw);
  assert.ok(hasAnomaly(msg, 'nul-octet'), 'the NUL is recorded as an anomaly');
  const env = serializeEnvelope(buildEnvelope(msg.headers));
  assert.ok(!env.includes('\x00'), 'no raw NUL survives into the ENVELOPE');
  assertWellFormedImap(env, 'nul ENVELOPE');
});

test('octets: raw 8-bit headers are recorded, preserved byte-exact, and pass through the serializer', () => {
  for (const name of ['8bit-headers-utf8.eml', '8bit-headers-latin1.eml']) {
    const raw = loadFixture(name).raw;
    const msg = parseMessage(raw);
    assert.ok(hasAnomaly(msg, 'eight-bit'), `${name}: the 8-bit octet is recorded`);
    // EAI-era decision: 8-bit passes through; only framing octets are stripped.
    assertWellFormedImap(serializeEnvelope(buildEnvelope(msg.headers)), `${name} ENVELOPE`);
  }
  // Byte-exactness: the Latin-1 0xC9 survived the round trip into the header value.
  const latin1 = parseMessage(loadFixture('8bit-headers-latin1.eml').raw);
  const from = headerValue(latin1, 'From')!;
  assert.ok(from.includes('\xc9ric'), 'the raw 0xC9 octet is preserved, not re-encoded');
});

test('mime: a duplicate Content-Type is flagged (MIME-confusion cut) and resolves to the first', () => {
  const raw = loadFixture('duplicate-content-type.eml').raw;
  const info = analyzeMime(parseMessage(raw).headers);
  assert.ok(hasMimeAnomaly(info, 'duplicate-content-type'), 'the ambiguity is recorded, not silently resolved');
  // BODYSTRUCTURE uses the first Content-Type (text/plain), and stays well-formed.
  const bs = bodyStructureResponse(raw);
  assert.ok(bs.startsWith('("TEXT" "PLAIN"'), 'the first Content-Type wins for BODYSTRUCTURE');
  assertWellFormedImap(bs, 'duplicate-content-type');
});

test('mime: an unknown Content-Transfer-Encoding forces octet-stream treatment, label preserved', () => {
  const raw = loadFixture('unknown-cte.eml').raw;
  const info = analyzeMime(parseMessage(raw).headers);
  assert.ok(hasMimeAnomaly(info, 'unknown-cte'), 'the unrecognised CTE is flagged');
  assert.ok(info.octetStreamTreatment, 'the body is treated as opaque octets');
  assert.ok(bodyStructureResponse(raw).includes('X-UUENCODE'), 'the raw CTE label is preserved on the wire');
});

test('headers: a no-colon line is recorded without dropping the surrounding valid headers', () => {
  const msg = parseMessage(loadFixture('header-no-colon.eml').raw);
  assert.ok(hasAnomaly(msg, 'header-no-colon'), 'the malformed line is recorded');
  assert.ok(hasHeader(msg, 'from') && hasHeader(msg, 'subject'), 'the valid headers around it survive');
});

test('headers: a line over 998 octets is recorded', () => {
  assert.ok(hasAnomaly(parseMessage(loadFixture('long-line-over-998.eml').raw), 'line-over-998'));
});

test('headers: a folded value (tabs, spaces, split encoded-word, folded address list) survives unfolding', () => {
  const raw = loadFixture('folding-torture.eml').raw;
  const msg = parseMessage(raw);
  assert.ok(hasHeader(msg, 'subject') && hasHeader(msg, 'to'), 'the folded headers are assembled, not split into extra fields');
  assertWellFormedImap(serializeEnvelope(buildEnvelope(msg.headers)), 'folding-torture');
});

test('addresses: group syntax and undisclosed-recipients do not produce malformed ENVELOPE addresses', () => {
  const env = serializeEnvelope(buildEnvelope(parseMessage(loadFixture('group-address.eml').raw).headers));
  assertWellFormedImap(env, 'group-address');
});

test('attachments: a hostile name/filename is escaped/stripped so quoted strings stay balanced', () => {
  const bs = bodyStructureResponse(loadFixture('attachment-filename-tricky.eml').raw);
  assertWellFormedImap(bs, 'attachment-filename-tricky');
  assert.ok(!bs.includes('\x01'), 'the control char in the filename is stripped from the wire');
});

test('structure: a header-only message (no separator) and a body-only message both parse cleanly', () => {
  const allHeaders = parseMessage(loadFixture('no-separator-all-headers.eml').raw);
  assert.ok(hasAnomaly(allHeaders, 'no-empty-line') && allHeaders.body.length === 0, 'no separator ⇒ empty body, recorded');
  const bodyOnly = parseMessage(loadFixture('no-headers-only-body.eml').raw);
  assert.equal(bodyOnly.headers.length, 0, 'an opening blank line ⇒ zero headers');
  assert.ok(bodyOnly.body.length > 0, 'the body is captured');
});

test('the well-formedness checker itself rejects the failure modes (negative control)', () => {
  assert.throws(() => assertWellFormedImap('("a\r\nb")', 'x'), /desync/);
  assert.throws(() => assertWellFormedImap('("a" "b"', 'x'), /unbalanced paren/i);
  assert.throws(() => assertWellFormedImap('("unterminated)', 'x'), /unterminated|unbalanced/i);
  assert.throws(() => assertWellFormedImap('("nul\x00")', 'x'), /control octet/);
  assertWellFormedImap('("Doe, John" NIL "j" "x.test")', 'x');
});
