/**
 * A vendored MIME / RFC 5322 message TORTURE CORPUS — the fixtures under this
 * directory (`*.eml`), loaded byte-exact for `torture-corpus.test.ts`.
 *
 * ── SOURCE / PROVENANCE ──────────────────────────────────────────────────────
 * Every fixture in this directory was AUTHORED for cutie-mail. They are DERIVED
 * equivalents of the message shapes that famous public torture corpora are known
 * for breaking parsers with — NOT verbatim copies of any of them. That is a
 * deliberate, honest choice: the classic corpora have unclear or non-permissive
 * licensing (the Perl MIME-Tools / `Mail::Message` "torture-test" mailbox, the
 * Mutt test mbox, various forwarded "torturetest" messages), and the mission's
 * rule is: if a source's license is unclear, DERIVE an equivalent yourself and
 * say so. So every byte here is original text written to reproduce a documented
 * failure mode, with the pattern it models named in `modeledOn` below.
 *
 * ── LICENSE ──────────────────────────────────────────────────────────────────
 * These fixtures are part of cutie-mail and carry the repository's own license.
 * No third-party corpus text is redistributed here.
 *
 * ── WHY A CORPUS AT ALL ──────────────────────────────────────────────────────
 * fuzz.test.ts proves the PARSERS never throw on random/mutated bytes;
 * torture.test.ts proves the SERIALIZERS never emit malformed IMAP on a small
 * curated set. This corpus adds DIVERGENCE-catching depth: real-world-shaped
 * messages (deep nesting, RFC 2047 edge cases, RFC 2231 continuations, malformed
 * / missing boundaries, 8-bit and NUL in headers, bare CR / bare LF endings,
 * folding torture, empty parts) each run through the LIVE parse + ENVELOPE +
 * BODYSTRUCTURE path. The invariant across the whole set: no crash, no hang, no
 * malformed IMAP, no bytes-vs-strings corruption. Where cutie-mail makes an
 * OPINIONATED rejection (a bare-LF blank line is not a header/body separator; an
 * RFC 2231 continuation is not reassembled; an encoded-word is not decoded inside
 * ENVELOPE), the test asserts and COMMENTS the outcome as intended, not accidental.
 *
 * Bytes, never strings: fixtures are read with no encoding, so 8-bit octets, NUL,
 * and bare CR/LF survive exactly as written by the generator.
 */

import { readFileSync } from 'node:fs';

/** What a fixture stresses and which documented torture pattern it is modeled on. */
export interface FixtureMeta {
  /** Why this message is interesting — the parser/serializer surface it exercises. */
  readonly why: string;
  /** The famous corpus / documented pattern this authored message is a derived equivalent of. */
  readonly modeledOn: string;
}

/**
 * Per-fixture provenance + intent. The test asserts every `.eml` on disk has an
 * entry here (and vice versa), so a fixture can never be added without recording
 * WHY it exists.
 */
export const FIXTURE_META: Readonly<Record<string, FixtureMeta>> = {
  'nested-alternative.eml': {
    why: 'multipart/mixed wrapping a multipart/alternative plus an attachment; preamble+epilogue present. Exercises recursive BODYSTRUCTURE and preamble/epilogue discard.',
    modeledOn: 'MIME-Tools "torture-test" nested-alternative layout; RFC 2049 §5 complex-multipart example',
  },
  'deeply-nested-16.eml': {
    why: '16 levels of nested multipart, within the depth cap — recursion must produce a fully balanced BODYSTRUCTURE.',
    modeledOn: 'MIME-Tools deep-nesting torture message',
  },
  'deeply-nested-past-cap.eml': {
    why: '250 nested multiparts — past MAX_MIME_DEPTH (100). Must engage the DoS cap (opaque leaf) with no stack overflow and still emit balanced IMAP.',
    modeledOn: 'MIME nesting-bomb / billion-laughs-style depth attack',
  },
  'message-rfc822-forward.eml': {
    why: 'a message/rfc822 forwarded attachment whose inner message is itself multipart, with a "Last, First" quoted display name inside. Exercises nested ENVELOPE + nested BODYSTRUCTURE.',
    modeledOn: 'MIME-Tools forwarded-message torture; classic Fwd: nesting',
  },
  'rfc2047-adjacent-words.eml': {
    why: 'two adjacent RFC 2047 encoded-words — the whitespace BETWEEN them must be dropped on concatenation (RFC 2047 §6.2).',
    modeledOn: 'RFC 2047 §8 "If you can read this…" canonical example',
  },
  'rfc2047-b-and-q.eml': {
    why: 'B and Q encodings, UTF-8 and ISO-8859-1, in From display-name and Subject. Exercises both decoders.',
    modeledOn: 'RFC 2047 §8 B/Q examples',
  },
  'rfc2047-overlong-word.eml': {
    why: 'an encoded-word longer than the 75-char ceiling — must record overlong-word yet not crash.',
    modeledOn: 'RFC 2047 §2 length-limit edge case',
  },
  'rfc2047-internal-whitespace.eml': {
    why: 'an encoded-word with whitespace inside the token — must be left LITERAL (never silently decoded) and flagged.',
    modeledOn: 'RFC 2047 malformed-token injection edge case',
  },
  'rfc2047-display-name-comma.eml': {
    why: 'encoded-words as address display-names, one hiding a comma (=2C) — the address-list splitter must not split on the encoded comma.',
    modeledOn: 'real-world "Lastname, Firstname" encoded display names',
  },
  'rfc2047-invalid-base64.eml': {
    why: 'a B-encoded word with an invalid base64 payload — decoder must not throw.',
    modeledOn: 'malformed base64 in encoded-word',
  },
  'rfc2231-continuation.eml': {
    why: 'a Content-Type parameter split across name*0 / name*1 (RFC 2231 continuation). cutie-mail does NOT reassemble continuations — assert a defined, well-formed outcome.',
    modeledOn: 'cpython email Lib/test/data RFC 2231 continuation messages',
  },
  'rfc2231-charset-lang.eml': {
    why: "an RFC 2231 extended value: filename*=UTF-8'en'%C2%A3… (charset'lang'pct-encoding). Must be handled without crashing or emitting malformed IMAP.",
    modeledOn: 'cpython email RFC 2231 charset/language parameter messages',
  },
  'boundary-metachars.eml': {
    why: 'a boundary full of regex/shell metacharacters and internal spaces — boundary matching must be literal, not regex.',
    modeledOn: 'boundary-confusion torture (regex-special boundaries)',
  },
  'missing-terminal-boundary.eml': {
    why: 'a multipart with no closing --B-- delimiter — parts must still split, with no-closing-delimiter recorded.',
    modeledOn: 'cpython email "missing terminal boundary" test message',
  },
  'boundary-in-preamble.eml': {
    why: 'boundary-LOOKING text in the preamble and epilogue that is not an exact delimiter — must be discarded, not treated as a part.',
    modeledOn: 'RFC 2046 §5.1.1 preamble/epilogue confusion',
  },
  'empty-parts.eml': {
    why: 'zero-length body parts between delimiters — empty leaves must serialize cleanly.',
    modeledOn: 'cpython email empty-part test message',
  },
  '8bit-headers-utf8.eml': {
    why: 'raw UTF-8 (8-bit) in From/Subject with NO encoded-word wrapper — eight-bit anomaly recorded; bytes pass through the serializer (EAI/SMTPUTF8 era) while framing stays safe.',
    modeledOn: 'Mutt test-mbox 8-bit header messages; EAI raw-UTF-8 headers',
  },
  '8bit-headers-latin1.eml': {
    why: 'raw Latin-1 8-bit octets (0xC9, 0xE9, 0xEF) in headers — byte-exact preservation through parse and into ENVELOPE.',
    modeledOn: 'Mutt test-mbox legacy 8-bit (ISO-8859-1) headers',
  },
  'bare-cr-endings.eml': {
    why: 'classic-Mac bare-CR line endings (no LF). Opinionated: a bare CR is not a line terminator for the header/body split — records bare-cr, treats the whole thing as one unterminated header block.',
    modeledOn: 'legacy Mac (CR-only) mailbox torture',
  },
  'bare-lf-endings.eml': {
    why: 'Unix bare-LF endings incl. a multipart. Opinionated: a bare-LF blank line is NOT the header/body separator (anti-smuggling), so the message is treated as all-headers with bare-lf recorded.',
    modeledOn: 'Unix LF-only mailbox torture',
  },
  'mixed-endings.eml': {
    why: 'CRLF, LF, and CR line endings mixed in one message — must not crash and must record both bare-lf and bare-cr.',
    modeledOn: 'forwarded/gatewayed message with mangled line endings',
  },
  'nul-in-header-and-body.eml': {
    why: 'NUL (0x00) octets in a header value and the body — nul-octet recorded; the NUL must be STRIPPED from serializer output (a raw NUL desyncs a strict IMAP client).',
    modeledOn: 'NUL-injection torture (crafted header/filename NULs)',
  },
  'folding-torture.eml': {
    why: 'header folding with tabs and spaces, a fold splitting an encoded-word run, and a folded address list — unfolding must not corrupt the values.',
    modeledOn: 'RFC 5322 §2.2.3 folding torture; MIME-Tools folded headers',
  },
  'no-separator-all-headers.eml': {
    why: 'no blank line at all — the entire message is header lines. Must record no-empty-line and yield an empty body.',
    modeledOn: 'truncated message with no header/body separator',
  },
  'no-headers-only-body.eml': {
    why: 'message opens with the blank line — empty header section, body only.',
    modeledOn: 'body-only message (no headers)',
  },
  'unterminated-ct-param.eml': {
    why: 'Content-Type; name="unterminated — an unterminated quoted parameter must not unbalance the emitted IMAP.',
    modeledOn: 'malformed Content-Type quoted-parameter torture',
  },
  'duplicate-content-type.eml': {
    why: 'two Content-Type headers — the MIME analyzer flags duplicate-content-type (ADR-0007 MIME-confusion cut); BODYSTRUCTURE resolves to the first.',
    modeledOn: 'MIME-confusion duplicate-header attack',
  },
  'unknown-cte.eml': {
    why: 'an unrecognized Content-Transfer-Encoding (x-uuencode) — analyzer forces octet-stream treatment; the raw label is preserved in BODYSTRUCTURE.',
    modeledOn: 'unknown-CTE handling (RFC 2045 §6.4)',
  },
  'group-address.eml': {
    why: 'RFC 5322 group syntax ("A Group: a, b;") and undisclosed-recipients:; — must not split the group members into malformed ENVELOPE addresses that unbalance the output.',
    modeledOn: 'RFC 5322 §3.4 group-address torture',
  },
  'header-no-colon.eml': {
    why: 'a header-section line with no colon between two valid headers — records header-no-colon without dropping the valid headers.',
    modeledOn: 'malformed header line torture',
  },
  'long-line-over-998.eml': {
    why: 'a header line exceeding the hard 998-octet limit — records line-over-998.',
    modeledOn: 'RFC 5322 §2.1.1 line-length-limit torture',
  },
  'attachment-filename-tricky.eml': {
    why: 'attachment name/filename with quotes, semicolons and a control char — must be escaped/stripped so the BODYSTRUCTURE quoted strings stay balanced.',
    modeledOn: 'real-world hostile attachment filenames',
  },
  'multipart-zero-parts.eml': {
    why: 'multipart declared but the boundary never appears — must be reported as a single text/plain leaf, NOT a childless MULTIPART (which would desync a strict client).',
    modeledOn: 'multipart with zero matching parts (serializer-desync bug class)',
  },
  'overlong-boundary.eml': {
    why: 'a boundary parameter longer than the 70-char RFC 2046 limit — records overlong-boundary yet still splits the part.',
    modeledOn: 'RFC 2046 §5.1.1 boundary-length limit',
  },
};

export interface Fixture {
  /** The `.eml` filename (stable identifier). */
  readonly name: string;
  /** The raw message bytes, read with no encoding (byte-exact). */
  readonly raw: Buffer;
  readonly meta: FixtureMeta;
}

/** The list of fixture filenames known to this corpus (the metadata keys). */
export const FIXTURE_NAMES: readonly string[] = Object.keys(FIXTURE_META).sort();

/** Load one fixture's byte-exact contents plus its provenance. */
export function loadFixture(name: string): Fixture {
  const meta = FIXTURE_META[name];
  if (meta === undefined) throw new Error(`no metadata for fixture ${name}`);
  const raw = readFileSync(new URL(name, import.meta.url));
  return { name, raw, meta };
}

/** Load the whole corpus, byte-exact, in stable (sorted) order. */
export function loadCorpus(): Fixture[] {
  return FIXTURE_NAMES.map(loadFixture);
}
