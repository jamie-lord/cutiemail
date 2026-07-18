/**
 * Outbound relay — the send leg wired to the real internet.
 *
 * This is the loop that was missing: when an authenticated client submits a
 * message for a remote recipient, resolve that recipient's MX and deliver to it.
 * It composes the two tested pieces — `resolveMxHosts` (RFC 5321 §5.1 ordering)
 * and `deliver` (the client-side transaction) — and adds the one thing neither
 * had: a real DNS lookup, snapshotted into the synchronous resolver interface the
 * ordering logic expects, so that logic stays the exact code the corpus trusts.
 *
 * Deliberately naive, per the current goal (a deployable test bench, not a
 * hardened MTA): best-effort, no persistent queue, no retry/backoff, plaintext to
 * port 25 (no outbound STARTTLS yet), no DKIM signing. A failed relay is LOGGED,
 * not queued — the operator sees it on the console. Each of those is a recorded
 * next increment, not an oversight. See docs/DEPLOYMENT.md.
 */

import net from 'node:net';
import { resolveMx, resolve4, resolve6 } from 'node:dns/promises';
import { deliver } from '../client/deliver.ts';
import { resolveMxHosts, type DnsResolver, type MxRecord } from '../client/mx.ts';
import { mxAllowed, type StsPolicy } from '../transport/mta-sts.ts';

/** An IPv4/IPv6 literal in loopback, private, link-local, or unspecified space. */
function isPrivateOrLoopback(ip: string): boolean {
  const fam = net.isIP(ip);
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
    const low = ip.toLowerCase().replace(/^\[|\]$/g, '');
    return low === '::1' || low === '::' || low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd');
  }
  return false;
}

/**
 * A MX target we must refuse to relay to on its LITERAL form (SSRF guard). An attacker who
 * controls a recipient domain's DNS can publish "MX 0 127.0.0.1" (or a private/link-local
 * address, or "localhost") to make us open a port-25 connection to an internal host. A
 * public domain's MX is never legitimately loopback/private, so refuse those outright. The
 * companion `resolvesToPrivate` closes the hostname-that-resolves-to-a-private-IP case.
 */
export function isUnsafeMxTarget(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return net.isIP(host) !== 0 && isPrivateOrLoopback(host);
}

/**
 * True when an MX HOSTNAME resolves (over IPv4) to a private/loopback address — the SSRF
 * case `isUnsafeMxTarget` (a literal-form check) misses: an attacker publishes an MX name
 * that resolves to 127.0.0.1 / 169.254.169.254 / 10.x. Checked just before connecting, so
 * the static hostname→private attack is closed. A narrow DNS-rebinding window remains (the
 * OS re-resolves at connect time); pinning to the vetted address would need threading the
 * TLS servername separately and is deferred. `resolve4` because relay connects family:4.
 */
export async function resolvesToPrivate(host: string, resolve: (h: string) => Promise<readonly string[]> = resolve4): Promise<boolean> {
  if (net.isIP(host) !== 0) return false; // a literal IP is already handled by isUnsafeMxTarget
  let addrs: readonly string[] = [];
  try {
    addrs = await resolve(host);
  } catch {
    addrs = [];
  }
  return addrs.some(isPrivateOrLoopback);
}

/** The envelope + bytes to relay — the subset of a delivered message relay needs. */
export interface RelayableMessage {
  readonly from: string;
  readonly recipients: readonly string[];
  readonly data: Buffer;
}

export interface OutboundOptions {
  /** The name to announce in EHLO/HELO — our own server's hostname. */
  readonly clientName: string;
  /**
   * How to turn a recipient domain into an ordered host list. Defaults to real
   * DNS (`realDnsHosts`); injected in tests to point delivery at a capture server.
   */
  readonly resolveHosts?: (domain: string) => Promise<readonly string[]>;
  /** The port to deliver on. Defaults to 25 (the SMTP relay port). */
  readonly port?: number;
  /** Where to report per-recipient relay outcomes. Defaults to swallowing them. */
  readonly log?: (line: string) => void;
  /**
   * Resolve a recipient domain's MTA-STS policy (RFC 8461). Undefined = MTA-STS off
   * (opportunistic TLS only, the default). In production this is a DNS + cert-validated
   * HTTPS fetch behind a max_age cache; an ENFORCE policy restricts delivery to a
   * policy-listed MX over a validated certificate.
   */
  readonly resolveStsPolicy?: (domain: string) => Promise<StsPolicy | null>;
}

export interface RelayResult {
  readonly recipient: string;
  readonly ok: boolean;
  /** For the retry queue: success · transient (retry) · permanent (bounce). */
  readonly classification: 'success' | 'transient' | 'permanent';
  readonly detail: string;
}

/** The domain half of an address, or '' if there is no '@'. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}

/**
 * Split recipients into those this server is the final destination for (its own
 * domain) and those that must be relayed onward. The naive single-domain rule:
 * local iff the domain equals ours (case-insensitively).
 */
export function routeRecipients(
  recipients: readonly string[],
  localDomain: string,
): { readonly local: readonly string[]; readonly remote: readonly string[] } {
  const local: string[] = [];
  const remote: string[] = [];
  const ours = localDomain.toLowerCase();
  for (const r of recipients) {
    if (domainOf(r).toLowerCase() === ours) local.push(r);
    else remote.push(r);
  }
  return { local, remote };
}

/**
 * Resolve the ordered delivery hosts for a domain over real DNS, then hand the
 * result to the tested `resolveMxHosts` so the §5.1 preference/implicit-MX logic
 * is reused verbatim rather than re-implemented here.
 */
async function realDnsHosts(domain: string): Promise<readonly string[]> {
  let mx: MxRecord[] = [];
  try {
    const records = await resolveMx(domain);
    mx = records.map((r) => ({ host: r.exchange, preference: r.priority }));
  } catch {
    mx = [];
  }

  let hasAddress = false;
  if (mx.length === 0) {
    // Only an implicit MX (the domain's own A/AAAA) is consulted when no MX exists.
    try {
      hasAddress = (await resolve4(domain)).length > 0;
    } catch {
      hasAddress = false;
    }
    if (!hasAddress) {
      try {
        hasAddress = (await resolve6(domain)).length > 0;
      } catch {
        hasAddress = false;
      }
    }
  }

  const snapshot: DnsResolver = { mx: () => mx, hasAddress: () => hasAddress };
  return resolveMxHosts(domain, snapshot).hosts;
}

/**
 * Relay a message to each of its recipients' mail servers. One recipient at a
 * time, trying that recipient's MX hosts in preference order until one accepts.
 * Never throws: every recipient yields a RelayResult, so a caller can log the lot.
 */
export async function relayOutbound(msg: RelayableMessage, opts: OutboundOptions): Promise<readonly RelayResult[]> {
  const resolveHosts = opts.resolveHosts ?? realDnsHosts;
  const port = opts.port ?? 25;
  // The SSRF guard applies to targets that came from untrusted DNS (the real resolver).
  // A caller that injects its own resolveHosts (tests, or a trusted internal resolver)
  // is responsible for its own targets, so the guard steps aside for it.
  const guardTargets = opts.resolveHosts === undefined;
  const results: RelayResult[] = [];

  for (const recipient of msg.recipients) {
    const domain = domainOf(recipient);
    if (domain === '') {
      // A malformed recipient is never deliverable — bounce, do not retry.
      results.push({ recipient, ok: false, classification: 'permanent', detail: 'no domain in recipient address' });
      continue;
    }

    let hosts: readonly string[];
    try {
      hosts = await resolveHosts(domain);
    } catch (e) {
      // A DNS failure is transient — the domain may resolve on a later attempt.
      results.push({ recipient, ok: false, classification: 'transient', detail: `MX lookup failed: ${String(e)}` });
      continue;
    }
    if (hosts.length === 1 && hosts[0] === '.') {
      // RFC 7505: a null MX ("MX 0 .") is an explicit statement that the domain
      // accepts NO mail. Bounce immediately rather than retry to host "." until the
      // give-up window — the sender should learn of the permanent failure now.
      results.push({ recipient, ok: false, classification: 'permanent', detail: `${domain} accepts no mail (null MX, RFC 7505)` });
      continue;
    }
    if (hosts.length === 0) {
      // No MX/A right now — treat as transient (conservative: a temporary DNS
      // gap must not bounce mail; a truly dead domain bounces after give-up).
      results.push({ recipient, ok: false, classification: 'transient', detail: `no MX or address record for ${domain}` });
      continue;
    }

    // MTA-STS (RFC 8461): a domain publishing an ENFORCE policy requires that we deliver
    // only to a policy-listed MX and only over a validated certificate — an active
    // downgrade/MITM defense. A fetch failure or a testing/none policy leaves the default
    // opportunistic behavior untouched (mail must not be blocked by a broken policy).
    let policy: StsPolicy | null = null;
    try {
      policy = opts.resolveStsPolicy !== undefined ? await opts.resolveStsPolicy(domain) : null;
    } catch {
      policy = null;
    }
    const enforce = policy !== null && policy.valid && policy.mode === 'enforce';
    let candidateHosts = hosts;
    if (enforce) {
      candidateHosts = hosts.filter((h) => mxAllowed(policy!, h));
      if (candidateHosts.length === 0) {
        // No MX matches the enforce policy — a misconfiguration or an attack. Defer rather
        // than deliver to an unlisted host; never downgrade.
        opts.log?.(`MTA-STS enforce: no MX for ${domain} matches the policy — deferring`);
        results.push({ recipient, ok: false, classification: 'transient', detail: `no MX matches the MTA-STS enforce policy for ${domain}` });
        continue;
      }
    }

    let delivered = false;
    let lastError = '';
    let lastClass: 'transient' | 'permanent' = 'transient';
    for (const host of candidateHosts) {
      // SSRF guard: never open a relay connection to a loopback/private MX target that a
      // hostile recipient-domain DNS could have pointed us at — as a literal IP/localhost
      // (isUnsafeMxTarget) OR as a hostname that resolves to a private address
      // (resolvesToPrivate, a pre-connect DNS lookup).
      if (guardTargets && (isUnsafeMxTarget(host) || (await resolvesToPrivate(host)))) {
        lastError = `refusing to relay to non-public MX target ${host}`;
        lastClass = 'permanent';
        continue;
      }
      try {
        // family: 4 — Gmail 550s IPv6 connections without a matching v6 PTR;
        // our PTR is set for the v4 address, so relay over IPv4 only.
        const target = { host, port, tls: 'none' as const, family: 4 as const };
        const envelope = { from: msg.from, recipients: [recipient], data: msg.data, clientName: opts.clientName };
        let r = await deliver(target, envelope, {}, undefined, { startTls: true, requireValidCert: enforce });
        // Opportunistic STARTTLS (RFC 3207): if the handshake itself failed, the MX
        // advertised TLS it cannot complete — retry the same host in plaintext rather than
        // bounce. NOT under MTA-STS enforce: there a TLS/cert failure is terminal (its
        // distinct failure string never matches here), so we never downgrade.
        if (!r.ok && !enforce && r.failure === 'STARTTLS handshake failed') {
          r = await deliver(target, envelope, {}, undefined, { startTls: false });
        }
        if (r.ok) {
          results.push({ recipient, ok: true, classification: 'success', detail: `delivered via ${host}` });
          delivered = true;
          break;
        }
        lastError = r.failure ?? `refused (data ${r.dataCode ?? '?'})`;
        // The code that refused us, in transaction order. 5yz = permanent (bounce);
        // 4yz or a dropped connection = transient (retry).
        const code = r.dataCode ?? r.rcptCodes.find((c) => c >= 400) ?? r.mailCode ?? r.greetingCode;
        lastClass = code !== null && code >= 500 && code < 600 ? 'permanent' : 'transient';
      } catch (e) {
        lastError = String(e);
        lastClass = 'transient';
      }
    }
    if (!delivered) results.push({ recipient, ok: false, classification: lastClass, detail: `all hosts failed: ${lastError || 'unknown'}` });
  }

  return results;
}
