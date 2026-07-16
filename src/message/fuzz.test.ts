/**
 * Parser fuzzing. The parsers are the attack surface — a mail server takes bytes
 * from the open internet and must never crash or hang on them. Every parser here
 * is designed to RETURN a result with recorded anomalies, never to throw, so any
 * throw the fuzzer surfaces is a genuine robustness bug (and a DoS). This feeds
 * each parser thousands of adversarial inputs — pure random bytes, byte-level
 * mutations of valid seeds, and structural noise (repeated separators, deep
 * nesting) — under a fixed seed so a failure reproduces exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from './parse.ts';
import { parseAddrSpec } from './address.ts';
import { parseDate } from './date.ts';
import { parseResponse } from '../imap/response.ts';
import { parseCommand } from '../imap/command.ts';
import { parseSequenceSet } from '../imap/sequence-set.ts';
import { parseDkimSignature } from '../crypto/dkim-signature.ts';
import { parseDkimKeyRecord } from '../crypto/dkim-keyrecord.ts';
import { parseSpfRecord } from '../auth/spf.ts';
import { parseDmarcRecord } from '../auth/dmarc.ts';

/** Deterministic xorshift32 PRNG — reproducible fuzzing. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

/** Produce one fuzzed byte buffer, derived from `seed` bytes via a random strategy. */
function fuzzBytes(rand: () => number, seed: Buffer): Buffer {
  const strategy = Math.floor(rand() * 5);
  if (strategy === 0) {
    // Pure random bytes, random length.
    const n = Math.floor(rand() * 300);
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = Math.floor(rand() * 256);
    return b;
  }
  if (strategy === 1) {
    // Mutate the seed: flip/replace some bytes.
    const b = Buffer.from(seed);
    const muts = 1 + Math.floor(rand() * 8);
    for (let i = 0; i < muts && b.length > 0; i++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
    return b;
  }
  if (strategy === 2) {
    // Insert/delete bytes.
    const parts: number[] = [...seed];
    const ops = 1 + Math.floor(rand() * 20);
    for (let i = 0; i < ops; i++) {
      if (rand() < 0.5 && parts.length > 0) parts.splice(Math.floor(rand() * parts.length), 1);
      else parts.splice(Math.floor(rand() * (parts.length + 1)), 0, Math.floor(rand() * 256));
    }
    return Buffer.from(parts);
  }
  if (strategy === 3) {
    // Structural noise: repeat a punctuation/separator many times.
    const seps = ';:=<>()[]{}"\r\n\t @.,';
    const ch = seps[Math.floor(rand() * seps.length)]!;
    return Buffer.from(ch.repeat(1 + Math.floor(rand() * 500)), 'latin1');
  }
  // Truncations of the seed.
  return Buffer.from(seed.subarray(0, Math.floor(rand() * (seed.length + 1))));
}

const ITERATIONS = 3000;

/** Assert a Buffer parser never throws across the fuzz corpus. */
function fuzzParser(name: string, seedText: string, parse: (b: Buffer) => unknown): void {
  const rand = rng(0xc0ffee ^ [...name].reduce((a, c) => a + c.charCodeAt(0), 0));
  const seed = Buffer.from(seedText, 'latin1');
  for (let i = 0; i < ITERATIONS; i++) {
    const input = fuzzBytes(rand, seed);
    try {
      parse(input);
    } catch (e) {
      assert.fail(`${name} threw on fuzzed input #${i} (hex ${input.subarray(0, 60).toString('hex')}): ${String(e)}`);
    }
  }
}

test('parseMessage never throws on fuzzed input', () => {
  fuzzParser('parseMessage', 'From: a@b.test\r\nSubject: x\r\n\r\nbody line\r\n', (b) => parseMessage(b));
});
test('parseAddrSpec never throws on fuzzed input', () => {
  fuzzParser('parseAddrSpec', 'user.name+tag@sub.example.com', (b) => parseAddrSpec(b));
});
test('parseDate never throws on fuzzed input', () => {
  fuzzParser('parseDate', 'Mon, 16 Jul 2026 12:34:56 +0000', (b) => parseDate(b));
});
test('parseResponse never throws on fuzzed input', () => {
  fuzzParser('parseResponse', '* 3 FETCH (FLAGS (\\Seen) UID 7)', (b) => parseResponse(b));
});
test('parseCommand never throws on fuzzed input', () => {
  fuzzParser('parseCommand', 'a1 UID FETCH 1:* (BODY.PEEK[HEADER])', (b) => parseCommand(b));
});
test('parseDkimSignature never throws on fuzzed input', () => {
  fuzzParser('parseDkimSignature', 'v=1; a=rsa-sha256; c=relaxed/relaxed; d=x.test; s=sel; h=from:to; bh=aGVsbG8=; b=c2ln', (b) => parseDkimSignature(b));
});
test('parseDkimKeyRecord never throws on fuzzed input', () => {
  fuzzParser('parseDkimKeyRecord', 'v=DKIM1; k=rsa; p=MIGfMA0GCSq=', (b) => parseDkimKeyRecord(b));
});
test('parseSpfRecord never throws on fuzzed input', () => {
  fuzzParser('parseSpfRecord', 'v=spf1 ip4:1.2.3.4 include:_spf.example.com -all', (b) => parseSpfRecord(b));
});
test('parseDmarcRecord never throws on fuzzed input', () => {
  fuzzParser('parseDmarcRecord', 'v=DMARC1; p=quarantine; rua=mailto:a@b.test; pct=50', (b) => parseDmarcRecord(b));
});

test('parseSequenceSet never throws on fuzzed input', () => {
  const rand = rng(0x5eeded);
  const seed = Buffer.from('1:5,7,10:*,3');
  for (let i = 0; i < ITERATIONS; i++) {
    const input = fuzzBytes(rand, seed).toString('latin1');
    const largest = Math.floor(rand() * 1000);
    try {
      parseSequenceSet(input, largest);
    } catch (e) {
      assert.fail(`parseSequenceSet threw on ${JSON.stringify(input)} largest=${largest}: ${String(e)}`);
    }
  }
});
