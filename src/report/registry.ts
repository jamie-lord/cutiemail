/**
 * The cross-register inventory: a single view over every requirement domain.
 *
 * The project grew from one SMTP-receiver register to six domains (SMTP,
 * message-format, mail-crypto, IMAP, mail-auth, transport). This report answers, at
 * a glance, what the whole register holds — the denominator side of coverage —
 * without needing each corpus as data: per-domain counts, the RFCs each draws from,
 * the RFC-2119 level distribution, and the testability mix. It is the map of the
 * specification the server must satisfy.
 */

import type { RequirementDef, Level, Testability } from '../register/types.ts';
import { REQUIREMENTS as SMTP } from '../register/rfc5321.ts';
import { MESSAGE_REQUIREMENTS as MESSAGE } from '../register/message/index.ts';
import { CRYPTO_REQUIREMENTS as CRYPTO } from '../register/crypto/index.ts';
import { IMAP_REQUIREMENTS as IMAP } from '../register/imap/index.ts';
import { AUTH_REQUIREMENTS as AUTH } from '../register/auth/index.ts';
import { TRANSPORT_REQUIREMENTS as TRANSPORT } from '../register/transport/index.ts';

export interface DomainSummary {
  readonly name: string;
  readonly requirementCount: number;
  /** RFC numbers this domain quotes, sorted. */
  readonly rfcs: readonly string[];
  readonly byLevel: Readonly<Record<Level, number>>;
  /** Count per testability kind (wire, parse, wire-client, wire-with-fixture, not-testable). */
  readonly byTestability: Readonly<Record<Testability['kind'], number>>;
}

export interface RegistrySummary {
  readonly domains: readonly DomainSummary[];
  readonly totalRequirements: number;
  readonly totalRfcs: number;
}

const DOMAINS: ReadonlyArray<{ name: string; reqs: readonly RequirementDef[]; defaultRfc: string }> = [
  { name: 'smtp', reqs: SMTP as readonly RequirementDef[], defaultRfc: 'rfc5321' },
  { name: 'message', reqs: MESSAGE as readonly RequirementDef[], defaultRfc: 'rfc5322' },
  { name: 'crypto', reqs: CRYPTO as readonly RequirementDef[], defaultRfc: 'rfc6376' },
  { name: 'imap', reqs: IMAP as readonly RequirementDef[], defaultRfc: 'rfc9051' },
  { name: 'auth', reqs: AUTH as readonly RequirementDef[], defaultRfc: 'rfc7208' },
  { name: 'transport', reqs: TRANSPORT as readonly RequirementDef[], defaultRfc: 'rfc8461' },
];

const LEVELS: readonly Level[] = ['MUST', 'MUST NOT', 'SHOULD', 'SHOULD NOT', 'MAY', 'REQUIRED', 'RECOMMENDED'];
const KINDS: readonly Testability['kind'][] = ['wire', 'parse', 'wire-client', 'wire-with-fixture', 'not-testable'];

function summariseDomain(name: string, reqs: readonly RequirementDef[], defaultRfc: string): DomainSummary {
  const byLevel = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
  const byTestability = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Testability['kind'], number>;
  const rfcs = new Set<string>();
  for (const r of reqs) {
    byLevel[r.level] += 1;
    byTestability[r.testability.kind] += 1;
    rfcs.add((r.rfc ?? defaultRfc).replace('rfc', ''));
  }
  return { name, requirementCount: reqs.length, rfcs: [...rfcs].sort(), byLevel, byTestability };
}

export function buildRegistrySummary(): RegistrySummary {
  const domains = DOMAINS.map((d) => summariseDomain(d.name, d.reqs, d.defaultRfc));
  const allRfcs = new Set<string>();
  for (const d of domains) for (const r of d.rfcs) allRfcs.add(r);
  return {
    domains,
    totalRequirements: domains.reduce((n, d) => n + d.requirementCount, 0),
    totalRfcs: allRfcs.size,
  };
}

/** A plain-text rendering of the cross-register inventory. */
export function renderRegistrySummary(s: RegistrySummary): string {
  const lines: string[] = ['REQUIREMENT REGISTER — CROSS-DOMAIN INVENTORY', '='.repeat(60), ''];
  lines.push(`${s.totalRequirements} requirements across ${s.domains.length} domains, drawn from ${s.totalRfcs} RFCs.`, '');
  for (const d of s.domains) {
    const musts = d.byLevel.MUST + d.byLevel['MUST NOT'] + d.byLevel.REQUIRED;
    lines.push(
      `  ${d.name.padEnd(10)} ${String(d.requirementCount).padStart(4)}  ` +
        `(${musts} strict; RFC ${d.rfcs.join(', ')})`,
    );
  }
  return lines.join('\n');
}
