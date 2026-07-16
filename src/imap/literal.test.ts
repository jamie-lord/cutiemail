/**
 * The IMAP literal-detection corpus (RFC 9051 §4.3), with a negative control.
 * Proves the parser distinguishes synchronizing "{n}" from non-synchronizing "{n+}"
 * — mishandling which desynchronizes the octet stream. Cites a compile-checked
 * ImapRequirementId.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLiteral } from './literal.ts';
import { imapRequirement } from '../register/imap/index.ts';
import type { ImapRequirementId } from '../register/imap/index.ts';

const L = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);

test('sanity: a line with no literal is reported as such', () => {
  assert.equal(detectLiteral(L('a1 NOOP\r\n')).hasLiteral, false);
});

test('R-9051-4.3-a: a synchronizing {n} literal is distinguished from {n+} (treatSyncAsNonSync caught)', () => {
  cites('R-9051-4.3-a');
  // Synchronizing: "a1 LOGIN {11}" — the client must await a continuation.
  const sync = detectLiteral(L('a1 LOGIN {11}\r\n'));
  assert.ok(sync.hasLiteral && sync.octetCount === 11 && sync.synchronizing, 'a {n} literal is synchronizing');

  // Non-synchronizing: "a1 LOGIN {11+}" — no wait.
  const nonSync = detectLiteral(L('a1 LOGIN {11+}\r\n'));
  assert.ok(nonSync.hasLiteral && nonSync.octetCount === 11 && !nonSync.synchronizing, 'a {n+} literal is non-synchronizing');

  // Negative control: reporting a synchronizing literal as non-synchronizing.
  assert.ok(!detectLiteral(L('a1 LOGIN {11}\r\n'), { treatSyncAsNonSync: true }).synchronizing, 'treatSyncAsNonSync must be detectable');
});
