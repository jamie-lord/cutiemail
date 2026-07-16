/**
 * The message-format conformance corpus for RFC 5322 §2.1, with negative controls.
 *
 * Each case proves two things about a message-format requirement, exactly as the
 * SMTP corpus does over the wire: the reference parser is CONFORMANT with no
 * defects, and the matching defect is DETECTED. A case with no defect proof is
 * only half a test.
 *
 * Traceability is structural: each case names its MessageRequirementId, so a case
 * citing a requirement not in the register fails to compile.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, hasHeader, hasAnomaly } from './parse.ts';
import type { ParserDefects } from './parse.ts';
import { messageRequirement } from '../register/message/index.ts';
import type { MessageRequirementId } from '../register/message/index.ts';

const CRLF = '\r\n';
const b = (s: string): Buffer => Buffer.from(s, 'latin1');

/** Assert a requirement exists (compile-time id check + runtime presence). */
function cites(id: MessageRequirementId): void {
  assert.ok(messageRequirement(id).id === id);
}

test('sanity: a well-formed message parses into headers + body', () => {
  const msg = parseMessage(b(`From: a@example.com${CRLF}Subject: hi${CRLF}${CRLF}the body`));
  assert.equal(msg.headers.length, 2);
  assert.ok(hasHeader(msg, 'from') && hasHeader(msg, 'subject'));
  assert.equal(msg.body.toString('latin1'), 'the body');
  assert.deepEqual(msg.anomalies, []);
});

test('R-5322-2.1.1-a: a line over 998 octets is flagged (and the defect is caught)', () => {
  cites('R-5322-2.1.1-a');
  const overlong = b(`X: ${'a'.repeat(996)}${CRLF}${CRLF}body`); // line content = 3 + 996 = 999
  const atFloor = b(`X: ${'a'.repeat(995)}${CRLF}${CRLF}body`); // line content = 998, must NOT flag

  // Conformant baseline: the over-998 line is seen; the at-floor line is not.
  assert.ok(hasAnomaly(parseMessage(overlong), 'line-over-998'), 'clean parser must flag the 999-octet line');
  assert.ok(!hasAnomaly(parseMessage(atFloor), 'line-over-998'), 'a 998-octet line is at the floor, not over it');

  // Negative control: the defect no longer flags it.
  const defect: ParserDefects = { dontFlagOverlongLine: true };
  assert.ok(!hasAnomaly(parseMessage(overlong, defect), 'line-over-998'), 'dontFlagOverlongLine must be detectable');
});

test('R-5322-2.1-a: a NUL and an 8-bit octet are flagged (and the defect is caught)', () => {
  cites('R-5322-2.1-a');
  const withNul = Buffer.concat([b('Subject: a'), Buffer.from([0x00]), b(`b${CRLF}${CRLF}body`)]);
  const with8bit = Buffer.concat([b('Subject: '), Buffer.from([0xe9]), b(`${CRLF}${CRLF}body`)]);

  assert.ok(hasAnomaly(parseMessage(withNul), 'nul-octet'), 'clean parser must flag a NUL');
  assert.ok(hasAnomaly(parseMessage(with8bit), 'eight-bit'), 'clean parser must flag an 8-bit octet');

  const defect: ParserDefects = { acceptNonAsciiSilently: true };
  assert.ok(!hasAnomaly(parseMessage(withNul, defect), 'nul-octet'), 'silently accepting a NUL must be detectable');
  assert.ok(!hasAnomaly(parseMessage(with8bit, defect), 'eight-bit'), 'silently accepting 8-bit must be detectable');
});

test('R-5322-2.1-b: the header/body split is the CRLF empty line, not a bare-LF one (defect caught)', () => {
  cites('R-5322-2.1-b');
  // A bare-LF blank line sits BEFORE the real CRLF/CRLF boundary. A conformant
  // parser must NOT split there — Subject must stay a header, not escape to the body.
  const input = b(`From: a@example.com${CRLF}\nSubject: real${CRLF}${CRLF}body`);

  const clean = parseMessage(input);
  assert.ok(hasHeader(clean, 'subject'), 'clean parser keeps Subject as a header (boundary is the CRLF empty line)');
  assert.equal(clean.body.toString('latin1'), 'body');
  assert.ok(hasAnomaly(clean, 'bare-lf'), 'the bare-LF blank line is still recorded as an anomaly');

  // Negative control: splitting on the bare-LF empty line makes Subject escape into the body.
  const defect = parseMessage(input, { splitHeaderBodyOnBareLf: true });
  assert.ok(!hasHeader(defect, 'subject'), 'splitting on a bare-LF blank line is a header/body-confusion defect and must be detectable');
  assert.ok(defect.body.toString('latin1').includes('Subject: real'), 'the escaped header lands in the body');
});
