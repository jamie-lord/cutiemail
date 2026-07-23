/**
 * IP-literal helpers shared by the SSRF guard and the auth throttle.
 *
 * The one hard, shared, error-prone piece is parsing an IPv6 literal to its VALUE (bytes),
 * independent of how it is spelled. A regex/prefix check on the text misses non-canonical
 * equivalents — `0::ffff:127.0.0.1`, the fully-expanded `0:0:0:0:0:ffff:7f00:1`, `0000::ffff:…`,
 * `::ffff:0:127.0.0.1` — that all denote the same address. Classifying (private/loopback) and
 * keying (throttle /64) must both work on the parsed value, so both live on top of one parser.
 */

import { isIP } from 'node:net';

/**
 * Parse an IPv6 literal to its 8 hextets (each 0..65535), or null if it is not a valid IPv6
 * literal. Handles `::` zero-compression, a trailing embedded IPv4 (`::ffff:1.2.3.4`), surrounding
 * brackets, and a `%zone` suffix. Case-insensitive.
 */
export function ipv6Hextets(ip: string): number[] | null {
  let s = ip.trim().replace(/[[\]]/g, ''); // drop any surrounding brackets
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct); // drop a %zone-id suffix
  s = s.toLowerCase();
  if (s.length === 0) return null;

  // A trailing dotted-quad (embedded IPv4) becomes its two hextets before the rest is parsed.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.');
    if (octets.length !== 4) return null;
    const nums = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : -1));
    if (nums.some((n) => n < 0 || n > 255)) return null;
    const hi = ((nums[0]! << 8) | nums[1]!).toString(16);
    const lo = ((nums[2]! << 8) | nums[3]!).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const halves = s.split('::');
  if (halves.length > 2) return null; // more than one '::' is invalid
  let hextets: number[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0]!);
    const right = parseGroups(halves[1]!);
    if (left === null || right === null) return null;
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    hextets = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    const groups = parseGroups(s);
    if (groups === null) return null;
    hextets = groups;
  }
  return hextets.length === 8 ? hextets : null;
}

/** True when hextets encode an IPv4-mapped (::ffff:0:0/96) or IPv4-compatible/loopback (::/96)
 * address — i.e. the first five hextets are zero and the sixth is 0 or 0xffff. The embedded v4 is
 * hextets[6..7]; `::1` and `::` fall in here too (as 0.0.0.1 / 0.0.0.0). */
export function embeddedV4(hextets: number[]): string | null {
  const [a, b, c, d, e, f, g, h] = hextets;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0 || f === 0xffff)) {
    return `${g! >> 8}.${g! & 0xff}.${h! >> 8}.${h! & 0xff}`;
  }
  return null;
}

/** An IPv4/IPv6 literal in loopback, private, link-local, or unspecified space — the SSRF-guard
 *  predicate for a target the server must refuse to connect to. Classifies by VALUE: an IPv6
 *  literal is parsed to hextets first, so a private address cannot hide behind a non-canonical
 *  spelling of an IPv4-mapped form. */
export function isPrivateOrLoopback(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const p = ip.split('.').map(Number);
    const [a, b, c] = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
    return (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT (RFC 6598) — reaches internal infra in cloud/carrier nets
      (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking (RFC 2544)
      (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24 IETF + 192.0.2/24 TEST-NET-1
      (a === 198 && b === 51 && c === 100) || // 198.51.100/24 TEST-NET-2
      (a === 203 && b === 0 && c === 113) || // 203.0.113/24 TEST-NET-3
      a >= 224
    );
  }
  if (fam === 6) {
    const h = ipv6Hextets(ip);
    if (h === null) return false;
    // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible/loopback/unspecified (::/96) are only as safe
    // as the IPv4 they carry — `::1`/`::` decode to 0.0.0.1/0.0.0.0, which the v4 predicate rejects.
    const v4 = embeddedV4(h);
    if (v4 !== null) return isPrivateOrLoopback(v4);
    if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local (fc/fd)
    return false;
  }
  return false;
}

/**
 * The throttle key for a source address: IPv4 (and IPv4-mapped IPv6) key on the full address; a
 * real IPv6 client keys on its /64 routing prefix. Keying full IPv6 addresses let an attacker with
 * a single /64 (2^64 addresses, a standard delegation) evade the per-source failure window by
 * sourcing each guess from a fresh host address; the /64 key closes that while preserving the
 * "an attacker only locks out themselves" property (a legitimate user shares neither a /64 nor a
 * v4 with them). An unparseable value keys on itself (still per-source, fail-safe).
 */
export function throttleKey(ip: string): string {
  if (ip === '' || isIP(ip) === 4) return ip;
  const h = ipv6Hextets(ip);
  if (h === null) return ip;
  const v4 = embeddedV4(h);
  if (v4 !== null) return v4; // an IPv4-mapped client is really a v4 client — key on the v4.
  return `${h[0]!.toString(16)}:${h[1]!.toString(16)}:${h[2]!.toString(16)}:${h[3]!.toString(16)}::/64`;
}
