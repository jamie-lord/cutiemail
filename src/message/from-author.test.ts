/**
 * The shared From-author extractor (message/from-author.ts). It is the single source of
 * truth for "who is the From", used by both inbound DMARC alignment and outbound submission
 * sender-authorization (ADR 0015), so its spoof-hardening is security-critical: the display-
 * name decoy must resolve to the address the MUA SHOWS, and a second From must be counted so
 * both callers can reject it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allAuthorDomains, authorAddrSpec, authorDomains, domainOfAddrSpec, fromAuthor, mailboxCount } from './from-author.ts';

test('authorAddrSpec takes the plain angle-addr', () => {
  assert.equal(authorAddrSpec('Alice <alice@example.com>'), 'alice@example.com');
  assert.equal(authorAddrSpec('bob@example.com'), 'bob@example.com');
  assert.equal(authorAddrSpec('  <carol@example.com>  '), 'carol@example.com');
});

test('authorAddrSpec defeats the display-name decoy — takes the address the MUA shows', () => {
  // The classic spoof: a decoy angle-addr hidden in a quoted-string display-name, then the
  // REAL angle-addr the client renders. A naive first-<> match reads a@evil.com; we must read
  // victim@bank.com (the last angle-addr, after quoted-strings are stripped).
  assert.equal(authorAddrSpec('"x <a@evil.com>" <victim@bank.com>'), 'victim@bank.com');
  // Same trick with an RFC 5322 comment holding the decoy.
  assert.equal(authorAddrSpec('(a@evil.com) <victim@bank.com>'), 'victim@bank.com');
  // Escaped quote inside the quoted-string must not end it early.
  assert.equal(authorAddrSpec('"he said \\"hi\\" <a@evil.com>" <real@good.com>'), 'real@good.com');
});

test('authorAddrSpec returns null when there is no address', () => {
  assert.equal(authorAddrSpec('Just A Name'), null);
  assert.equal(authorAddrSpec('"quoted only"'), null);
  assert.equal(authorAddrSpec(''), null);
});

test('domainOfAddrSpec lower-cases and strips a root-anchoring trailing dot', () => {
  assert.equal(domainOfAddrSpec('a@Example.COM'), 'example.com');
  assert.equal(domainOfAddrSpec('a@example.com.'), 'example.com');
  assert.equal(domainOfAddrSpec('no-at-sign'), null);
});

const msg = (headers: string): Buffer => Buffer.from(`${headers}\r\n\r\nbody\r\n`, 'latin1');

test('fromAuthor extracts the single author and counts one', () => {
  const r = fromAuthor(msg('From: Alice <alice@example.com>\r\nTo: b@x.test'));
  assert.equal(r.address, 'alice@example.com');
  assert.equal(r.count, 1);
});

test('fromAuthor counts a second From (the multi-From spoof signal)', () => {
  const r = fromAuthor(msg('From: victim@bank.com\r\nFrom: attacker@evil.com'));
  assert.equal(r.count, 2, 'both From headers are counted so the caller can reject');
});

test('fromAuthor reports zero From headers as count 0 / null', () => {
  const r = fromAuthor(msg('To: b@x.test\r\nSubject: no from'));
  assert.equal(r.address, null);
  assert.equal(r.count, 0);
});

test('fromAuthor reads the From value through the spoof-hardened parse', () => {
  // Proves fromAuthor and authorAddrSpec agree end to end on the decoy.
  const r = fromAuthor(msg('From: "x <a@evil.com>" <victim@bank.com>'));
  assert.equal(r.address, 'victim@bank.com');
  assert.equal(r.count, 1);
});

test('mailboxCount counts the mailboxes in a single From value (the mailbox-list spoof, RFC 5322 §3.6.1)', () => {
  // The single-header mailbox-list evasion: two addr-specs in ONE From header. A naive parser
  // that only counts From HEADERS reports 1, so an attacker-controlled second mailbox (with
  // aligned DKIM) rides in while an MUA may render the first, victim, address.
  assert.equal(mailboxCount('victim@bank.com, x@evil.com'), 2, 'two mailboxes in one value');
  assert.equal(mailboxCount('<victim@bank.com>, <x@evil.com>'), 2, 'two angle-addrs too');
  // The comma-LESS two-angle evasion: two mailboxes, no separator, so a comma-only count reports 1
  // and the send-as gate would bless one while a recipient MUA could render the other.
  assert.equal(mailboxCount('<bob@example.com> <alice@example.com>'), 2, 'two angle-addrs with no comma');
  // A single mailbox stays 1 regardless of a comma hidden in a quoted display-name or comment.
  assert.equal(mailboxCount('<victim@bank.com>'), 1);
  assert.equal(mailboxCount('Alice <alice@example.com>'), 1, 'display-name form is one mailbox');
  assert.equal(mailboxCount('"Alice, Example" <alice@example.com>'), 1, 'quoted comma is not a separator');
  assert.equal(mailboxCount('"x <a@evil.com>" <victim@bank.com>'), 1, 'quoted decoy angle-addr is not counted');
  assert.equal(mailboxCount('(a, comment) alice@example.com'), 1, 'comment comma is not a separator');
  assert.equal(mailboxCount('Just A Name'), 0, 'no addr-spec, no mailbox');
});

test('fromAuthor surfaces the true mailbox count for a single-header list (count>1 is the spoof signal)', () => {
  // BEFORE the fix, count was froms.length === 1 here, so the caller could not tell this apart
  // from a genuine single author. The mailbox count now makes the list case count>1.
  const r = fromAuthor(msg('From: victim@bank.com, x@evil.com'));
  assert.equal(r.count, 2, 'the single-header mailbox-list is counted as multi-mailbox');
  // A genuine single mailbox with a comma-bearing quoted display-name is still count 1 (control).
  const ok = fromAuthor(msg('From: "Alice, Example" <alice@example.com>'));
  assert.equal(ok.count, 1);
  assert.equal(ok.address, 'alice@example.com');
});

test('allAuthorDomains gathers every author domain across ALL From headers and mailboxes, de-duplicated', () => {
  // Two From headers AND a mailbox-list within one — DMARC (RFC 9989 §11.5) must weigh them all.
  // Reading only the first header's value was the multi-header spoof: a p=reject domain hidden in
  // a second From header was never queried.
  assert.deepEqual(
    allAuthorDomains(msg('From: a@first.example, b@first-list.example\r\nFrom: victim@bank.com')),
    ['first.example', 'first-list.example', 'bank.com'],
  );
  // De-duplication across headers (same domain, different local parts) and the same spoof-hardened
  // parse every other function uses (display-name decoy resolves to the shown address).
  assert.deepEqual(
    allAuthorDomains(msg('From: "x <a@evil.com>" <shown@bank.com>\r\nFrom: other@bank.com')),
    ['bank.com'],
  );
  // A single From is exactly the single-header domain set (no behaviour change on the common case).
  assert.deepEqual(allAuthorDomains(msg('From: alice@example.com')), ['example.com']);
  assert.deepEqual(allAuthorDomains(msg('To: nobody@example.com')), []);
});

test('authorDomains enumerates EVERY angle-addr in one comma-less From value (the DMARC p=reject bypass)', () => {
  // The comma-less two-angle spoof: `mailboxCount` already counts BOTH angle-addrs (so DMARC takes
  // the multi-domain §11.5 path), but the domain walk used to split only on commas and keep the
  // LAST angle-addr per segment — enumerating only the attacker's policy-less domain, so the
  // victim's p=reject was never queried and the spoof reached the INBOX. Both domains must appear,
  // victim first (the order written).
  assert.deepEqual(
    authorDomains('<victim@bank.example> <attacker@evil.example>'),
    ['bank.example', 'evil.example'],
    'both angle-addr domains are enumerated from one comma-less segment',
  );
  // And end to end across the whole message, matching what mailboxCount reports (count and domains
  // cannot disagree): three comma-less angle-addrs → three domains.
  assert.equal(mailboxCount('<a@one.example> <b@two.example> <c@three.example>'), 3);
  assert.deepEqual(
    allAuthorDomains(msg('From: <a@one.example> <b@two.example> <c@three.example>')),
    ['one.example', 'two.example', 'three.example'],
  );
  // Negative control: the defect that keeps only the last angle-addr per segment reproduces the
  // bypass exactly — the victim's bank.example is dropped, so the fix (not something else) is what
  // enumerates it. lastAngleOnlyPerSegment must be detectable.
  assert.deepEqual(
    authorDomains('<victim@bank.example> <attacker@evil.example>', { lastAngleOnlyPerSegment: true }),
    ['evil.example'],
    'the defect drops the victim domain, the exact under-enumeration behind the bypass',
  );
});
