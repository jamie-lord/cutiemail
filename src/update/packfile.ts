/**
 * Packfile decoding: the format git ships objects in.
 *
 * Layout: `PACK`, a 4-byte version, a 4-byte object count, then that many objects, then a 20-byte
 * trailing checksum. Each object has a variable-length header giving its type and inflated size,
 * followed by a zlib stream. Two of the seven types are deltas against another object — by offset
 * within this pack (`OFS_DELTA`), or by object id (`REF_DELTA`).
 *
 * SAFETY. This is the first thing in the tree that parses attacker-influenceable binary data and
 * then writes files from it, so every dimension a hostile pack could grow along is bounded here:
 * total size, object count, each inflated object, and delta chain depth. `zlib.inflateSync` takes
 * `maxOutputLength`, which is the decompression-bomb defence. Anything malformed throws; the
 * updater treats a throw as "no update available" and leaves the running version alone, never as a
 * partial result.
 */

import { inflateSync } from 'node:zlib';
import { objectId, type GitObject, type GitObjectType } from './objects.ts';

export class PackfileError extends Error {}

export interface PackLimits {
  /** Whole pack, compressed. */
  readonly maxPackBytes: number;
  readonly maxObjects: number;
  /** Any single object, inflated. Bounds a zlib bomb. */
  readonly maxObjectBytes: number;
  /** How many deltas may chain before a full object is reached. */
  readonly maxDeltaDepth: number;
}

export const DEFAULT_PACK_LIMITS: PackLimits = {
  maxPackBytes: 256 * 1024 * 1024,
  maxObjects: 200_000,
  maxObjectBytes: 64 * 1024 * 1024,
  maxDeltaDepth: 64,
};

const TYPE_BY_CODE: Record<number, GitObjectType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

/** Object header varint: type in bits 4-6 of the first byte, size little-endian across the rest. */
function readObjectHeader(buf: Buffer, off: number): { type: number; size: number; next: number } {
  let b = buf[off];
  if (b === undefined) throw new PackfileError('truncated object header');
  const type = (b >> 4) & 0b111;
  let size = b & 0b1111;
  let shift = 4;
  let i = off + 1;
  while ((b & 0x80) !== 0) {
    b = buf[i];
    if (b === undefined) throw new PackfileError('truncated object header');
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
    i += 1;
    if (shift > 60) throw new PackfileError('object size varint is implausibly long');
  }
  return { type, size, next: i };
}

/** OFS_DELTA base offset: a different varint, big-endian with an implicit +1 per continuation. */
function readOffsetDelta(buf: Buffer, off: number): { distance: number; next: number } {
  let b = buf[off];
  if (b === undefined) throw new PackfileError('truncated delta offset');
  let value = b & 0x7f;
  let i = off + 1;
  while ((b & 0x80) !== 0) {
    b = buf[i];
    if (b === undefined) throw new PackfileError('truncated delta offset');
    value = (value + 1) * 128 + (b & 0x7f);
    i += 1;
    if (value > Number.MAX_SAFE_INTEGER / 128) throw new PackfileError('delta offset is implausibly large');
  }
  return { distance: value, next: i };
}

/**
 * Inflate one zlib stream starting at `off`, returning the data and where the stream ended.
 *
 * Node has no "inflate and tell me how many input bytes you used", so the end is found by trying
 * progressively larger windows. Objects are small relative to a pack and the growth is geometric,
 * so this stays cheap; the alternative is a hand-written inflate, which is a much larger surface
 * for no benefit.
 */
function inflateAt(buf: Buffer, off: number, expected: number, maxObjectBytes: number): { data: Buffer; next: number } {
  if (expected > maxObjectBytes) throw new PackfileError(`object claims ${expected} bytes, over the ${maxObjectBytes} cap`);
  const remaining = buf.length - off;
  let window = Math.min(remaining, Math.max(512, expected + 128));
  for (;;) {
    try {
      const slice = buf.subarray(off, off + window);
      const data = inflateSync(slice, { maxOutputLength: maxObjectBytes });
      if (data.length !== expected) throw new PackfileError(`inflated ${data.length} bytes, header said ${expected}`);
      // Re-inflate shrinking windows to find the true stream end, so the next object starts in the
      // right place. Binary search over the tail keeps this a handful of attempts.
      let lo = 0;
      let hi = window;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        try {
          const d = inflateSync(buf.subarray(off, off + mid), { maxOutputLength: maxObjectBytes });
          if (d.length === expected) hi = mid;
          else lo = mid + 1;
        } catch {
          lo = mid + 1;
        }
      }
      return { data, next: off + hi };
    } catch (e) {
      if (e instanceof PackfileError) throw e;
      if (window >= remaining) throw new PackfileError(`could not inflate object at ${off}: ${String(e)}`);
      window = Math.min(remaining, window * 4);
    }
  }
}

/** Apply a git delta: a header of two sizes, then copy-from-base and insert-literal opcodes. */
function applyDelta(base: Buffer, delta: Buffer, maxObjectBytes: number): Buffer {
  let off = 0;
  const varint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off];
      if (b === undefined) throw new PackfileError('truncated delta header');
      off += 1;
      v += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return v;
      shift += 7;
      if (shift > 60) throw new PackfileError('delta size varint is implausibly long');
    }
  };
  const baseSize = varint();
  const resultSize = varint();
  if (baseSize !== base.length) throw new PackfileError(`delta expects a ${baseSize}-byte base, got ${base.length}`);
  if (resultSize > maxObjectBytes) throw new PackfileError(`delta result ${resultSize} exceeds the ${maxObjectBytes} cap`);

  const out = Buffer.alloc(resultSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off]!;
    off += 1;
    if ((op & 0x80) !== 0) {
      // Copy from base: the low bits say which offset/size bytes are present.
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff |= delta[off++]!;
      if (op & 0x02) cpOff |= delta[off++]! << 8;
      if (op & 0x04) cpOff |= delta[off++]! << 16;
      if (op & 0x08) cpOff |= delta[off++]! * 2 ** 24;
      if (op & 0x10) cpSize |= delta[off++]!;
      if (op & 0x20) cpSize |= delta[off++]! << 8;
      if (op & 0x40) cpSize |= delta[off++]! << 16;
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new PackfileError('delta copies past the end of its base');
      if (written + cpSize > resultSize) throw new PackfileError('delta writes past its declared result size');
      base.copy(out, written, cpOff, cpOff + cpSize);
      written += cpSize;
    } else {
      // Insert literal: the opcode IS the length, and 0 is invalid.
      const n = op & 0x7f;
      if (n === 0) throw new PackfileError('delta insert opcode of length 0');
      if (off + n > delta.length) throw new PackfileError('delta insert runs past the end of the delta');
      if (written + n > resultSize) throw new PackfileError('delta writes past its declared result size');
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    }
  }
  if (written !== resultSize) throw new PackfileError(`delta produced ${written} bytes, declared ${resultSize}`);
  return out;
}

/**
 * Decode a packfile into objects keyed by id.
 *
 * `externalBase` supplies objects we already hold, so a thin pack (one that deltas against
 * something the server knows we have) resolves. Returns every object the pack defines, verified.
 */
export function decodePackfile(
  pack: Buffer,
  limits: PackLimits = DEFAULT_PACK_LIMITS,
  externalBase?: (id: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length > limits.maxPackBytes) throw new PackfileError(`pack is ${pack.length} bytes, over the ${limits.maxPackBytes} cap`);
  if (pack.length < 32) throw new PackfileError('pack is too short to be valid');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new PackfileError('pack does not start with the PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackfileError(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  if (count > limits.maxObjects) throw new PackfileError(`pack declares ${count} objects, over the ${limits.maxObjects} cap`);

  const byId = new Map<string, GitObject>();
  /** Objects by their offset in the pack, for OFS_DELTA bases. */
  const byOffset = new Map<number, GitObject>();
  /** Deltas whose base has not been seen yet, retried after the first pass. */
  const pending: Array<{ offset: number; baseId: string; delta: Buffer }> = [];

  const resolve = (id: string): GitObject | undefined => byId.get(id) ?? externalBase?.(id);

  let off = 12;
  for (let i = 0; i < count; i++) {
    const start = off;
    const head = readObjectHeader(pack, off);
    off = head.next;
    const kind = TYPE_BY_CODE[head.type];
    if (kind === undefined) throw new PackfileError(`unknown pack object type ${head.type}`);

    if (kind === 'ofs-delta') {
      const { distance, next } = readOffsetDelta(pack, off);
      off = next;
      const inflated = inflateAt(pack, off, head.size, limits.maxObjectBytes);
      off = inflated.next;
      const base = byOffset.get(start - distance);
      if (base === undefined) throw new PackfileError(`OFS_DELTA base at offset ${start - distance} not seen`);
      const data = applyDelta(base.data, inflated.data, limits.maxObjectBytes);
      const obj: GitObject = { type: base.type, data };
      byOffset.set(start, obj);
      byId.set(objectId(obj.type, obj.data), obj);
      continue;
    }

    if (kind === 'ref-delta') {
      const baseId = pack.subarray(off, off + 20).toString('hex');
      if (baseId.length !== 40) throw new PackfileError('truncated REF_DELTA base id');
      off += 20;
      const inflated = inflateAt(pack, off, head.size, limits.maxObjectBytes);
      off = inflated.next;
      const base = resolve(baseId);
      if (base === undefined) {
        pending.push({ offset: start, baseId, delta: inflated.data });
        continue;
      }
      const data = applyDelta(base.data, inflated.data, limits.maxObjectBytes);
      const obj: GitObject = { type: base.type, data };
      byOffset.set(start, obj);
      byId.set(objectId(obj.type, obj.data), obj);
      continue;
    }

    const inflated = inflateAt(pack, off, head.size, limits.maxObjectBytes);
    off = inflated.next;
    const obj: GitObject = { type: kind, data: inflated.data };
    byOffset.set(start, obj);
    byId.set(objectId(kind, inflated.data), obj);
  }

  // Deltas whose base arrived later in the pack. Each pass must make progress, so the loop is
  // bounded by the chain depth rather than by trust in the pack's ordering.
  for (let depth = 0; pending.length > 0; depth++) {
    if (depth > limits.maxDeltaDepth) throw new PackfileError(`delta chain deeper than ${limits.maxDeltaDepth}`);
    const before = pending.length;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]!;
      const base = resolve(p.baseId);
      if (base === undefined) continue;
      const data = applyDelta(base.data, p.delta, limits.maxObjectBytes);
      const obj: GitObject = { type: base.type, data };
      byOffset.set(p.offset, obj);
      byId.set(objectId(obj.type, obj.data), obj);
      pending.splice(i, 1);
    }
    if (pending.length === before) {
      throw new PackfileError(`pack has ${pending.length} delta(s) whose base never appears`);
    }
  }

  return byId;
}
