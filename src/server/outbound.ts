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

import { resolveMx, resolve4, resolve6 } from 'node:dns/promises';
import { deliver } from '../client/deliver.ts';
import { resolveMxHosts, type DnsResolver, type MxRecord } from '../client/mx.ts';

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
    if (hosts.length === 0) {
      // No MX/A right now — treat as transient (conservative: a temporary DNS
      // gap must not bounce mail; a truly dead domain bounces after give-up).
      results.push({ recipient, ok: false, classification: 'transient', detail: `no MX or address record for ${domain}` });
      continue;
    }

    let delivered = false;
    let lastError = '';
    let lastClass: 'transient' | 'permanent' = 'transient';
    for (const host of hosts) {
      try {
        // family: 4 — Gmail 550s IPv6 connections without a matching v6 PTR;
        // our PTR is set for the v4 address, so relay over IPv4 only.
        const r = await deliver(
          { host, port, tls: 'none', family: 4 },
          { from: msg.from, recipients: [recipient], data: msg.data, clientName: opts.clientName },
          {},
          undefined,
          { startTls: true },
        );
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
