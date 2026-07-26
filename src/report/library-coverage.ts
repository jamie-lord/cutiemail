/**
 * Coverage for the library-adapter registers (message, crypto, IMAP, auth,
 * transport), computed by static analysis of the corpora.
 *
 * The SMTP suite has a data-driven coverage report (coverage.ts) because its corpus
 * is structured as TestCase[]/Mutant[]. The library-adapter corpora are node:test
 * files instead, so this report reads them: it scans every *.test.ts for the
 * `cites('R-...')` calls that anchor a case to a requirement, and cross-references
 * against each register. A `parse`-testable requirement with no citing test — and
 * no recorded deliberately-uncovered decision — is a genuine gap, and the
 * accompanying test fails on it. This is the "know what's covered" self-audit for
 * the parts that grew after the SMTP suite.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { RequirementDef } from '../register/types.ts';
import { MESSAGE_REQUIREMENTS } from '../register/message/index.ts';
import { CRYPTO_REQUIREMENTS } from '../register/crypto/index.ts';
import { IMAP_REQUIREMENTS } from '../register/imap/index.ts';
import { AUTH_REQUIREMENTS } from '../register/auth/index.ts';
import { TRANSPORT_REQUIREMENTS } from '../register/transport/index.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every requirement id cited by a `cites('...')` call anywhere under src/. */
export function scanCitedIds(root = SRC): Set<string> {
  const cited = new Set<string>();
  const re = /cites\(\s*['"](R-[^'"]+)['"]\s*\)/g;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith('.test.ts')) {
        const text = readFileSync(path, 'utf8');
        for (const m of text.matchAll(re)) cited.add(m[1]!);
      }
    }
  };
  walk(root);
  return cited;
}

export interface DomainCoverage {
  readonly name: string;
  readonly total: number;
  /** parse-testable requirements (the corpus-checkable ones). */
  readonly parseTestable: number;
  /** parse-testable requirements that have a citing test. */
  readonly covered: number;
  /**
   * Requirements that bind the ASSEMBLED SERVER and can only be observed over a socket.
   *
   * Counted separately from the parse-testable ones because they are a different kind of evidence,
   * and reported at all because they were previously invisible: this report used to consider only
   * `parse`, so a `wire` requirement with no test read as 100% coverage rather than as a gap. That
   * is the same blind spot that let a MUST-level SMTP requirement go unimplemented while every
   * report was green (ADR 0026).
   */
  readonly wireTestable: number;
  readonly wireCovered: number;
  /** Requirements of either kind with neither a test nor a deliberately-uncovered decision. */
  readonly gaps: readonly string[];
}

/** Testability kinds that a citing test is expected to exist for. */
function needsTest(r: RequirementDef): boolean {
  return r.testability.kind === 'parse' || r.testability.kind === 'wire' || r.testability.kind === 'wire-with-fixture';
}

const DOMAINS: ReadonlyArray<{ name: string; reqs: readonly RequirementDef[] }> = [
  { name: 'message', reqs: MESSAGE_REQUIREMENTS as readonly RequirementDef[] },
  { name: 'crypto', reqs: CRYPTO_REQUIREMENTS as readonly RequirementDef[] },
  { name: 'imap', reqs: IMAP_REQUIREMENTS as readonly RequirementDef[] },
  { name: 'auth', reqs: AUTH_REQUIREMENTS as readonly RequirementDef[] },
  { name: 'transport', reqs: TRANSPORT_REQUIREMENTS as readonly RequirementDef[] },
];

export function libraryCoverage(cited: Set<string> = scanCitedIds()): DomainCoverage[] {
  return DOMAINS.map(({ name, reqs }) => {
    const parse = reqs.filter((r) => r.testability.kind === 'parse');
    const wire = reqs.filter((r) => r.testability.kind === 'wire' || r.testability.kind === 'wire-with-fixture');
    const uncovered = (rs: readonly RequirementDef[]): string[] =>
      rs.filter((r) => !cited.has(r.id) && r.deliberatelyUncovered === undefined).map((r) => r.id);
    const parseGaps = uncovered(parse);
    const wireGaps = uncovered(wire);
    return {
      name,
      total: reqs.length,
      parseTestable: parse.length,
      covered: parse.length - parseGaps.length,
      wireTestable: wire.length,
      wireCovered: wire.length - wireGaps.length,
      gaps: [...parseGaps, ...wireGaps],
    };
  });
}

/** Every requirement that ought to have a citing test and does not. Used by the coverage test. */
export function coverageGaps(cited: Set<string> = scanCitedIds()): string[] {
  return DOMAINS.flatMap(({ reqs }) =>
    reqs.filter(needsTest).filter((r) => !cited.has(r.id) && r.deliberatelyUncovered === undefined).map((r) => r.id),
  );
}

/** A plain-text rendering. */
export function renderLibraryCoverage(rows: readonly DomainCoverage[]): string {
  const lines = ['REGISTER COVERAGE (requirements with a citing test)', '='.repeat(60), '', '  domain      parse    wire'];
  for (const r of rows) {
    const parse = r.parseTestable === 0 ? '    -' : `${r.covered}/${r.parseTestable}`.padStart(5);
    const wire = r.wireTestable === 0 ? '    -' : `${r.wireCovered}/${r.wireTestable}`.padStart(5);
    lines.push(`  ${r.name.padEnd(10)} ${parse}   ${wire}` + (r.gaps.length > 0 ? `   GAPS: ${r.gaps.join(', ')}` : ''));
  }
  lines.push('');
  lines.push('parse: assertable against an in-process parser. wire: binds the assembled server and');
  lines.push('is only observable over a socket. A `-` means the domain registers none of that kind.');
  return lines.join('\n');
}
