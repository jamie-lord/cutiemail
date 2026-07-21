/**
 * Reply structure and grammar (RFC 5321 §4.2, §4.2.1).
 *
 * The other side of the socket. Every module before this one asks "what does the
 * server DO when I send X"; this one asks "is what the server SAYS even
 * well-formed". The reply reader (src/wire/reply.ts) is built as an instrument,
 * not a client: it repairs nothing and records every deviation from §4.2's ABNF
 * as an `Anomaly`. That is the whole leverage here. A conformant server's replies
 * carry NO anomalies; a server that malforms its output carries exactly the one
 * anomaly that names the rule it broke. So these cases do not re-parse bytes —
 * they elicit the replies a session hands us for free (greeting, EHLO, NOOP) and
 * assert on the anomaly SET the reader already attached.
 *
 * A distinction worth stating up front, because it is the one a reviewer will
 * reach for: this is NOT crlf-discipline.ts. That module tests a server HONOURING
 * a malformed terminator sent by the CLIENT (inbound, the smuggling half). This
 * module tests a server EMITTING a malformed REPLY (outbound, the grammar half).
 * A `bare-lf-terminator` there is the client's bytes; here it is the server's.
 * Opposite directions, disjoint findings.
 *
 * Deliberate non-coverage, each for a reason the register notes spell out:
 *
 *   - R-5321-4.2-b (three-digit code) and the three-digit half of the Reply-code
 *     rule are ALREADY covered by error-handling.ts (reply-codes-are-three-digits,
 *     R-5321-4.3.2-c) with the fourDigitCode/twoDigitCode mutants. Re-testing the
 *     plain digit count here would be duplication, so it is skipped, not aliased.
 *
 *   - R-5321-4.2-j's UNIQUE contribution over R-5321-4.2-s is the SECOND-digit
 *     restriction to 0-5 (`%x30-35`), which the register note flags in bold: it is
 *     backed by no prose and no keyword, "a stricter reading than most implementers
 *     hold", and "failing a server on an ABNF byte range no prose backs is how a
 *     conformance suite loses credibility. Report it, do not fail on it." A MUST +
 *     `violated` becomes a finding with no escape, so a convicting test on the 260
 *     case would be exactly that false positive. Not covered; the first-digit half
 *     lives in R-5321-4.2-s / R-5321-4.3.2-c already.
 *
 *   - R-5321-4.2.1-e (a multiline reply must be terminable) and the "final line
 *     must be marked" half of R-5321-4.2.1-f both fail in only one observable way:
 *     a reply whose continuation never ends. To the reader that is bytes that
 *     never frame — a TIMEOUT — and the rule here is
 *     that a timeout is `inconclusive`, never `violated` (§4.5.3.2 permits minutes;
 *     a slow server is not a broken one). So a standalone conviction here would
 *     either convict on a timeout (forbidden) or desync silently. The
 *     concretely-convictable slices of §4.2.1 — same code on each line, and a
 *     well-formed separator that makes the multiline parseable at all — are tested
 *     below and carry -f as alsoTouches.
 */

import { testCase } from '../conformance/test-case.ts';
import type { TestCase, Mutant, Conn } from '../conformance/test-case.ts';
import type { Judgement } from '../conformance/outcome.ts';
import { crlf } from '../wire/bytes.ts';
import { severity } from '../wire/reply.ts';
import type { Reply, AnomalyKind } from '../wire/reply.ts';

interface LabeledReply {
  readonly label: string;
  readonly reply: Reply;
}

/**
 * Open a session and hand back the replies whose grammar we then inspect: the
 * greeting (written by the server on connect), the EHLO response (the multiline
 * reply every connection gives us for free), and a NOOP reply (a single-line
 * reply on the ordinary command path). Returns an inconclusive Judgement if the
 * opening did not proceed far enough to have anything to judge — a timeout at any
 * step is inconclusive, never a finding, per §4.5.3.2.
 */
async function collectReplies(conn: Conn): Promise<{ replies: readonly LabeledReply[] } | Judgement> {
  const g = await conn.readReply(5000);
  if (g.kind === 'timeout') return { kind: 'inconclusive', reason: 'greeting drew no reply within the timeout (server may be slow, §4.5.3.2)' };
  if (g.kind !== 'reply') return { kind: 'inconclusive', reason: `greeting: ${g.kind}` };
  if (severity(g.reply) !== 2) return { kind: 'inconclusive', reason: `greeting was ${g.reply.code}, not 2yz` };

  await conn.send(crlf`EHLO conformance-suite.invalid`);
  const e = await conn.readReply(3000);
  if (e.kind === 'timeout') return { kind: 'inconclusive', reason: 'EHLO drew no reply within the timeout (server may be slow, §4.5.3.2)' };
  if (e.kind !== 'reply') return { kind: 'inconclusive', reason: `EHLO: ${e.kind}` };
  if (e.reply.code !== 250) return { kind: 'inconclusive', reason: `EHLO refused with ${e.reply.code}` };

  // NOOP sits on the ordinary reply path (the server's replyOK routine), which is
  // where a per-reply malformation most naturally lands and is distinct from the
  // greeting's and EHLO's dedicated write paths. Reading it means a defect that
  // malforms "an ordinary reply" is observed even if the greeting/EHLO are clean.
  await conn.send(crlf`NOOP`);
  const n = await conn.readReply(3000);
  if (n.kind === 'timeout') return { kind: 'inconclusive', reason: 'NOOP drew no reply within the timeout (server may be slow, §4.5.3.2)' };
  if (n.kind !== 'reply') return { kind: 'inconclusive', reason: `NOOP: ${n.kind}` };

  return {
    replies: [
      { label: 'greeting', reply: g.reply },
      { label: 'EHLO', reply: e.reply },
      { label: 'NOOP', reply: n.reply },
    ],
  };
}

/** Collect the human-facing detail of every anomaly of `kind` across all replies read. */
function anomaliesOf(replies: readonly LabeledReply[], ...kinds: AnomalyKind[]): string[] {
  const wanted = new Set<AnomalyKind>(kinds);
  const out: string[] = [];
  for (const { label, reply } of replies) {
    for (const a of reply.anomalies) {
      if (wanted.has(a.kind)) out.push(`${label} line ${a.line}: ${a.detail}`);
    }
  }
  return out;
}

export const CASES: readonly TestCase[] = [
  testCase({
    id: 'reply-text-is-seven-bit',
    requirement: 'R-5321-4.2-h',
    alsoTouches: ['R-5321-4.2-i'],
    intent: 'reply text contains only HT and printable US-ASCII (%d09 / %d32-126)',
    rationale:
      '§4.2: "textstring = 1*(%d09 / %d32-126) ; HT, SP, Printable US-ASCII." Reply ' +
      'text is 7-bit: no NUL, no control bytes, and no octet with the high bit set. ' +
      'This is where servers most often leak a raw UTF-8 hostname, a rejected ' +
      'address, or an antivirus verdict interpolated into reply text. Absent SMTPUTF8 ' +
      '(RFC 6531 relaxes this for reply text), an 8-bit octet is a genuine violation — ' +
      'and this probe never negotiates SMTPUTF8, so the 7-bit invariant holds ' +
      'unconditionally over every reply it reads.',
    run: async (conn): Promise<Judgement> => {
      const c = await collectReplies(conn);
      if (!('replies' in c)) return c;
      const bad = anomaliesOf(c.replies, 'non-ascii-in-text');
      return bad.length > 0
        ? { kind: 'violated', detail: `non-7-bit octet in reply text: ${bad.join('; ')}` }
        : { kind: 'satisfied', detail: 'all reply text is HT / printable US-ASCII' };
    },
  }),

  testCase({
    id: 'reply-is-crlf-framed',
    requirement: 'R-5321-4.2-d',
    alsoTouches: ['R-5321-4.2-i', 'R-5321-2.3.7-b'],
    intent: 'each reply line is terminated by <CRLF>, never a bare LF or bare CR',
    rationale:
      '§4.2: "Formally, a reply is defined to be the sequence: a three-digit code, ' +
      '<SP>, one line of text, and <CRLF>, or a multiline reply." The testable, ' +
      'unambiguous half — separate from the "SP and text" half that the §4.2 ABNF ' +
      'then makes optional (see R-5321-4.2-b/-i) — is the <CRLF> framing: a reply ' +
      'line MUST end in <CRLF>, so a bare LF or bare CR terminator on a reply is ' +
      'ungrammatical. This is the OUTBOUND mirror of §2.3.8, and disjoint from ' +
      'crlf-discipline.ts, which tests a server acting on a bare LF from the client.',
    run: async (conn): Promise<Judgement> => {
      const c = await collectReplies(conn);
      if (!('replies' in c)) return c;
      const bad = anomaliesOf(c.replies, 'bare-lf-terminator', 'bare-cr-terminator');
      return bad.length > 0
        ? { kind: 'violated', detail: `reply line not <CRLF>-terminated: ${bad.join('; ')}` }
        : { kind: 'satisfied', detail: 'every reply line is <CRLF>-terminated' };
    },
  }),

  testCase({
    id: 'reply-separator-well-formed',
    requirement: 'R-5321-4.2-i',
    alsoTouches: ['R-5321-4.2.1-f'],
    intent: 'the byte after the three-digit code is <SP> (final line) or "-" (continuation)',
    rationale:
      '§4.2: "Reply-line = *( Reply-code \\"-\\" [ textstring ] CRLF ) Reply-code ' +
      '[ SP textstring ] CRLF." The authoritative reply grammar admits exactly two ' +
      'separators after the code: "-" on a continuation line and <SP> on the final ' +
      'line. Any other byte in that position is outside the Reply-line production, ' +
      'and it is not cosmetic — a client with no continuation marker and no space ' +
      'cannot tell where the reply ends. We assert no reply carries a ' +
      'malformed-separator anomaly. (The bare-code case, code with no separator at ' +
      'all, is the SHOULD NOT of R-5321-4.2-o — permitted latitude — and is ' +
      'deliberately NOT convicted here.)',
    run: async (conn): Promise<Judgement> => {
      const c = await collectReplies(conn);
      if (!('replies' in c)) return c;
      const bad = anomaliesOf(c.replies, 'malformed-separator');
      return bad.length > 0
        ? { kind: 'violated', detail: `separator after reply code is neither <SP> nor "-": ${bad.join('; ')}` }
        : { kind: 'satisfied', detail: 'every reply separator is <SP> or "-"' };
    },
  }),

  testCase({
    id: 'multiline-reply-code-consistent',
    requirement: 'R-5321-4.2.1-i',
    alsoTouches: ['R-5321-4.2.1-f', 'R-5321-4.2-i'],
    intent: 'every line of a multiline reply carries the same reply code',
    rationale:
      '§4.2.1: "In a multiline reply, the reply code on each of the lines MUST be ' +
      'the same." The client is entitled to make processing decisions from the code ' +
      'on any line, so a continuation line whose code differs from the final line is ' +
      'a clean MUST violation. EHLO hands us a multiline reply on every connection, ' +
      'so the check is free. TRAP the reader already handles: the RFC\'s own example ' +
      '"250-234 Text beginning with numbers" has TEXT that starts with digits; the ' +
      'anomaly is anchored to the start of line, so that conforming line is not a ' +
      'false mismatch.',
    run: async (conn): Promise<Judgement> => {
      const c = await collectReplies(conn);
      if (!('replies' in c)) return c;
      const multiline = c.replies.filter((r) => r.reply.multiline);
      if (multiline.length === 0) {
        // Nothing to observe: the rule is scoped to multiline replies, and this
        // server gave us none. Not a pass, not a fail.
        return { kind: 'inconclusive', reason: 'no multiline reply was received to check code consistency against' };
      }
      const bad = anomaliesOf(multiline, 'continuation-code-mismatch');
      return bad.length > 0
        ? { kind: 'violated', detail: `multiline reply codes differ across lines: ${bad.join('; ')}` }
        : { kind: 'satisfied', detail: `multiline reply(s) carry one code on every line (${multiline.map((m) => m.label).join(', ')})` };
    },
  }),

  testCase({
    id: 'reply-line-within-512',
    requirement: 'R-5321-4.5.3.1.5-a',
    intent: 'every reply line the server sends is at most 512 octets including the CRLF',
    rationale:
      '§4.5.3.1.5: "The maximum total length of a reply line including the reply code and the ' +
      '<CRLF> is 512 octets." A generation constraint on the server, passively assertable over ' +
      'every reply we read. The register note is candid that this is "cheap but weak" — normal ' +
      'replies are short, so absence of a violation is not proof of compliance — but an observed ' +
      'over-length line IS a clean violation. Measures each line as its bytes on the wire: the ' +
      'three code octets, the separator (if any), the text, and the terminator.',
    run: async (conn): Promise<Judgement> => {
      const c = await collectReplies(conn);
      if (!('replies' in c)) return c;
      const offenders: string[] = [];
      for (const { label, reply } of c.replies) {
        reply.lines.forEach((line, i) => {
          const octets =
            line.codeBytes.length +
            (line.separator === '' ? 0 : 1) +
            line.text.length +
            (line.terminator === 'crlf' ? 2 : 1);
          if (octets > 512) offenders.push(`${label} line ${i + 1}: ${octets} octets`);
        });
      }
      return offenders.length > 0
        ? { kind: 'violated', detail: `reply line exceeds the 512-octet maximum: ${offenders.join('; ')}` }
        : { kind: 'satisfied', detail: 'every reply line observed is within 512 octets' };
    },
  }),
];

export const MUTANTS: readonly Mutant[] = [
  {
    catches: 'reply-text-is-seven-bit',
    defect: 'eightBitReplyText',
    why: 'an 8-bit octet in reply text violates the 7-bit textstring ABNF of §4.2 (R-5321-4.2-h)',
  },
  {
    catches: 'reply-line-within-512',
    defect: 'overlongReplyLine',
    why: 'a reply line longer than 512 octets violates R-5321-4.5.3.1.5-a',
  },
  {
    catches: 'reply-is-crlf-framed',
    defect: 'bareLfReplyTerminator',
    why: 'a reply line ended by a bare LF is not the <CRLF>-terminated line §4.2 defines (R-5321-4.2-d)',
    alsoProves: [
      {
        requirement: 'R-5321-2.3.7-b',
        why: '§2.3.7 defines a reply as sent in "lines" — the register note reads its testable half as "every reply is CRLF-terminated"; a bare-LF-terminated reply (this defect) violates exactly that framing obligation',
      },
    ],
  },
  {
    // Single-line malformation (250= on the NOOP path). Proves only the primary
    // §4.2-i separator grammar; it is NOT a §4.2.1-f multiline-FORMAT violation
    // (that rule is about which separator each line of a MULTILINE reply carries),
    // so it carries no alsoProves — see malformedMultilineSeparator below.
    catches: 'reply-separator-well-formed',
    defect: 'malformedReplySeparator',
    why: 'a byte other than <SP> or "-" after the code is outside the Reply-line grammar of §4.2 (R-5321-4.2-i)',
  },
  {
    // Genuine §4.2.1-f control: the FINAL line of the multiline EHLO carries "="
    // instead of the required <SP>, so the multiline reply violates "the last line
    // begins with the reply code followed immediately by <SP>". reply-separator-
    // well-formed reads the EHLO (multiline) reply and flags the malformed-separator
    // anomaly, so it detects this on a real multiline reply — which the single-line
    // NOOP malformation above cannot demonstrate.
    catches: 'reply-separator-well-formed',
    defect: 'malformedMultilineSeparator',
    why: 'a "=" where the final line of a multiline reply must have <SP> is outside §4.2 Reply-line grammar (R-5321-4.2-i)',
    alsoProves: [
      {
        requirement: 'R-5321-4.2.1-f',
        why: '§4.2.1: "The last line will begin with the reply code, followed immediately by <SP>" — a multiline reply whose final line uses "=" violates the multiline-FORMAT rule, on a genuinely multiline reply',
      },
    ],
  },
  {
    // Proves the primary §4.2.1-i code-EQUALITY rule. Note
    // this is NOT §4.2.1-f: each line here is well-FORMED (code + "-"/SP); only the
    // codes DIFFER, which is 4.2.1-i, a separate requirement. No 4.2.1-f alsoProves.
    catches: 'multiline-reply-code-consistent',
    defect: 'mismatchedContinuation',
    why: 'a continuation line whose code differs from the final line violates §4.2.1 (R-5321-4.2.1-i)',
  },
];
