/**
 * The library-adapter coverage self-audit: every parse-testable requirement in the
 * message/crypto/imap/auth/transport registers must have a citing test (or a
 * recorded deliberately-uncovered decision). This is the "no silent gaps" gate —
 * adding a requirement without a corpus test that cites it fails here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryCoverage, renderLibraryCoverage } from './library-coverage.ts';

test('every parse-testable library-adapter requirement has a citing test (no silent gaps)', () => {
  const rows = libraryCoverage();
  const allGaps = rows.flatMap((r) => r.gaps.map((id) => `${r.name}:${id}`));
  assert.deepEqual(allGaps, [], `uncovered parse-testable requirements:\n${renderLibraryCoverage(rows)}`);
});

test('the report accounts for a real, non-trivial number of requirements', () => {
  const rows = libraryCoverage();
  const totalParse = rows.reduce((n, r) => n + r.parseTestable, 0);
  assert.ok(totalParse >= 40, `expected a substantial parse-testable surface, got ${totalParse}`);
  // Every domain contributes something.
  for (const r of rows) assert.ok(r.parseTestable > 0, `${r.name} has parse-testable requirements`);
});
