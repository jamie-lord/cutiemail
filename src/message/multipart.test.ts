/**
 * The multipart splitting conformance corpus (RFC 2046 §5.1.1), with negative
 * controls. The theme is boundary confusion: each case proves the splitter
 * reconstructs the sender's part structure, and that the matching defect — one
 * confusion vector — is DETECTED. Cases cite compile-checked MessageRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMultipart, hasMultipartAnomaly } from './multipart.ts';
import { messageRequirement } from '../register/message/index.ts';
import type { MessageRequirementId } from '../register/message/index.ts';

const b = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: MessageRequirementId): void => assert.ok(messageRequirement(id).id === id);

const BOUNDARY = 'frontier';
/** A well-formed two-part multipart body with preamble and epilogue. */
const BODY = b(
  'this is the preamble, to be ignored\r\n' +
    '--frontier\r\n' +
    'Content-Type: text/plain\r\n\r\n' +
    'part one body\r\n' +
    '--frontier\r\n' +
    'Content-Type: text/html\r\n\r\n' +
    '<p>part two</p>\r\n' +
    '--frontier--\r\n' +
    'this is the epilogue, to be ignored\r\n',
);

test('sanity: a well-formed multipart splits into parts, with preamble/epilogue set aside', () => {
  const r = parseMultipart(BODY, BOUNDARY);
  assert.equal(r.parts.length, 2);
  assert.ok(r.closed, 'the closing delimiter was seen');
  assert.ok(r.parts[0]!.includes(b('part one body')));
  assert.ok(r.parts[1]!.includes(b('<p>part two</p>')));
  assert.ok(r.preamble.includes(b('preamble')));
  assert.ok(r.epilogue.includes(b('epilogue')));
  assert.deepEqual([...r.anomalies], []);
});

test('R-2046-5.1.1-a: a boundary only counts at the start of a line (matchBoundaryAnywhere caught)', () => {
  cites('R-2046-5.1.1-a');
  // The token "--frontier" appears mid-line inside part one's content; it must
  // NOT split there.
  const smuggled = b(
    '--frontier\r\n\r\n' +
      'innocent text then --frontier\r\n' +
      '--frontier--\r\n',
  );
  assert.equal(parseMultipart(smuggled, BOUNDARY).parts.length, 1, 'mid-line boundary is content, not a split');
  // Negative control: matching anywhere splits on the smuggled occurrence.
  const defect = parseMultipart(smuggled, BOUNDARY, { matchBoundaryAnywhere: true });
  assert.ok(defect.parts.length > 1, 'matchBoundaryAnywhere must be detectable');
});

test('R-2046-5.1.1-b: preamble and epilogue are not parts (includePreambleAsPart caught)', () => {
  cites('R-2046-5.1.1-b');
  const r = parseMultipart(BODY, BOUNDARY);
  assert.equal(r.parts.length, 2, 'only the two real parts');
  assert.ok(!r.parts.some((p) => p.includes(b('preamble'))), 'the preamble is not a part');
  // Negative control: promoting the preamble to a part.
  const defect = parseMultipart(BODY, BOUNDARY, { includePreambleAsPart: true });
  assert.equal(defect.parts.length, 3, 'includePreambleAsPart must be detectable');
  assert.ok(defect.parts[0]!.includes(b('preamble')));
});

test('R-2046-5.1.1-c: a boundary longer than 70 chars is flagged (acceptOverlongBoundary caught)', () => {
  cites('R-2046-5.1.1-c');
  const long = 'x'.repeat(71);
  const body = b(`--${long}\r\n\r\ncontent\r\n--${long}--\r\n`);
  assert.ok(hasMultipartAnomaly(parseMultipart(body, long), 'overlong-boundary'), 'a 71-char boundary is flagged');
  assert.ok(!hasMultipartAnomaly(parseMultipart(b('--ok\r\n\r\nc\r\n--ok--\r\n'), 'ok'), 'overlong-boundary'), 'a short boundary is fine');
  assert.ok(!hasMultipartAnomaly(parseMultipart(body, long, { acceptOverlongBoundary: true }), 'overlong-boundary'), 'acceptOverlongBoundary must be detectable');
});

test('R-2046-5.1.1-d: the whole boundary must match, not just a prefix (prefixBoundaryMatch caught)', () => {
  cites('R-2046-5.1.1-d');
  // "--frontierX" is a longer token; with boundary "frontier" it is NOT a delimiter.
  const tricky = b(
    '--frontier\r\n\r\n' +
      'part one\r\n' +
      '--frontierX\r\n' +
      'still part one (the line is not a real delimiter)\r\n' +
      '--frontier--\r\n',
  );
  assert.equal(parseMultipart(tricky, BOUNDARY).parts.length, 1, 'a prefix-only line is not a delimiter');
  // Negative control: accepting the prefix match splits there.
  const defect = parseMultipart(tricky, BOUNDARY, { prefixBoundaryMatch: true });
  assert.ok(defect.parts.length > 1, 'prefixBoundaryMatch must be detectable');
});

test('a multipart with no closing delimiter is flagged', () => {
  cites('R-2046-5.1.1-b');
  const unterminated = b('--frontier\r\n\r\npart one\r\n');
  const r = parseMultipart(unterminated, BOUNDARY);
  assert.ok(!r.closed && hasMultipartAnomaly(r, 'no-closing-delimiter'), 'a missing close is surfaced');
});

test('a huge body is split without allocating a per-line object over the whole body (run-9 OOM)', () => {
  // parseMultipart must retain only the delimiter lines' offsets, never a Line object per physical
  // line. The old code built a Line[] over the ENTIRE body (the run-4-class pattern parse.ts had
  // already removed), so a 25 MiB all-CRLF body — declaring boundary="X" is enough; the boundary
  // need never appear — spiked ~1.5 GB and froze the single-threaded event loop for over a second
  // when a client FETCHed BODYSTRUCTURE. This is a differential guard: an 8 MiB all-CRLF body is
  // ~4 M lines; the old implementation would allocate ~4 M objects (hundreds of MB), the new one
  // essentially none. A generous 96 MiB heap-delta ceiling cleanly separates the two.
  const huge = Buffer.alloc(8 * 1024 * 1024, 0x0a); // 8 MiB of bare LF => ~4 M "lines"
  const before = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  const r = parseMultipart(huge, 'X'); // boundary "X" is absent from the body
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const grewMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
  assert.ok(hasMultipartAnomaly(r, 'no-boundary-found'), 'no delimiter present => no structure');
  assert.equal(r.parts.length, 0);
  assert.ok(grewMiB < 96, `heap growth stays bounded, not O(lines): grew ${grewMiB.toFixed(0)} MiB`);
  assert.ok(elapsedMs < 2000, `and completes promptly: ${elapsedMs.toFixed(0)} ms`);
});
