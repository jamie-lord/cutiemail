/**
 * The IMAP4rev2 response-parsing corpus (RFC 9051 §2.2.2, §7.1), with negative
 * controls. Each case proves the parser handles a valid response AND enforces one
 * response-format rule, with the matching defect DETECTED. Cases cite
 * compile-checked ImapRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse, hasResponseAnomaly } from './response.ts';
import { imapRequirement } from '../register/imap/index.ts';
import type { ImapRequirementId } from '../register/imap/index.ts';

const R = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);

test('sanity: tagged, untagged, and continuation responses parse', () => {
  assert.equal(parseResponse(R('A001 OK LOGIN completed\r\n')).kind, 'tagged');
  assert.equal(parseResponse(R('* 18 EXISTS\r\n')).kind, 'untagged');
  assert.equal(parseResponse(R('+ Ready for literal\r\n')).kind, 'continuation');
  const tagged = parseResponse(R('A001 OK done'));
  assert.equal(tagged.tag, 'A001');
  assert.equal(tagged.condition, 'OK');
});

test('R-9051-2.2.2-a: the first token classifies the response (treatPlusAsData caught)', () => {
  cites('R-9051-2.2.2-a');
  assert.equal(parseResponse(R('+ go ahead')).kind, 'continuation', 'a "+" is a continuation request');
  // Negative control: failing to recognise "+" misclassifies it.
  assert.notEqual(parseResponse(R('+ go ahead'), { treatPlusAsData: true }).kind, 'continuation', 'treatPlusAsData must be detectable');
});

test('R-9051-7.1-a: the five status conditions are recognized (dontRecognizeBye caught)', () => {
  cites('R-9051-7.1-a');
  for (const c of ['OK', 'NO', 'BAD', 'PREAUTH', 'BYE'] as const) {
    assert.equal(parseResponse(R(`* ${c} something`)).condition, c, `${c} is a status condition`);
  }
  // Untagged server data is NOT a status condition.
  assert.equal(parseResponse(R('* 18 EXISTS')).condition, null, 'untagged data is not a status condition');
  // Negative control: not recognising BYE.
  assert.equal(parseResponse(R('* BYE server shutting down'), { dontRecognizeBye: true }).condition, null, 'dontRecognizeBye must be detectable');
});

test('R-9051-7.1-b: a tagged PREAUTH/BYE is flagged — they are always untagged (defect caught)', () => {
  cites('R-9051-7.1-b');
  // A well-formed untagged BYE is fine.
  assert.ok(!hasResponseAnomaly(parseResponse(R('* BYE logging out')), 'tagged-status-always-untagged'));
  // A tagged BYE / PREAUTH is malformed.
  assert.ok(hasResponseAnomaly(parseResponse(R('A001 BYE nope')), 'tagged-status-always-untagged'), 'a tagged BYE is flagged');
  assert.ok(hasResponseAnomaly(parseResponse(R('A001 PREAUTH nope')), 'tagged-status-always-untagged'), 'a tagged PREAUTH is flagged');
  // Negative control.
  assert.ok(!hasResponseAnomaly(parseResponse(R('A001 BYE nope'), { acceptTaggedPreauthBye: true }), 'tagged-status-always-untagged'), 'acceptTaggedPreauthBye must be detectable');
});

test('R-9051-7.1-c: a bracketed response code is extracted (ignoreResponseCode caught)', () => {
  cites('R-9051-7.1-c');
  const r = parseResponse(R('A001 OK [READ-ONLY] SELECT completed'));
  assert.equal(r.code, 'READ-ONLY', 'the response-code atom is extracted');
  assert.equal(r.text, 'SELECT completed', 'the human text follows the code');
  // A code with arguments.
  const withArgs = parseResponse(R('* OK [UIDVALIDITY 3857529045] UIDs valid'));
  assert.equal(withArgs.code, 'UIDVALIDITY');
  assert.equal(withArgs.codeArgs, '3857529045');
  // Negative control: not parsing the code leaves it in the text.
  const defect = parseResponse(R('A001 OK [READ-ONLY] SELECT completed'), { ignoreResponseCode: true });
  assert.equal(defect.code, null, 'ignoreResponseCode must be detectable');
  assert.ok(defect.text.startsWith('[READ-ONLY]'), 'the unparsed code stays in the text');
});
