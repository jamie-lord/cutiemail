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
import { resolveMx, resolve4 } from 'node:dns/promises';
import { deliver } from '../client/deliver.ts';
import { resolveMxHosts, type DnsResolver, type MxRecord } from '../client/mx.ts';
import { mxAllowed, type StsPolicy } from '../transport/mta-sts.ts';
import { isPrivateOrLoopback } from '../wire/ip.ts';

/**
 * A MX target we must refuse to relay to on its LITERAL form (SSRF guard). An attacker who
 * controls a recipient domain's DNS can publish "MX 0 127.0.0.1" (or a private/link-local
 * address, or "localhost") to make us open a port-25 connection to an internal host. A
 * public domain's MX is never legitimately loopback/private, so refuse those outright. The
 * companion `resolvesToPrivate` closes the hostname-that-resolves-to-a-private-IP case.
 */
export function isUnsafeMxTarget(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  // An empty/whitespace host is never a valid public MX; refuse it outright. net.connect
  // resolves an empty host to localhost, so this is the backstop for any null-MX ('' / '.')
  // target that slips past the resolver's RFC 7505 normalisation.
  if (h.trim() === '' || h === '.') return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return net.isIP(host) !== 0 && isPrivateOrLoopback(host);
}

/**
 * Vet an MX HOSTNAME and return a vetted IP to connect to, or null to refuse. This closes
 * the SSRF case `isUnsafeMxTarget` (a literal-form check) misses: an attacker publishes an
 * MX name that resolves to 127.0.0.1 / 169.254.169.254 / 10.x. The host is resolved ONCE
 * (over IPv4 — relay connects family:4) and, if EVERY address is public, one is returned to
 * be PINNED as the connect target. Pinning the vetted IP — rather than reconnecting by name
 * and letting the OS re-resolve — closes the DNS-rebinding TOCTOU window (an attacker
 * flipping the record from public to private between the check and the connect); the caller
 * validates the certificate against the original hostname via TLS servername. Returns null
 * when the name does not resolve, or ANY address is private/loopback (a mixed public+private
 * answer is refused wholesale). A literal-IP host is returned as-is — its literal form was
 * already vetted by isUnsafeMxTarget.
 */
export async function vetMxHost(
  host: string,
  resolve: (h: string) => Promise<readonly string[]> = resolve4,
): Promise<{ ip: string } | { permanent: boolean }> {
  if (net.isIP(host) !== 0) return { ip: host }; // a literal IP is already handled by isUnsafeMxTarget
  let addrs: readonly string[] = [];
  try {
    addrs = await resolve(host);
  } catch {
    return { permanent: false }; // a DNS failure is transient — retry, don't bounce
  }
  if (addrs.length === 0) return { permanent: false }; // no A records → transient, same as a lookup miss
  if (addrs.some(isPrivateOrLoopback)) return { permanent: true }; // SSRF — refuse permanently
  return { ip: addrs[0]! }; // pin a vetted public address as the connect target
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
  /**
   * Extra TLS options threaded into the STARTTLS handshake (see DeliveryOptions.tlsOptions). The
   * load-bearing use is `ca`, so an MTA-STS-enforce POSITIVE control can prove enforce delivers
   * to a cert that chains to a trusted root. Production leaves it unset (system trust store).
   */
  readonly tlsOptions?: import('node:tls').ConnectionOptions;
  /**
   * Override the post-<CRLF>.<CRLF> reply timeout (RFC 5321 §4.5.3.2.6, default 10 min in the
   * client). Exposed for tuning and for tests that exercise the indeterminate-outcome path.
   */
  readonly postDataReplyTimeoutMs?: number;
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
    // Only an implicit MX (the domain's own address) is consulted when no MX exists - and only
    // an IPv4 (A) one. This relay deliberately connects family:4 (Gmail and other large
    // receivers 550 IPv6 without a matching v6 PTR, which we set for v4 only). An AAAA-only
    // domain is therefore NOT counted as deliverable: were it counted, we would hand the loop a
    // host we then cannot dial over IPv4, burning an attempt (and eventually a misleading 5.4.7
    // "delivery time expired") on every retry for five days. Dropping it here surfaces the
    // honest "no usable (IPv4) address" outcome instead. This is our IPv4-only limitation, not
    // the destination's permanent failure, so it stays transient rather than a hard bounce - a
    // domain may add an A record, and a future dual-stack relay could reach it. (See report:
    // making a v6-only destination a prompt permanent bounce is a deliverability policy call.)
    try {
      hasAddress = (await resolve4(domain)).length > 0;
    } catch {
      hasAddress = false;
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

    // Multi-MX aggregate classification (RFC 5321 §5.1 / §4.5.4.1). Hosts are tried in
    // preference order; the per-host outcomes are merged, NOT overwritten last-host-wins:
    //   - a 5yz from a REACHABLE MX is authoritative-permanent and stops the walk - the
    //     recipient's own infrastructure has spoken (fixes hammering a 550 for 5 days because a
    //     lower-preference backup connect-timed-out and downgraded the class to transient);
    //   - BUT a higher-preference host that failed only transiently (down / connect error) is
    //     not overridden by a later, lower-preference 5yz - that higher server may recover and
    //     accept, so the aggregate stays transient (fixes the immediate bounce of mail the
    //     primary would take, just because a stale backup said 550);
    //   - a post-EOD indeterminate outcome (terminator sent, no reply) stops the walk and defers
    //     WITHOUT trying the next MX - trying it would guarantee a duplicate to an org that may
    //     already hold the message (fix for the 5s post-DATA timeout duplication).
    let delivered = false;
    let sawTransient = false; // connect failure / 4yz / dropped connection / unresolved (retry-worthy)
    let sawIndeterminate = false; // post-EOD timeout - unknown whether the peer accepted
    let sawAuthoritativePermanent = false; // a reachable MX answered 5yz
    let sawLocalPermanent = false; // our own refusal to dial this host (SSRF), not a recipient verdict
    let lastError = '';
    for (const host of candidateHosts) {
      // SSRF guard: never open a relay connection to a loopback/private MX target that a
      // hostile recipient-domain DNS could have pointed us at — as a literal IP/localhost
      // (isUnsafeMxTarget) OR as a hostname that resolves to a private address (vetMxHost).
      // vetMxHost resolves ONCE and returns a vetted IP to PIN, so we connect straight to
      // it rather than reconnecting by name (which would re-resolve and re-open a rebinding
      // window). The cert is still validated against the MX hostname via `servername`.
      let connectHost = host;
      let servername: string | undefined;
      if (guardTargets) {
        if (isUnsafeMxTarget(host)) {
          lastError = `refusing to relay to non-public MX target ${host}`;
          sawLocalPermanent = true;
          continue;
        }
        const vet = await vetMxHost(host);
        if (!('ip' in vet)) {
          // 'private' → SSRF (a local permanent refusal, not a recipient verdict); 'unresolved'
          // → transient, retry. Either way net.connect never gets a name to re-resolve.
          if (vet.permanent) {
            lastError = `refusing to relay to non-public MX target ${host}`;
            sawLocalPermanent = true;
          } else {
            lastError = `MX ${host} did not resolve`;
            sawTransient = true;
          }
          continue;
        }
        connectHost = vet.ip;
        if (vet.ip !== host) servername = host; // pinned an IP → validate the cert against the name
      }
      try {
        // family: 4 — Gmail 550s IPv6 connections without a matching v6 PTR;
        // our PTR is set for the v4 address, so relay over IPv4 only.
        const target = { host: connectHost, port, tls: 'none' as const, family: 4 as const, ...(servername !== undefined ? { servername } : {}) };
        const envelope = { from: msg.from, recipients: [recipient], data: msg.data, clientName: opts.clientName };
        const commonOpts = {
          ...(opts.tlsOptions !== undefined ? { tlsOptions: opts.tlsOptions } : {}),
          ...(opts.postDataReplyTimeoutMs !== undefined ? { postDataReplyTimeoutMs: opts.postDataReplyTimeoutMs } : {}),
        };
        let r = await deliver(target, envelope, {}, undefined, { startTls: true, requireValidCert: enforce, ...commonOpts });
        // Opportunistic STARTTLS (RFC 3207): if the handshake itself failed, the MX
        // advertised TLS it cannot complete — retry the same host in plaintext rather than
        // bounce. NOT under MTA-STS enforce: there a TLS/cert failure is terminal (its
        // distinct failure string never matches here), so we never downgrade.
        if (!r.ok && !enforce && r.failure === 'STARTTLS handshake failed') {
          r = await deliver(target, envelope, {}, undefined, { startTls: false, ...commonOpts });
        }
        if (r.ok) {
          results.push({ recipient, ok: true, classification: 'success', detail: `delivered via ${host}` });
          delivered = true;
          break;
        }
        lastError = r.failure ?? `refused (data ${r.dataCode ?? '?'})`;
        if (r.dataIndeterminate) {
          // We put the whole message + terminating dot on the wire and heard nothing back. Do
          // NOT walk to the next MX (that org may already hold this copy). Defer for the queue
          // to re-attempt later; the client's 10-minute post-EOD window makes a true timeout rare.
          sawIndeterminate = true;
          break;
        }
        // The code that refused us, in transaction order. A reachable 5yz is authoritative.
        const code = r.dataCode ?? r.rcptCodes.find((c) => c >= 400) ?? r.mailCode ?? r.greetingCode;
        if (code !== null && code >= 500 && code < 600) {
          sawAuthoritativePermanent = true;
          break; // the recipient's infrastructure gave a definitive answer; stop probing backups
        }
        sawTransient = true; // 4yz / dropped connection → retry (and keep trying lower-preference MX)
      } catch (e) {
        lastError = String(e);
        sawTransient = true; // connect refused / reset / TLS error before a reply → transient
      }
    }
    if (!delivered) {
      // Merge (see the block comment above). A higher-preference transient failure keeps the
      // whole recipient transient even if a lower-preference MX later said 5yz.
      let classification: 'transient' | 'permanent';
      if (sawTransient || sawIndeterminate) classification = 'transient';
      else if (sawAuthoritativePermanent) classification = 'permanent';
      else if (sawLocalPermanent) classification = 'permanent';
      else classification = 'transient';
      results.push({ recipient, ok: false, classification, detail: `all hosts failed: ${lastError || 'unknown'}` });
    }
  }

  return results;
}
