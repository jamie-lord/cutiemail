/**
 * An RFC 2047 'encoded-word' decoder, with switchable defects.
 *
 * Decodes the "=?charset?B?...?=" / "=?charset?Q?...?=" tokens that carry non-ASCII
 * text in headers, and — because this is a confusion/injection surface — enforces
 * the structural and placement rules that bound the trick: no whitespace inside a
 * token, a 75-character ceiling, never inside an address, and inter-word whitespace
 * dropped on concatenation. A malformed token is left as literal text, never
 * silently decoded, so a hidden payload cannot ride in on a broken encoded-word.
 *
 * Charset conversion is deliberately NOT applied here: the decoder yields the raw
 * decoded octets (post-base64 / post-Q), leaving charset transcoding to a separate
 * step. Bytes, never strings: the token structure is ASCII, but the decoded content
 * is arbitrary octets.
 */

import type { Header } from './model.ts';

export interface EncodedWordDefects {
  /** Decode a token that has whitespace between its components. Violates R-2047-2-a. */
  readonly acceptInternalWhitespace?: boolean;
  /** Do not flag a token longer than 75 characters. Violates R-2047-2-b. */
  readonly acceptOverlongWord?: boolean;
  /** Decode an encoded-word even in addr-spec context. Violates R-2047-5-a. */
  readonly decodeInAddrSpec?: boolean;
  /** Keep the whitespace between two adjacent encoded-words. Violates R-2047-6.2-a. */
  readonly keepInterWordWhitespace?: boolean;
}

export interface DecodeOptions extends EncodedWordDefects {
  /** True when decoding within an address (local-part/domain): encoded-words are forbidden. */
  readonly addrSpecContext?: boolean;
}

export interface DecodeResult {
  /** The decoded output octets. Valid encoded-words are decoded; malformed ones pass through literally. */
  readonly text: Buffer;
  readonly anomalies: readonly string[];
}

interface Segment {
  readonly isWord: boolean;
  readonly bytes: Buffer;
  /** For non-word (literal) segments: whether it is pure whitespace. */
  readonly whitespaceOnly: boolean;
}

/** Decode "Q" encoding: '_' -> SP, "=XX" -> that octet, everything else verbatim. */
function decodeQ(text: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '_') {
      out.push(0x20);
    } else if (c === '=' && i + 2 < text.length + 1) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else {
        out.push(c.charCodeAt(0));
      }
    } else {
      out.push(c.charCodeAt(0));
    }
  }
  return Buffer.from(out);
}

const isWhitespaceOnly = (s: string): boolean => /^[ \t\r\n]*$/.test(s);

export function decodeEncodedWords(input: Buffer, opts: DecodeOptions = {}): DecodeResult {
  const s = input.toString('latin1');
  // Permissive token match (allows internal whitespace, so we can DETECT and reject it).
  const re = /=\?([^?]*)\?([^?]*)\?([^?]*)\?=/g;
  const segments: Segment[] = [];
  const anomalies = new Set<string>();
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  const pushLiteral = (text: string): void => {
    if (text.length === 0) return;
    segments.push({ isWord: false, bytes: Buffer.from(text, 'latin1'), whitespaceOnly: isWhitespaceOnly(text) });
  };

  while ((m = re.exec(s)) !== null) {
    const full = m[0];
    const charset = m[1] ?? '';
    const enc = (m[2] ?? '').toUpperCase();
    const text = m[3] ?? '';
    if (m.index > lastIndex) pushLiteral(s.slice(lastIndex, m.index));
    lastIndex = m.index + full.length;

    const hasInternalWs = /[ \t]/.test(charset) || /[ \t]/.test(m[2] ?? '') || /[ \t]/.test(text);
    if (hasInternalWs && opts.acceptInternalWhitespace !== true) {
      anomalies.add('internal-whitespace');
      pushLiteral(full); // not a valid encoded-word — leave it literal
      continue;
    }
    if (enc !== 'B' && enc !== 'Q') {
      pushLiteral(full); // unknown encoding — not decodable
      continue;
    }
    if (full.length > 75 && opts.acceptOverlongWord !== true) {
      anomalies.add('overlong-word');
    }
    if (opts.addrSpecContext === true && opts.decodeInAddrSpec !== true) {
      anomalies.add('encoded-word-in-addr-spec');
      pushLiteral(full); // forbidden here — do not decode
      continue;
    }
    const bytes = enc === 'B' ? Buffer.from(text, 'base64') : decodeQ(text);
    segments.push({ isWord: true, bytes, whitespaceOnly: false });
  }
  if (lastIndex < s.length) pushLiteral(s.slice(lastIndex));

  // Join, dropping whitespace-only literals that sit between two encoded-words.
  const out: Buffer[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (!seg.isWord && seg.whitespaceOnly) {
      const prevWord = i > 0 && segments[i - 1]!.isWord;
      const nextWord = i + 1 < segments.length && segments[i + 1]!.isWord;
      if (prevWord && nextWord && opts.keepInterWordWhitespace !== true) continue;
    }
    out.push(seg.bytes);
  }
  return { text: Buffer.concat(out), anomalies: [...anomalies] };
}

/** Convenience: decode a header's value in the ordinary (non-address) context. */
export function decodeHeaderValue(header: Header, opts: DecodeOptions = {}): DecodeResult {
  return decodeEncodedWords(header.value, opts);
}

/** True if `kind` is present in the decode anomalies. */
export function hasEncodedWordAnomaly(result: DecodeResult, kind: string): boolean {
  return result.anomalies.includes(kind);
}
