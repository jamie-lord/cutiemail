/**
 * The address validator against the isemail corpus (dominicsayers/isemail, test/tests.xml,
 * committed verbatim as isemail-corpus.xml) — the canonical "email address parsing is
 * impossible" test set, 164 cases each tagged with a category.
 *
 * cutiemail is opinionated (ADR 0007): accept the modern, RFC 5321-deliverable forms;
 * reject the obsolete long tail (comments, folding white space, obs-* productions). So the
 * corpus is used as a PARTITIONED oracle, not a verdict-for-verdict match:
 *
 *   - ISEMAIL_ERR                                   → MUST be rejected (accepting an invalid
 *                                                     address is a real bug — this caught 10).
 *   - ISEMAIL_VALID / DNSWARN / RFC5321             → MUST be accepted (modern & deliverable;
 *                                                     DNS warnings are not a syntax error).
 *   - ISEMAIL_CFWS                                  → deliberately rejected (comments / folding).
 *   - ISEMAIL_DEPREC / RFC5322                      → the recorded boundary of the obsolete tail:
 *                                                     we reject most and tolerate some still-valid
 *                                                     forms; asserted only to parse without
 *                                                     throwing, with the split reported.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAddrSpec } from './address.ts';

const xml = readFileSync(new URL('./isemail-corpus.xml', import.meta.url), 'utf8');

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // &#x24xx; control-symbols and any numeric entity: latin1's low byte is the real octet.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));

interface Case {
  addr: string;
  category: string;
}
function parseCorpus(): Case[] {
  const cases: Case[] = [];
  for (const block of xml.split('<test ').slice(1)) {
    const empty = /<address\/>/.test(block);
    const m = /<address>([\s\S]*?)<\/address>/.exec(block);
    if (!empty && m === null) continue;
    const addr = empty ? '' : decodeEntities(m![1]!);
    const category = (/<category>([^<]+)<\/category>/.exec(block)?.[1] ?? '?').trim();
    cases.push({ addr, category });
  }
  return cases;
}
const CORPUS = parseCorpus();
const ok = (addr: string): boolean => parseAddrSpec(Buffer.from(addr, 'latin1')).ok;
const inCategory = (...cats: string[]): Case[] => CORPUS.filter((c) => cats.includes(c.category));

test('the corpus loaded (164 cases across the isemail categories)', () => {
  assert.ok(CORPUS.length >= 160, `parsed the corpus: ${CORPUS.length} cases`);
});

test('every ISEMAIL_ERR address is REJECTED — no invalid address is accepted', () => {
  const errs = inCategory('ISEMAIL_ERR');
  assert.ok(errs.length >= 60, `enough ERR cases: ${errs.length}`);
  const accepted = errs.filter((c) => ok(c.addr));
  assert.deepEqual(
    accepted.map((c) => c.addr),
    [],
    'these invalid addresses must not be accepted',
  );
});

test('every modern, deliverable address (VALID / DNSWARN / RFC5321) is ACCEPTED', () => {
  const good = inCategory('ISEMAIL_VALID_CATEGORY', 'ISEMAIL_DNSWARN', 'ISEMAIL_RFC5321');
  assert.ok(good.length >= 35, `enough accept-cases: ${good.length}`);
  const rejected = good.filter((c) => !ok(c.addr));
  assert.deepEqual(
    rejected.map((c) => c.addr),
    [],
    'these valid, deliverable addresses must be accepted',
  );
});

test('comments and folding white space (ISEMAIL_CFWS) are rejected — the obsolete tail (ADR 0007)', () => {
  const cfws = inCategory('ISEMAIL_CFWS');
  assert.ok(cfws.length >= 8, `enough CFWS cases: ${cfws.length}`);
  const accepted = cfws.filter((c) => ok(c.addr));
  assert.deepEqual(accepted.map((c) => c.addr), [], 'we do not parse comments / folding white space');
});

test('deprecated and RFC5322-only forms are the recorded boundary — they parse without throwing', () => {
  const tail = inCategory('ISEMAIL_DEPREC', 'ISEMAIL_RFC5322');
  let accept = 0;
  for (const c of tail) {
    assert.doesNotThrow(() => parseAddrSpec(Buffer.from(c.addr, 'latin1')), `must not throw on ${JSON.stringify(c.addr)}`);
    if (ok(c.addr)) accept++;
  }
  // Documented, not pinned to an exact number: we reject most of the obsolete tail and
  // tolerate a minority of still-valid forms. The invariant that matters (no ERR accepted,
  // every deliverable accepted) is asserted above.
  assert.ok(accept < tail.length, `we reject a substantial part of the obsolete tail (${accept}/${tail.length} accepted)`);
});
