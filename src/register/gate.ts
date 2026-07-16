/**
 * Shared verbatim-gate machinery, reused by every requirement register (SMTP,
 * message-format, and whatever comes next).
 *
 * The register's whole credibility rests on one property: every `text` field is a
 * genuine verbatim quote of its source RFC. This module loads and normalises the
 * vendored spec files so a register's test can assert exactly that. Keeping it here
 * — rather than inline in one register's test — means a new register domain gets
 * the same discipline for free and cannot quietly weaken it.
 *
 * See docs/decisions/0001-spec-baseline.md and 0006-starttls-injection.md.
 */

import { readFileSync } from 'node:fs';
import type { SpecSource } from './types.ts';

/**
 * RFC text with page furniture removed and all whitespace collapsed.
 *
 * The furniture has to go because requirement text runs across page breaks, so a
 * naive substring check would fail on correctly-quoted text. The patterns are
 * generic (author-agnostic footer, RFC-agnostic header) so any RFC in the series
 * needs no bespoke filter.
 */
export function normaliseSpec(raw: string): string {
  return raw
    .split('\n')
    // Running footer "<author(s)>  Standards Track  [Page N]" and running header
    // "RFC NNNN  <title>  <Month Year>".
    .filter((line) => !/Standards Track\s+\[Page \d+\]\s*$/.test(line))
    .filter((line) => !/^RFC \d+\b.*\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\s*$/.test(line))
    .join('\n')
    // The RFCs are wrapped to ~72 columns and break at existing hyphens, so
    // "high-order" can appear as "high-\n   order". Rejoining is safe because the
    // text only ever breaks at a hyphen genuinely part of the word.
    .replace(/-\n\s+/g, '-')
    .replace(/\f/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collapse a requirement's own text the same way, for substring comparison. */
export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const cache = new Map<SpecSource, string>();

/** The normalised text of a vendored spec, cached. */
export function loadSpec(source: SpecSource): string {
  const cached = cache.get(source);
  if (cached !== undefined) return cached;
  const raw = readFileSync(new URL(`../../spec/${source}.txt`, import.meta.url), 'utf8');
  const normalised = normaliseSpec(raw);
  cache.set(source, normalised);
  return normalised;
}
