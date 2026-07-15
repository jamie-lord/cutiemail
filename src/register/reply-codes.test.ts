/**
 * Invariants for the reply-code registry.
 *
 * The registry's value is that it faithfully restates RFC 5321 §4.2.3 and
 * §4.3.2. These tests defend three things: every code is grammatical per §4.2's
 * ABNF, the numeric-order list has no accidental duplicates, and — the check
 * that matters most — every `meaning` is verbatim from the vendored RFC, not a
 * paraphrase. A handful of §4.3.2 sequences are pinned against the spec by hand
 * so a wrong transcription (a code in the wrong command's row) is caught.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REPLY_CODES,
  COMMAND_REPLY_SEQUENCES,
  ANY_COMMAND_REPLIES,
  CONNECTION_ESTABLISHMENT,
  NOTES,
  type Command,
  type SequencedReply,
  type CommandReplySequenceDef,
} from './reply-codes.ts';

/**
 * `COMMAND_REPLY_SEQUENCES` is `as const`, so each row's type is a literal shape
 * that omits absent optionals (only DATA carries `intermediate`, only some
 * replies carry `note`). These invariants care about the general shape, so take
 * a widened view — the same move rfc5321.test.ts makes for REQUIREMENTS.
 */
const sequences: readonly CommandReplySequenceDef[] = COMMAND_REPLY_SEQUENCES;

/** RFC text with page furniture stripped and whitespace collapsed, for substring checks. */
const rfc: string = (() => {
  const raw = readFileSync(new URL('../../spec/rfc5321.txt', import.meta.url), 'utf8');
  return raw
    .split('\n')
    .filter((line) => !/^Klensin\s+Standards Track\s+\[Page \d+\]$/.test(line))
    .filter((line) => !/^RFC 5321\s+SMTP\s+October 2008$/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
})();

/**
 * Verbatim substring check that tolerates the RFC wrapping a hyphenated compound
 * across a line break. "EHLO-advertised extensions" is printed as "EHLO-\n
 * advertised extensions"; collapsing lines with a space yields "EHLO- advertised",
 * so a naive `includes` on the (correct) unspaced quote would miss. Normalising
 * "hyphen + space" to a bare hyphen on both sides fixes it without loosening the
 * check — no reply-code meaning legitimately contains a spaced hyphen.
 */
const rfcDehyphenated = rfc.replace(/-\s+/g, '-');
function quotedVerbatim(meaning: string): boolean {
  return rfc.includes(meaning) || rfcDehyphenated.includes(meaning.replace(/-\s+/g, '-'));
}

test('every reply code is a valid RFC 5321 code: first digit 2-5, second 0-5, three digits', () => {
  for (const { code } of REPLY_CODES) {
    assert.ok(Number.isInteger(code), `${code} is not an integer`);
    assert.ok(code >= 200 && code <= 599, `${code} out of 3-digit 2xx-5xx range`);
    const first = Math.floor(code / 100);
    const second = Math.floor(code / 10) % 10;
    assert.ok(first >= 2 && first <= 5, `${code}: first digit ${first} not in 2-5`);
    assert.ok(second >= 0 && second <= 5, `${code}: second digit ${second} not in 0-5`);
  }
});

test('no duplicate codes in the numeric-order list', () => {
  const seen = new Set<number>();
  for (const { code } of REPLY_CODES) {
    assert.ok(!seen.has(code), `duplicate reply code ${code}`);
    seen.add(code);
  }
});

test('REPLY_CODES is stored in ascending numeric order (as §4.2.3 lists them)', () => {
  const codes = REPLY_CODES.map((r) => r.code);
  const sorted = [...codes].sort((a, b) => a - b);
  assert.deepEqual(codes, sorted);
  assert.ok(
    REPLY_CODES.every((r) => r.listedInNumericOrder === true),
    'every entry must record listedInNumericOrder: true',
  );
});

test('every §4.2.3 meaning is verbatim in the RFC', () => {
  for (const { code, meaning } of REPLY_CODES) {
    assert.ok(
      rfc.includes(meaning),
      `meaning for ${code} not found verbatim in spec/rfc5321.txt:\n  ${meaning}`,
    );
  }
});

test('§4.2.3 registry is complete: exactly the 24 codes the RFC lists', () => {
  // Guards against a dropped or invented row.
  assert.equal(REPLY_CODES.length, 24);
  assert.deepEqual(
    REPLY_CODES.map((r) => r.code),
    [
      211, 214, 220, 221, 250, 251, 252, 354, 421, 450, 451, 452, 455, 500, 501,
      502, 503, 504, 550, 551, 552, 553, 554, 555,
    ],
  );
});

test('the §4.2.4 / §4.2.5 / §4.3.2 carve-out notes are quoted verbatim from the RFC', () => {
  // Each note ends with a bracketed citation or is partly gloss; check the
  // load-bearing verbatim spans that must not drift.
  const spans = [
    'Questions have been raised as to when reply code 502 (Command not implemented) SHOULD be returned in preference to other codes.',
    '502 SHOULD be used when the command is actually recognized by the SMTP server, but not implemented.',
    'Extended SMTP systems MUST NOT list capabilities in response to EHLO for which they will return 502 (or 500) replies.',
  ];
  for (const span of spans) {
    assert.ok(NOTES.code502.includes(span), `code502 note missing span: ${span}`);
    assert.ok(rfc.includes(span), `span not verbatim in RFC: ${span}`);
  }
});

// ---- §4.3.2 command-reply sequences ---------------------------------------

const seqByCommand = new Map<Command, CommandReplySequenceDef>(
  sequences.map((s) => [s.command, s]),
);

function codes(replies: readonly SequencedReply[]): number[] {
  return replies.map((r) => r.code);
}

test('all eleven commands are present exactly once', () => {
  const expected: Command[] = [
    'EHLO', 'HELO', 'MAIL', 'RCPT', 'DATA', 'RSET', 'VRFY', 'EXPN', 'HELP', 'NOOP', 'QUIT',
  ];
  assert.equal(COMMAND_REPLY_SEQUENCES.length, expected.length);
  for (const c of expected) assert.ok(seqByCommand.has(c), `missing command ${c}`);
});

test('every code cited in a sequence is a known §4.2.3 code', () => {
  const known = new Set<number>(REPLY_CODES.map((r) => r.code));
  for (const seq of sequences) {
    for (const r of [...(seq.intermediate ?? []), ...seq.success, ...seq.error]) {
      assert.ok(known.has(r.code), `${seq.command} cites unknown code ${r.code}`);
    }
  }
});

test('DATA: intermediate 354, success 250, and the after-body + command errors', () => {
  const data = seqByCommand.get('DATA')!;
  assert.deepEqual(codes(data.intermediate ?? []), [354]);
  assert.deepEqual(codes(data.success), [250]);
  // §4.3.2: E: 552, 554, 451, 452  |  450, 550 (policy)  |  503, 554 (command)
  // 554 deduplicated to one entry.
  assert.deepEqual(codes(data.error), [552, 554, 451, 452, 450, 550, 503]);
  for (const need of [552, 554, 451, 452, 450, 550, 503]) {
    assert.ok(codes(data.error).includes(need), `DATA missing error ${need}`);
  }
});

test('QUIT: success is exactly 221, no errors', () => {
  const quit = seqByCommand.get('QUIT')!;
  assert.deepEqual(codes(quit.success), [221]);
  assert.deepEqual(codes(quit.error), []);
});

test('RCPT: success 250 and 251, and 251 carries the §3.4 caveat verbatim', () => {
  const rcpt = seqByCommand.get('RCPT')!;
  assert.deepEqual(codes(rcpt.success), [250, 251]);
  const caveat = rcpt.success.find((r) => r.code === 251)?.note;
  assert.equal(caveat, 'but see Section 3.4 for discussion of 251 and 551');
  assert.deepEqual(
    codes(rcpt.error),
    [550, 551, 552, 553, 450, 451, 452, 503, 455, 555],
  );
});

test('VRFY: 250/251/252 succeed, and 502/504 among the errors (the §4.2.4 nuance)', () => {
  const vrfy = seqByCommand.get('VRFY')!;
  assert.deepEqual(codes(vrfy.success), [250, 251, 252]);
  assert.deepEqual(codes(vrfy.error), [550, 551, 553, 502, 504]);
  // 252 is a 2yz success, not a refusal — the trap NOTES.vrfyNuance warns about.
  assert.ok(codes(vrfy.success).includes(252));
});

test('EHLO/HELO share the sequence, and 502 carries the old-style-server caveat', () => {
  const ehlo = seqByCommand.get('EHLO')!;
  const helo = seqByCommand.get('HELO')!;
  assert.deepEqual(codes(ehlo.success), [250]);
  assert.deepEqual(codes(ehlo.success), codes(helo.success));
  assert.deepEqual(codes(ehlo.error), codes(helo.error));
  const note502 = ehlo.error.find((r) => r.code === 502)?.note;
  assert.equal(note502, 'permitted only with an old-style server that does not support EHLO');
});

test('MAIL: the eight error codes §4.3.2 lists, in order', () => {
  const mail = seqByCommand.get('MAIL')!;
  assert.deepEqual(codes(mail.success), [250]);
  assert.deepEqual(codes(mail.error), [552, 451, 452, 550, 553, 503, 455, 555]);
});

test('the always-available codes are 500, 501, 421 with verbatim §4.3.2 prose', () => {
  assert.deepEqual(ANY_COMMAND_REPLIES.map((r) => r.code), [500, 501, 421]);
  for (const { meaning } of ANY_COMMAND_REPLIES) {
    assert.ok(quotedVerbatim(meaning), `ANY_COMMAND meaning not verbatim: ${meaning}`);
  }
});

test('CONNECTION ESTABLISHMENT is S:220 / E:554', () => {
  assert.deepEqual(codes(CONNECTION_ESTABLISHMENT.success), [220]);
  assert.deepEqual(codes(CONNECTION_ESTABLISHMENT.error), [554]);
});
