/**
 * The register coverage self-audit: every requirement in the message/crypto/imap/auth/transport
 * registers that CAN be tested must have a citing test, or a recorded deliberately-uncovered
 * decision. This is the "no silent gaps" gate — adding a requirement without a test that cites it
 * fails here.
 *
 * It now covers `wire` requirements as well as `parse` ones. It did not, and that mattered: a
 * requirement binding the assembled server used to be excluded from the denominator entirely, so
 * registering one and never testing it read as full coverage. Reporting confidence against your own
 * extraction is how a MUST-level gap survives while every report is green (ADR 0026).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryCoverage, renderLibraryCoverage } from './library-coverage.ts';

test('every testable register requirement has a citing test (no silent gaps)', () => {
  const rows = libraryCoverage();
  const allGaps = rows.flatMap((r) => r.gaps.map((id) => `${r.name}:${id}`));
  assert.deepEqual(allGaps, [], `uncovered requirements:\n${renderLibraryCoverage(rows)}`);
});

test('the wire surface is accounted for, not merely present', () => {
  const rows = libraryCoverage();
  const wire = rows.reduce((n, r) => n + r.wireTestable, 0);
  // A guard against the report quietly reverting to parse-only: if the wire denominator ever falls
  // back to zero, this says so rather than reporting a comfortable 100%.
  assert.ok(wire >= 30, `expected a substantial wire surface in the registers, got ${wire}`);
  const imap = rows.find((r) => r.name === 'imap');
  assert.ok(imap !== undefined && imap.wireTestable > 0, 'IMAP registers requirements that bind the assembled server');
});

test('the report accounts for a real, non-trivial number of requirements', () => {
  const rows = libraryCoverage();
  const totalParse = rows.reduce((n, r) => n + r.parseTestable, 0);
  assert.ok(totalParse >= 40, `expected a substantial parse-testable surface, got ${totalParse}`);
  // Every domain contributes something.
  for (const r of rows) assert.ok(r.parseTestable > 0, `${r.name} has parse-testable requirements`);
});
