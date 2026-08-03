/**
 * Packfile decoding, with a negative control for each bound.
 *
 * The pack is the first attacker-influenceable binary input in the tree, so every dimension it
 * could grow along has a limit and every limit has a test that proves it fires. Packs are built
 * here byte by byte rather than captured from a fixture, so a case says exactly what it is testing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodePackfile, PackfileError, DEFAULT_PACK_LIMITS } from './packfile.ts';
import { objectId, type GitObject } from './objects.ts';

const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 } as const;

/** The variable-length type+size header git puts in front of each packed object. */
function objectHeader(typeCode: number, size: number): Buffer {
  const out: number[] = [];
  let b = (typeCode << 4) | (size & 0b1111);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(b | 0x80);
    b = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(b);
  return Buffer.from(out);
}

interface PackEntry {
  readonly typeCode: number;
  readonly content: Buffer;
  /** Raw bytes placed between the header and the zlib stream (a delta's base reference). */
  readonly prefix?: Buffer;
}

function buildPack(entries: readonly PackEntry[], countOverride?: number): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(countOverride ?? entries.length, 8);
  const parts: Buffer[] = [head];
  for (const e of entries) {
    parts.push(objectHeader(e.typeCode, e.content.length));
    if (e.prefix !== undefined) parts.push(e.prefix);
    parts.push(deflateSync(e.content));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

const blobEntry = (s: string): PackEntry => ({ typeCode: TYPE_CODE.blob, content: Buffer.from(s, 'latin1') });

/** Delta size varint: 7 bits per byte, low first, high bit set while more follow. */
function deltaVarint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

/** A delta that copies the whole base then appends `tail`. */
function appendDelta(baseLen: number, resultLen: number, tail: Buffer): Buffer {
  return Buffer.concat([
    deltaVarint(baseLen),
    deltaVarint(resultLen),
    Buffer.from([0b1001_0001, 0, baseLen]), // copy: offset byte 0 present, size byte 0 present
    Buffer.from([tail.length]),
    tail,
  ]);
}

test('a plain pack decodes, and every object verifies against its id', () => {
  const a = 'hello\n';
  const b = 'a longer blob, still small\n';
  const objects = decodePackfile(buildPack([blobEntry(a), blobEntry(b)]));
  assert.equal(objects.size, 2);
  assert.equal(objects.get(objectId('blob', Buffer.from(a, 'latin1')))?.data.toString('latin1'), a);
  assert.equal(objects.get(objectId('blob', Buffer.from(b, 'latin1')))?.data.toString('latin1'), b);
});

test('a REF_DELTA resolves against a base in the same pack', () => {
  const base = 'the quick brown fox jumps over the lazy dog\n';
  const baseBuf = Buffer.from(base, 'latin1');
  const baseId = objectId('blob', baseBuf);
  const result = Buffer.from(`${base}and then again\n`, 'latin1');

  // Delta: base size, result size, one copy of the whole base, then a literal insert.
  const tail = Buffer.from('and then again\n', 'latin1');
  const delta = appendDelta(baseBuf.length, result.length, tail);

  const objects = decodePackfile(
    buildPack([
      { typeCode: TYPE_CODE.blob, content: baseBuf },
      { typeCode: 7, content: delta, prefix: Buffer.from(baseId, 'hex') },
    ]),
  );
  assert.equal(objects.get(objectId('blob', result))?.data.toString('latin1'), result.toString('latin1'));
});

test('a delta whose base never appears is refused, not silently dropped', () => {
  const missing = 'f'.repeat(40);
  const delta = appendDelta(4, 4, Buffer.alloc(0)).subarray(0, 5);
  assert.throws(
    () => decodePackfile(buildPack([{ typeCode: 7, content: delta, prefix: Buffer.from(missing, 'hex') }])),
    /base never appears/,
  );
});

test('a delta that copies past the end of its base is refused', () => {
  const baseBuf = Buffer.from('short\n', 'latin1');
  const baseId = objectId('blob', baseBuf);
  // Copy 200 bytes from a 6-byte base.
  const delta = Buffer.concat([deltaVarint(baseBuf.length), deltaVarint(200), Buffer.from([0b1001_0001, 0, 200])]);
  assert.throws(
    () =>
      decodePackfile(
        buildPack([
          { typeCode: TYPE_CODE.blob, content: baseBuf },
          { typeCode: 7, content: delta, prefix: Buffer.from(baseId, 'hex') },
        ]),
      ),
    /copies past the end of its base/,
  );
});

test('a copy-offset with the high byte set is a PackfileError, not a raw RangeError', () => {
  // op 0x98 = copy (0x80) + offset byte 3 (0x08) + size byte 0 (0x10); the offset byte is 0xFF, so
  // cpOff is 0xFF000000. With the old `|=` that coerced to a NEGATIVE int32, the "past the end" guard
  // saw a negative sum, passed, and base.copy(..., negative, ...) threw a raw RangeError. With `+=`
  // cpOff keeps its true (large) value and the guard rejects it as the module's own PackfileError.
  const baseBuf = Buffer.from('base!', 'latin1');
  const baseId = objectId('blob', baseBuf);
  const delta = Buffer.concat([deltaVarint(baseBuf.length), deltaVarint(1), Buffer.from([0x98, 0xff, 1])]);
  const run = (): unknown =>
    decodePackfile(
      buildPack([
        { typeCode: TYPE_CODE.blob, content: baseBuf },
        { typeCode: 7, content: delta, prefix: Buffer.from(baseId, 'hex') },
      ]),
    );
  assert.throws(run, PackfileError, 'a hostile offset is a clean refusal');
  assert.throws(run, /copies past the end of its base/);
});

test('the aggregate of resolved object bytes is bounded, not just each object and the count', () => {
  // Per-object and per-count caps leave the SUM unbounded: many small deltas each expanding a shared
  // base materialise gigabytes of live buffers from a tiny pack. A handful of blobs whose combined
  // inflated size exceeds a low maxResolvedBytes must be refused.
  const blobs = ['aaaa', 'bbbb', 'cccc', 'dddd'].map(blobEntry);
  assert.throws(
    () => decodePackfile(buildPack(blobs), { ...DEFAULT_PACK_LIMITS, maxResolvedBytes: 8 }),
    /aggregate cap/,
  );
  // The negative control: the same pack under the default cap decodes fine, so the refusal is the
  // aggregate bound and not something else about the pack.
  assert.equal(decodePackfile(buildPack(blobs)).size, 4);
});

test('a decompression bomb is stopped by the per-object cap, not by memory pressure', () => {
  // 8 MiB of zeroes compresses to a few KiB; the cap is what refuses it.
  const bomb = Buffer.alloc(8 * 1024 * 1024, 0);
  const pack = buildPack([{ typeCode: TYPE_CODE.blob, content: bomb }]);
  assert.throws(
    () => decodePackfile(pack, { ...DEFAULT_PACK_LIMITS, maxObjectBytes: 64 * 1024 }),
    /over the 65536 cap/,
  );
});

test('the pack, object-count and version bounds all refuse rather than truncate', () => {
  assert.throws(() => decodePackfile(Buffer.from('nope')), /too short/);

  const good = buildPack([blobEntry('x')]);
  const wrongMagic = Buffer.from(good);
  wrongMagic.write('PACX', 0, 'ascii');
  assert.throws(() => decodePackfile(wrongMagic), /PACK signature/);

  const wrongVersion = Buffer.from(good);
  wrongVersion.writeUInt32BE(9, 4);
  assert.throws(() => decodePackfile(wrongVersion), /unsupported pack version/);

  assert.throws(
    () => decodePackfile(buildPack([blobEntry('x')]), { ...DEFAULT_PACK_LIMITS, maxObjects: 0 }),
    /over the 0 cap/,
  );
  assert.throws(
    () => decodePackfile(good, { ...DEFAULT_PACK_LIMITS, maxPackBytes: 8 }),
    /over the 8 cap/,
  );
});

test('an unknown object type is refused', () => {
  assert.throws(() => decodePackfile(buildPack([{ typeCode: 5, content: Buffer.from('x') }])), PackfileError);
});

test('a truncated pack (count promises more objects than are present) is refused', () => {
  assert.throws(() => decodePackfile(buildPack([blobEntry('x')], 4)), PackfileError);
});

test('a thin pack resolves against objects we already hold', () => {
  const baseBuf = Buffer.from('base content here\n', 'latin1');
  const baseId = objectId('blob', baseBuf);
  const held: GitObject = { type: 'blob', data: baseBuf };
  const tail = Buffer.from('!\n', 'latin1');
  const result = Buffer.concat([baseBuf, tail]);
  const delta = appendDelta(baseBuf.length, result.length, tail);
  const objects = decodePackfile(
    buildPack([{ typeCode: 7, content: delta, prefix: Buffer.from(baseId, 'hex') }]),
    DEFAULT_PACK_LIMITS,
    (id) => (id === baseId ? held : undefined),
  );
  assert.equal(objects.get(objectId('blob', result))?.data.toString('latin1'), result.toString('latin1'));
});
