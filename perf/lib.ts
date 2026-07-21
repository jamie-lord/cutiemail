/**
 * Shared helpers for the performance benchmarks (perf/*.bench.ts).
 *
 * These are NOT tests — they are throwaway measurement rigs that drive the real
 * production code paths (SqliteMailbox, the IMAP/SMTP servers) to find where the
 * server stops scaling. They live outside src/ so `npm test` and `tsc` ignore them.
 *
 * Bytes, never strings (the project rule) — a generated message is a Buffer built
 * to a target byte length, so "a 50k-message, 200 MB mailbox" means exactly that.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Wall-clock milliseconds for `fn()`. */
export function timed<T>(fn: () => T): { ms: number; value: T } {
  const t0 = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, value };
}

/** Resident-set size in MB, after a GC if --expose-gc is on (so the number is real). */
export function rssMB(): number {
  if (typeof globalThis.gc === 'function') globalThis.gc();
  return process.memoryUsage().rss / 1048576;
}

/** A scratch directory that cleans itself up. */
export function scratchDir(tag: string): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), `cutiemail-perf-${tag}-`));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function fileSizeMB(path: string): number {
  try {
    return statSync(path).size / 1048576;
  } catch {
    return 0;
  }
}

/**
 * A syntactically real RFC 5322 message of approximately `sizeBytes` total,
 * unique per `i`. Realistic shape: a handful of headers plus a body padded to
 * the target length — the average personal email is a few KB, so 4 KB is a fair
 * default and 50k of them is a ~200 MB mailbox (a few years of one person's mail).
 */
export function makeMessage(i: number, sizeBytes = 4096): Buffer {
  const headers =
    `From: sender${i}@example.com\r\n` +
    `To: recipient@example.net\r\n` +
    `Subject: perf message number ${i} with a moderately realistic subject line\r\n` +
    `Date: Mon, 19 Jul 2026 12:00:${(i % 60).toString().padStart(2, '0')} +0000\r\n` +
    `Message-ID: <${i}.${(i * 2654435761) >>> 0}@perf.example.com>\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=us-ascii\r\n` +
    `\r\n`;
  const head = Buffer.from(headers, 'latin1');
  const bodyLen = Math.max(0, sizeBytes - head.length);
  // Fill with printable bytes; vary by i so no two messages are byte-identical.
  const body = Buffer.alloc(bodyLen, 0x20);
  const seed = `msg-${i} `;
  for (let p = 0; p < bodyLen; p++) body[p] = 0x21 + ((p + i + seed.charCodeAt(p % seed.length)) % 94);
  return Buffer.concat([head, body]);
}

/** Right-pad / left-pad table cells. */
export function pad(s: string | number, w: number, right = false): string {
  const str = String(s);
  return right ? str.padEnd(w) : str.padStart(w);
}
