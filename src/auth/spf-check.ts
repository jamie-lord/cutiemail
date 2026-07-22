/**
 * Inbound SPF evaluation (RFC 7208) — does the connecting IP match the sending
 * domain's published SPF policy?
 *
 * auth/spf.ts parses a record and evaluates ONE record synchronously against an
 * injected match predicate — corpus-shaped, no DNS, no include/redirect recursion.
 * A real check is async and recursive: fetch the domain's SPF TXT, walk its terms,
 * resolve a:/mx:/include:/redirect via DNS, CIDR-match the IP, and — critically —
 * enforce the §4.6.4 limit of 10 DNS-driven mechanisms so a hostile record cannot
 * fan the resolver out into a DoS. DNS is injected, so this whole evaluator is pure
 * and testable without a network.
 *
 * Scope: the mechanisms real senders use (all, ip4, ip6, a, mx, include, redirect,
 * exists). Macro (%{...}) expansion is not performed — a mechanism whose domain
 * contains a macro is treated as non-matching, which is safe (never a false pass).
 */

import net from 'node:net';
import { parseSpfRecord, type SpfTerm } from './spf.ts';

export type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'permerror' | 'temperror';

export interface SpfResolvers {
  /** SPF/TXT records for a name (each already a single joined string); [] if none, throws on DNS error. */
  readonly txt: (name: string) => Promise<readonly string[]>;
  /** A + AAAA addresses for a name; [] if none. */
  readonly a: (name: string) => Promise<readonly string[]>;
  /** MX target hostnames for a name, in any order; [] if none. */
  readonly mx: (name: string) => Promise<readonly string[]>;
}

const MAX_DNS_MECHANISMS = 10; // RFC 7208 §4.6.4
// RFC 7208 §4.6.4: "SPF implementations SHOULD limit 'void lookups' to two ... Exceeding the
// limit produces a 'permerror' result." A void lookup is a DNS query (a/mx/exists) that returns
// no records; unbounded, they let a hostile record fan the resolver out (the §11.1 third-party
// DoS) while sidestepping the ten-mechanism cap, since each empty lookup still costs a query.
const MAX_VOID_LOOKUPS = 2;

/** An IP address as a big integer plus its bit-width (32 for v4, 128 for v6), or null. */
function ipToBig(ip: string): { value: bigint; bits: 32 | 128 } | null {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    let v = 0n;
    for (const p of parts) v = (v << 8n) | BigInt(p);
    return { value: v, bits: 32 };
  }
  if (net.isIPv6(ip)) {
    const groups = ipv6Groups(ip);
    if (groups === null) return null;
    let v = 0n;
    for (const g of groups) v = (v << 16n) | BigInt(g);
    return { value: v, bits: 128 };
  }
  return null;
}

/** Expand an IPv6 string (already validated by net.isIPv6) into eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const part of s.split(':')) {
      if (part.includes('.')) {
        // Embedded IPv4 in the final group (e.g. ::ffff:1.2.3.4).
        const p = part.split('.').map((x) => Number(x));
        if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
        out.push((p[0]! << 8) | p[1]!, (p[2]! << 8) | p[3]!);
      } else {
        const n = parseInt(part, 16);
        if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
        out.push(n);
      }
    }
    return out;
  };
  const head = toGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    return [...head, ...Array(missing).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/** Does `ip` fall inside `cidr` (an address with an optional "/prefix")? */
function cidrMatch(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  const netAddr = slash === -1 ? cidr : cidr.slice(0, slash);
  const a = ipToBig(ip);
  const b = ipToBig(netAddr);
  if (a === null || b === null || a.bits !== b.bits) return false; // families must match
  const prefix = slash === -1 ? a.bits : Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > a.bits) return false;
  const shift = BigInt(a.bits - prefix);
  return a.value >> shift === b.value >> shift;
}

/** The dual-CIDR "/v4[//v6]" prefix suffix on an a/mx mechanism value, split off. */
function splitDualCidr(value: string): { domain: string; v4: number | null; v6: number | null } {
  const m = /^([^/]*)(?:\/(\d+))?(?:\/\/(\d+))?$/.exec(value);
  if (m === null) return { domain: value, v4: null, v6: null };
  return { domain: m[1] ?? '', v4: m[2] !== undefined ? Number(m[2]) : null, v6: m[3] !== undefined ? Number(m[3]) : null };
}

/** Apply the a/mx dual-cidr to a resolved address list: match if any address covers `ip`. */
function anyAddressMatches(ip: string, addresses: readonly string[], v4: number | null, v6: number | null): boolean {
  const ipIsV4 = net.isIPv4(ip);
  for (const addr of addresses) {
    const prefix = ipIsV4 ? v4 : v6;
    const cidr = prefix === null ? addr : `${addr}/${prefix}`;
    if (cidrMatch(ip, cidr)) return true;
  }
  return false;
}

interface EvalState {
  lookups: number;
  /** DNS-driven mechanisms that resolved to no records (RFC 7208 §4.6.4 void lookups). */
  voids: number;
  readonly resolvers: SpfResolvers;
  readonly ip: string;
}

const qualifierResult = (q: string): SpfResult => (q === '-' ? 'fail' : q === '~' ? 'softfail' : q === '?' ? 'neutral' : 'pass');

/** Evaluate the SPF policy for `domain`, recursing through include/redirect. */
async function evalDomain(domain: string, state: EvalState, depth: number): Promise<SpfResult> {
  if (depth > MAX_DNS_MECHANISMS) return 'permerror'; // include-nesting guard

  let txts: readonly string[];
  try {
    txts = await state.resolvers.txt(domain);
  } catch {
    return 'temperror';
  }
  const spfTxts = txts.filter((t) => t.toLowerCase().startsWith('v=spf1'));
  if (spfTxts.length === 0) return 'none';
  if (spfTxts.length > 1) return 'permerror'; // §4.5: multiple records is an error
  const record = parseSpfRecord(Buffer.from(spfTxts[0]!, 'latin1'));
  if (!record.valid) return 'permerror';

  let redirect: string | null = null;
  for (const term of record.terms) {
    if (term.isModifier) {
      if (term.mechanism === 'redirect' && term.value !== null) redirect = term.value;
      continue;
    }
    const matched = await matchMechanism(term, state, depth, domain);
    if (matched === 'error') return 'permerror';
    if (matched === 'temperror') return 'temperror';
    if (matched === true) return qualifierResult(term.qualifier);
  }
  // No mechanism matched: a redirect= takes over (§6.1); else the default is neutral.
  if (redirect !== null) {
    if (++state.lookups > MAX_DNS_MECHANISMS) return 'permerror';
    return evalDomain(redirect, state, depth + 1);
  }
  return 'neutral';
}

/** Whether one mechanism matches the connecting IP. Returns true/false or an error token. */
async function matchMechanism(term: SpfTerm, state: EvalState, depth: number, currentDomain: string): Promise<boolean | 'error' | 'temperror'> {
  const mech = term.mechanism;
  // The parser keeps the ":"/"/" delimiter on the value; strip a leading ":".
  const value = (term.value ?? '').replace(/^:/, '');
  if (value.includes('%')) return false; // macros unsupported → never a false pass

  switch (mech) {
    case 'all':
      return true;
    case 'ip4':
    case 'ip6':
      return cidrMatch(state.ip, value);
    case 'a':
    case 'mx':
    case 'include':
    case 'exists': {
      if (++state.lookups > MAX_DNS_MECHANISMS) return 'error';
      try {
        if (mech === 'a') {
          const { domain, v4, v6 } = splitDualCidr(value);
          const addrs = await state.resolvers.a(domain || currentDomain);
          if (addrs.length === 0 && ++state.voids > MAX_VOID_LOOKUPS) return 'error'; // §4.6.4
          return anyAddressMatches(state.ip, addrs, v4, v6);
        }
        if (mech === 'mx') {
          const { domain, v4, v6 } = splitDualCidr(value);
          const hosts = await state.resolvers.mx(domain || currentDomain);
          if (hosts.length === 0 && ++state.voids > MAX_VOID_LOOKUPS) return 'error'; // §4.6.4
          for (const host of hosts.slice(0, MAX_DNS_MECHANISMS)) {
            if (++state.lookups > MAX_DNS_MECHANISMS) return 'error';
            if (anyAddressMatches(state.ip, await state.resolvers.a(host), v4, v6)) return true;
          }
          return false;
        }
        if (mech === 'exists') {
          const addrs = await state.resolvers.a(value);
          if (addrs.length === 0 && ++state.voids > MAX_VOID_LOOKUPS) return 'error'; // §4.6.4
          return addrs.length > 0;
        }
        // include: matches only when the referenced policy yields "pass".
        const sub = await evalDomain(value, state, depth + 1);
        if (sub === 'temperror') return 'temperror';
        return sub === 'pass';
      } catch {
        return 'temperror';
      }
    }
    default:
      return false; // unknown mechanism — not a match
  }
}

/**
 * Check SPF for a received message. `domain` is the MAIL FROM domain (or the HELO
 * domain for a null return-path). Returns the SPF result to record in
 * Authentication-Results.
 */
export async function checkSpf(ip: string, domain: string, resolvers: SpfResolvers): Promise<SpfResult> {
  // On a dual-stack socket an IPv4 peer appears as an IPv4-mapped IPv6 address
  // (::ffff:1.2.3.4); treat it as the IPv4 address so ip4: mechanisms match.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const normalized = mapped !== null && net.isIPv4(mapped[1]!) ? mapped[1]! : ip;
  if (domain === '' || ipToBig(normalized) === null) return 'none';
  const state: EvalState = { lookups: 0, voids: 0, resolvers, ip: normalized };
  return evalDomain(domain, state, 0);
}
