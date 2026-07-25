/**
 * Git's pkt-line framing, the envelope every smart-HTTP message travels in.
 *
 * A packet is four ASCII hex digits giving the length of the WHOLE packet including those four
 * bytes, then that many bytes of payload. Three lengths are special and carry no payload:
 *
 *   0000  flush-pkt         end of a section / message
 *   0001  delim-pkt         separates header from body in protocol v2
 *   0002  response-end-pkt  end of a v2 response
 *
 * Bytes, never strings — the same rule the SMTP and IMAP layers follow, and for the same reason:
 * a packfile is binary and a helpful UTF-16 round trip would corrupt it silently.
 */

/** A decoded packet: either a payload, or one of the three markers. */
export type Pkt =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * A remote controls these lengths, so bound them. Git's own limit is 65520 payload bytes; anything
 * claiming more is malformed rather than merely large.
 */
export const MAX_PKT_PAYLOAD = 65_516;

export class PktLineError extends Error {}

/** Encode a payload as one pkt-line. */
export function encodePkt(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > MAX_PKT_PAYLOAD) throw new PktLineError(`pkt payload ${body.length} exceeds ${MAX_PKT_PAYLOAD}`);
  const len = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len, 'ascii'), body]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

/**
 * Decode one packet from the head of `buf`.
 *
 * Returns null when more bytes are needed — the caller is streaming, and a partial packet is an
 * ordinary state, not an error. Mirrors the reply framer in wire/reply.ts.
 */
export function decodePkt(buf: Buffer): { pkt: Pkt; consumed: number } | null {
  if (buf.length < 4) return null;
  const header = buf.subarray(0, 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new PktLineError(`malformed pkt length ${JSON.stringify(header)}`);
  const len = parseInt(header, 16);
  if (len === 0) return { pkt: { kind: 'flush' }, consumed: 4 };
  if (len === 1) return { pkt: { kind: 'delim' }, consumed: 4 };
  if (len === 2) return { pkt: { kind: 'response-end' }, consumed: 4 };
  if (len === 3) throw new PktLineError('pkt length 3 is reserved and invalid');
  const total = len;
  if (total - 4 > MAX_PKT_PAYLOAD) throw new PktLineError(`pkt payload ${total - 4} exceeds ${MAX_PKT_PAYLOAD}`);
  if (buf.length < total) return null;
  return { pkt: { kind: 'data', payload: Buffer.from(buf.subarray(4, total)) }, consumed: total };
}

/** Decode every packet in a complete buffer. Throws if it ends mid-packet. */
export function decodeAll(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    const got = decodePkt(buf.subarray(off));
    if (got === null) throw new PktLineError(`truncated pkt stream at offset ${off}`);
    out.push(got.pkt);
    off += got.consumed;
  }
  return out;
}

/**
 * Strip git's side-band-64k multiplexing from a run of data packets.
 *
 * In the packfile section every payload begins with a band byte: 1 is pack data, 2 is human
 * progress text, 3 is a fatal error the server wants us to see. Progress is discarded; an error
 * band is raised, because a server that says "no such object" must not look like a short pack.
 */
export function demuxSideband(pkts: readonly Pkt[]): Buffer {
  const chunks: Buffer[] = [];
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    if (p.payload.length === 0) continue;
    const band = p.payload[0];
    const rest = p.payload.subarray(1);
    if (band === 1) chunks.push(rest);
    else if (band === 2) continue; // progress: for humans, not for us
    else if (band === 3) throw new PktLineError(`remote error: ${rest.toString('utf8').trim()}`);
    else throw new PktLineError(`unknown sideband ${String(band)}`);
  }
  return Buffer.concat(chunks);
}
