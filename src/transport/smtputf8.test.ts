/**
 * The SMTPUTF8 corpus (RFC 6531 §3.5), with a negative control. Proves the
 * internationalization detection and the negotiation gate that stops
 * internationalized content reaching a non-SMTPUTF8 server. Cites a compile-checked
 * TransportRequirementId.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInternationalized, mayTransmit } from './smtputf8.ts';
import { transportRequirement } from '../register/transport/index.ts';
import type { TransportRequirementId } from '../register/transport/index.ts';

const cites = (id: TransportRequirementId): void => assert.ok(transportRequirement(id).id === id);
const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

test('sanity: internationalization is an octet-level property', () => {
  assert.ok(!isInternationalized(utf8('user@example.com')), 'an ASCII address is not internationalized');
  assert.ok(isInternationalized(utf8('用户@example.com')), 'a non-ASCII local-part is internationalized');
  assert.ok(isInternationalized(utf8('user@例え.jp')), 'a non-ASCII domain is internationalized');
});

test('R-6531-3.5-a: internationalized content needs SMTPUTF8 (sendWithoutNegotiation caught)', () => {
  cites('R-6531-3.5-a');
  const intl = isInternationalized(utf8('用户@example.com'));
  const ascii = isInternationalized(utf8('user@example.com'));

  // All-ASCII transmits to any server.
  assert.ok(mayTransmit(ascii, false), 'an ASCII message transmits without SMTPUTF8');
  // Internationalized needs the server to support SMTPUTF8.
  assert.ok(mayTransmit(intl, true), 'internationalized transmits when SMTPUTF8 is offered');
  assert.ok(!mayTransmit(intl, false), 'internationalized is refused when SMTPUTF8 is absent');
  // Negative control.
  assert.ok(mayTransmit(intl, false, { sendWithoutNegotiation: true }), 'sendWithoutNegotiation must be detectable');
});
