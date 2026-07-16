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
  /** parse-testable requirements with neither a test nor a deliberately-uncovered decision. */
  readonly gaps: readonly string[];
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
    const gaps = parse.filter((r) => !cited.has(r.id) && r.deliberatelyUncovered === undefined).map((r) => r.id);
    return { name, total: reqs.length, parseTestable: parse.length, covered: parse.length - gaps.length, gaps };
  });
}

/** A plain-text rendering. */
export function renderLibraryCoverage(rows: readonly DomainCoverage[]): string {
  const lines = ['LIBRARY-ADAPTER COVERAGE (parse-testable requirements with a citing test)', '='.repeat(60), ''];
  for (const r of rows) {
    lines.push(`  ${r.name.padEnd(10)} ${r.covered}/${r.parseTestable} parse-testable covered` + (r.gaps.length > 0 ? `  GAPS: ${r.gaps.join(', ')}` : ''));
  }
  return lines.join('\n');
}
