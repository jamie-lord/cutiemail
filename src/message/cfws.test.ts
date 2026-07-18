/**
 * Linear CFWS comment-stripping (src/message/cfws.ts). The correctness cases pin the RFC
 * 5322 §3.2.2 semantics both DoS sinks (From alignment, Authentication-Results id) depend
 * on; the reproduce-first case is the run-3 HIGH: the previous iterated-regex stripper was
 * O(depth²), so a deeply nested comment froze the event loop. The linear scan handles the
 * same input in microseconds — the wall-clock bound below fails hard against the old code
 * (seconds) with a ~100x margin, so it is a real regression guard, not a flaky timer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripComments } from './cfws.ts';

test('balanced comments (incl. nesting and quoted-pairs) collapse to a single space', () => {
  assert.equal(stripComments('(comment) real'), '  real');
  assert.equal(stripComments('a(b)c'), 'a c'); // one space per top-level comment
  assert.equal(stripComments('((deeply(nested)))x'), ' x'); // nested → still one leading space
  assert.equal(stripComments('a(b\\)c)d'), 'a d'); // \) is an escaped paren, not the close
  assert.equal(stripComments('plain value'), 'plain value'); // nothing to strip
});

test('the address survives when a comment precedes/follows it (the DMARC/AR use)', () => {
  // What fromValueDomain relies on: comments removed, the real angle-addr left intact.
  assert.equal(stripComments('(spoof <x@evil.com>) <victim@bank.com>').includes('evil.com'), false);
  assert.ok(stripComments('(spoof <x@evil.com>) <victim@bank.com>').includes('victim@bank.com'));
});

test('a stray unmatched ) outside a comment is kept; an unterminated ( is fail-closed', () => {
  assert.equal(stripComments('a)b'), 'a)b'); // lone close paren is literal
  // Unbalanced trailing "(" → treated as a comment to end-of-value and dropped. Malformed
  // input; the caller extracts nothing rather than trusting the text after a stray paren.
  assert.equal(stripComments('keep(dropped to end'), 'keep '); // the comment collapses to its space, tail dropped
});

test('reproduce-first: deep nesting is linear, not quadratic (run-3 HIGH DoS)', () => {
  // 200k-deep balanced comment. The old fixed-point regex is O(depth²) — seconds to minutes
  // and an event-loop freeze; the linear scan is instant. Assert a generous 500ms bound: the
  // old code needs many seconds at this depth, so the margin makes this non-flaky.
  const depth = 200_000;
  const payload = '('.repeat(depth) + ')'.repeat(depth) + '<a@evil.com>';
  const start = process.hrtime.bigint();
  const out = stripComments(payload);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(out.includes('<a@evil.com>'), 'the address after the comment survives');
  assert.ok(ms < 500, `linear strip must stay well under 500ms (took ${ms.toFixed(0)}ms)`);
});
