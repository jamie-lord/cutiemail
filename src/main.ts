/**
 * The mail server daemon — the entry point that assembles the pieces into a running
 * server.
 *
 * `node src/main.ts` opens the SQLite database, seeds accounts, and starts three
 * listeners wired to the store:
 *   - inbound SMTP (port 25 in production) — accepts mail from other servers;
 *   - submission SMTP (587) — requires SASL PLAIN AUTH over TLS before accepting mail;
 *   - IMAPS (993) — serves the mailbox over TLS, LOGIN verified against the accounts.
 *
 * Configuration is by environment variable, with dev-friendly defaults (non-privileged
 * ports, a bundled self-signed dev certificate) so it runs out of the box; production
 * overrides the ports and supplies a real certificate. `startServer` is exported and
 * used by the integration test to drive the fully-assembled server on ephemeral ports.
 *
 * `node src/main.ts <command>` runs the operator CLI instead (src/ops/cli.ts):
 * `setup` generates the DKIM key and prints the DNS records to publish.
 */

import { randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { SqliteCatalog } from './store/sqlite-mailbox.ts';
import { openMailDb, secureMailDbFile } from './store/open-mail-db.ts';
import { AccountRegistry } from './store/account-registry.ts';
import { MailStores } from './store/mail-stores.ts';
import { MemoryCatalog } from './store/memory-catalog.ts';
import { SmtpReceiver, MessageRejected } from './server/smtp-receiver.ts';
import type { DeliveredMessage } from './server/smtp-receiver.ts';
import { fromAuthor } from './message/from-author.ts';
import { ImapServer } from './server/imap-server.ts';
import type { ServableMailbox } from './server/imap-server.ts';
import { relayOutbound, routeRecipients, type OutboundOptions } from './server/outbound.ts';
import { StsCache, httpsFetchPolicy } from './server/mta-sts-resolve.ts';
import { ensureSubmissionHeaders, formatDate } from './server/submission-fixup.ts';
import { buildBounceMessage } from './server/bounce.ts';
import { verifyDkim, type DkimKeyResolver } from './server/dkim-inbound.ts';
import { checkSpf, type SpfResolvers } from './auth/spf-check.ts';
import { checkDmarc } from './server/dmarc-inbound.ts';
import { verifyArc } from './server/arc-inbound.ts';
import { AuthThrottle } from './server/auth-throttle.ts';
import { resolveTxt, resolve4, resolve6, resolveMx } from 'node:dns/promises';
import { dkimSign, makeSigner } from './server/dkim-signer.ts';
import { prependReceived, protocolFor, stripOwnAuthResults } from './server/received.ts';
import { MailboxNotifier } from './server/mailbox-notifier.ts';
import { SqliteQueue } from './store/sqlite-queue.ts';
import { RelayLoop } from './server/relay-loop.ts';
import { runOps } from './ops/cli.ts';
import { validLogin, MIN_PASSWORD_LENGTH } from './ops/account.ts';
import { sanitizeForTerminalLine } from './ops/terminal.ts';
// Bundled self-signed certificate — local development default only.
import { TEST_CERT as DEV_CERT, TEST_KEY as DEV_KEY } from './testing/tls-test-cert.ts';

export interface MailServerConfig {
  readonly dbPath: string;
  readonly host: string;
  readonly smtpPort: number;
  readonly submissionPort: number;
  readonly imapPort: number;
  readonly domain: string;
  /**
   * The local accounts. `mailDbPath` overrides where that user's mail database lives
   * (default `mail-<user>.db`, or `:memory:` when the control DB is in-memory).
   */
  readonly accounts: ReadonlyArray<{ readonly user: string; readonly pass: string; readonly mailDbPath?: string }>;
  readonly tls: { readonly key: string; readonly cert: string };
  /**
   * Override outbound relay's DNS/port — used by tests to point delivery at a
   * capture server. Production leaves it unset (real DNS, port 25).
   */
  readonly outbound?: {
    readonly resolveHosts?: (domain: string) => Promise<readonly string[]>;
    readonly port?: number;
  };
  /** DKIM signing for outbound mail. Unset = no signing (SPF-only deliverability). */
  readonly dkim?: {
    readonly selector: string;
    readonly privateKeyPem: string;
  };
  /** Where to report runtime events (relay outcomes). Unset = silent. */
  readonly onEvent?: (line: string) => void;
  /** How often the relay loop drains the queue (default 60s). */
  readonly relayIntervalMs?: number;
  /** Max queued outbound messages before submission returns a transient 451 (default 10000). */
  readonly maxQueueDepth?: number;
  /**
   * Outbound relay mode (ADR 0019). 'deliver' (default): queue remote mail and relay it
   * to its MX. 'hold': queue remote mail but NEVER relay — the dev/test sink mode, so a
   * staging run fed real-looking fixtures cannot actually email anyone; held messages
   * are inspectable with `queue list` and are relayed on the next boot without hold.
   */
  readonly outboundMode?: 'deliver' | 'hold';
  /** Max accepted message size in octets (RFC 1870 SIZE). Undefined = no limit. */
  readonly maxMessageSize?: number;
  /** Reject a message with at least this many Received hops as a loop (default 100). */
  readonly maxReceivedHops?: number;
  /** Resolve DKIM public keys for inbound verification (injected in tests). Default: DNS. */
  readonly dkimKeyResolver?: DkimKeyResolver;
  /** DNS resolvers for inbound SPF evaluation (injected in tests). Default: real DNS. */
  readonly spfResolvers?: SpfResolvers;
  /**
   * Sampler for the DMARC `pct` decision, returning a value in [0,100): a policy failure is
   * quarantined when the sample is below the record's pct. Default is `Math.random()*100`;
   * tests inject a fixed value to make quarantine deterministic.
   */
  readonly dmarcPctSampler?: () => number;
  /**
   * Domains whose ARC seals we trust (RFC 8617 §5.2: acting on ARC is LOCAL POLICY). When a
   * message would be junked for a DMARC failure but carries a valid ARC chain (cv=pass) whose
   * OUTERMOST sealer — the intermediary that forwarded it to us — is listed here, it is
   * delivered to the INBOX instead. Default empty: ARC is recorded in Authentication-Results
   * but never overrides DMARC, so behaviour is unchanged until an operator names a forwarder
   * (e.g. a mailing list) they trust. Trusting the outermost sealer only is the correct
   * boundary — an attacker cannot forge a seal under a trusted domain's key, and their own
   * outer seal would not be trusted. Compared case-insensitively.
   */
  readonly trustedArcSealers?: readonly string[];
  /**
   * The brute-force auth throttle shared by the submission + IMAP auth paths. Default is a
   * fresh AuthThrottle with production limits (10 failures / 15 min per IP); tests inject one
   * with a low threshold, and an operator could tune the limits here.
   */
  readonly authThrottle?: AuthThrottle;
}

/** Real-DNS resolvers for SPF: a missing record is [] (→ none), a real error throws (→ temperror). */
const dnsSpfResolvers: SpfResolvers = {
  txt: async (name) => {
    try {
      return (await resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
      throw e;
    }
  },
  a: async (name) => {
    const out: string[] = [];
    await Promise.all([resolve4(name).then((r) => out.push(...r)).catch(() => {}), resolve6(name).then((r) => out.push(...r)).catch(() => {})]);
    return out;
  },
  mx: async (name) => {
    try {
      return (await resolveMx(name)).map((r) => r.exchange);
    } catch {
      return [];
    }
  },
};

/**
 * Fetch a DKIM public-key record from DNS at "<selector>._domainkey.<domain>".
 * A missing record is null (permerror at the caller); a DNS failure throws (temperror).
 */
const resolveDkimKeyViaDns: DkimKeyResolver = async (domain, selector) => {
  let records: string[][];
  try {
    records = await resolveTxt(`${selector}._domainkey.${domain}`);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return null; // no key published
    throw e; // SERVFAIL / timeout — retriable
  }
  // A TXT record may be split into multiple strings; concatenate each record's chunks.
  const joined = records.map((chunks) => chunks.join('')).find((r) => r.includes('p='));
  return joined === undefined ? null : Buffer.from(joined, 'latin1');
};

/**
 * Seed configured accounts into the registry — CREATE-ONLY (ADR 0012). Once an
 * account exists, the registry is its source of truth: a changed env password is
 * IGNORED (with a warning) rather than applied, so `account set-password` cannot
 * be silently reverted by a stale unit file at the next boot. Exported for its
 * unit test.
 */
export function seedAccounts(
  registry: AccountRegistry,
  accounts: ReadonlyArray<{ readonly user: string; readonly pass: string; readonly mailDbPath: string }>,
  log: (line: string) => void,
): void {
  let redundant = 0;
  for (const a of accounts) {
    const existing = registry.lookup(a.user);
    if (existing === undefined) {
      registry.upsert(a.user, a.pass, a.mailDbPath);
      // Advisory only (never a hard boot failure): the CLI/init paths reject a sub-floor
      // password, but an env seed shouldn't stop the daemon from starting — warn instead.
      if (a.pass.length < MIN_PASSWORD_LENGTH) {
        log(`account ${a.user}: seeded password is under ${MIN_PASSWORD_LENGTH} characters — set a stronger one with \`node src/main.ts account set-password ${a.user}\`.`);
      }
    } else {
      // The account already exists → the registry is authoritative and this env seed does
      // nothing but keep a plaintext password in the unit file / environment.
      redundant++;
      if (existing.enabled && !registry.verifyPassword(a.user, a.pass)) {
        log(`account ${a.user}: already provisioned — the differing env password is IGNORED (change it with \`node src/main.ts account set-password ${a.user}\`)`);
      }
    }
  }
  if (redundant > 0) {
    // Not a per-account warning — one advisory. The seeds bootstrapped once; now they are
    // only a liability (a plaintext password in the unit and /proc/<pid>/environ).
    log(`${redundant} env-seeded account(s) already exist — MAIL_PASS/MAIL_ACCOUNTS are now redundant plaintext; remove them from the unit and manage with \`node src/main.ts account\`.`);
  }
}

export interface RunningServer {
  readonly inbound: SmtpReceiver;
  readonly submission: SmtpReceiver;
  readonly imap: ImapServer;
  /** The first account's INBOX — the single-account integration harness reads it. */
  readonly mailbox: ServableMailbox;
  /** Enabled account logins from the registry (source of truth) — for the startup banner. */
  readonly logins: readonly string[];
  readonly stores: MailStores;
  readonly queue: SqliteQueue;
  readonly relayLoop: RelayLoop;
  close(): Promise<void>;
}

/** Assemble and start the server from a full config. Returns the running handles. */
export async function startServer(cfg: MailServerConfig): Promise<RunningServer> {
  // The control-plane database (ADR 0009): the account registry + the global outbound
  // queue. Each USER's mail lives in its own database (one file per user), opened on
  // demand by the store manager below. openMailDb sets WAL (cleaner crash recovery, a
  // reader never blocks the writer) + busy_timeout (a contending writer waits instead
  // of raising SQLITE_BUSY). (WAL is a no-op for an in-memory db, used by tests.)
  const controlDb = openMailDb(cfg.dbPath);
  const inMemory = cfg.dbPath === ':memory:';
  const log = cfg.onEvent ?? ((): void => {});

  // The persistent account registry — the source of truth for accounts (ADR 0012).
  // Config/env accounts are seeded CREATE-ONLY below; the registry also holds each
  // user's mail-database path (default `mail-<user>.db` beside the control DB, or
  // `:memory:` when the control DB is in-memory, or an explicit per-account override).
  const registry = AccountRegistry.open(controlDb);
  // A user's mail DB defaults to `mail-<user>.db` in the SAME directory as the control
  // DB (so a production deploy keeps all databases together), or `:memory:` in-memory.
  const mailDbPathFor = (user: string, explicit?: string): string => explicit ?? (inMemory ? ':memory:' : join(dirname(cfg.dbPath), `mail-${user}.db`));
  seedAccounts(registry, cfg.accounts.map((a) => ({ user: a.user, pass: a.pass, mailDbPath: mailDbPathFor(a.user, a.mailDbPath) })), log);
  // Enforce owner-only (0600) permissions on EVERY registered account's mail DB at boot —
  // including a disabled/dormant account whose DB the lazy store manager never opens (so
  // openMailDb's on-open heal never fires for it). Without this, a disabled account's DB
  // that predates the 0600 hardening lingers world-readable (a disabled account's
  // mail-<user>.db left at 0644). Best-effort; :memory: and missing files skipped.
  for (const acct of registry.list()) secureMailDbFile(acct.mailDbPath);
  // Dev out-of-box default: with NOTHING configured and NOTHING in the registry, seed a
  // demo/demo account so `npm start` just works. A real deployment provisions with
  // `init`/`account` (or MAIL_USER), so its registry is non-empty and this never fires —
  // which is what lets a production unit carry no credentials at all.
  if (registry.list().length === 0) {
    const demoPath = inMemory ? ':memory:' : join(dirname(cfg.dbPath), 'mail.db');
    registry.upsert('demo', 'demo', demoPath);
    secureMailDbFile(demoPath);
    log('no accounts configured — seeded a dev account demo/demo. Provision real ones with `node src/main.ts init` / `account`.');
  }
  const verify = (user: string, pass: string): boolean => registry.verifyPassword(user, pass);

  // The per-user store manager: opens each user's mail DB once, provisioning INBOX + the
  // RFC 6154 special-use folders, and caches the live {catalog, notifier} so all of that
  // user's connections AND deliveries share it (required for IDLE + multi-connection sync).
  const stores = new MailStores((login) => {
    const row = registry.lookup(login);
    if (row === undefined || !row.enabled) return undefined;
    const udb = openMailDb(row.mailDbPath);
    const userCatalog = SqliteCatalog.open(udb, 1);
    for (const name of ['Sent', 'Drafts', 'Trash', 'Junk', 'Archive']) userCatalog.create(name);
    return { catalog: userCatalog, notifier: new MailboxNotifier(), close: () => udb.close() };
  });

  // Which local account (if any) a recipient address belongs to. Only our own domain; the
  // local-part is resolved (case-insensitively, RFC 5321 §2.4) to the owning ENABLED login
  // through the registry's single chokepoint — an exact login, an alias, or a `base+tag`
  // subaddress (ADR 0014). undefined → the caller rejects it at RCPT (550): no catch-all
  // (ADR 0009), which is what stops us being backscatter for mail we cannot deliver, and a
  // disabled owner is rejected rather than accepted-then-silently-dropped.
  const loginForLocalAddress = (address: string): string | undefined => {
    const at = address.lastIndexOf('@');
    if (at === -1 || address.slice(at + 1).toLowerCase() !== cfg.domain.toLowerCase()) return undefined;
    return registry.resolveLocalPart(address.slice(0, at));
  };
  // Append a message to a local user's mailbox (INBOX unless a DMARC failure quarantines it
  // to Junk) and wake the connections idling on that mailbox.
  const deliverTo = (login: string, data: Buffer, internalDate: number = Date.now(), mailbox: string = 'INBOX'): void => {
    const store = stores.get(login);
    if (store === undefined) return; // unknown/disabled — acceptRecipient already gated this
    const box = store.catalog.get(mailbox) ?? store.catalog.get('INBOX')!;
    box.append(data, [], internalDate);
    store.notifier.notify(store.catalog.get(mailbox) !== undefined ? mailbox : 'INBOX');
  };
  // DMARC pct sampler (deterministic in tests; random in production).
  const dmarcSample = cfg.dmarcPctSampler ?? ((): number => Math.random() * 100);

  // Inbound (port 25): mail arriving for us — verify DKIM, stamp Authentication-Results
  // and a Received trace line (RFC 5321 §4.4 / RFC 8601), and store it.
  const dkimResolver: DkimKeyResolver = cfg.dkimKeyResolver ?? resolveDkimKeyViaDns;
  const spfResolvers: SpfResolvers = cfg.spfResolvers ?? dnsSpfResolvers;
  // Forwarders whose ARC seals we trust, lower-cased for case-insensitive comparison.
  const trustedArcSealers = new Set((cfg.trustedArcSealers ?? []).map((d) => d.toLowerCase()));
  // One brute-force throttle shared by the submission and IMAP auth paths, so an attacker
  // cannot double their guess budget by alternating protocols. Keyed on source IP.
  const authThrottle = cfg.authThrottle ?? new AuthThrottle();
  const inbound = await SmtpReceiver.start(async (m) => {
    const receivedAt = new Date();
    // Verify DKIM and SPF (informational — never a rejection; §6.1 leniency preserved).
    // Both go into the Authentication-Results header for the client / downstream.
    let dkim: { verdict: string; domain: string | null; passedDomains: readonly string[] } = { verdict: 'none', domain: null, passedDomains: [] };
    try {
      dkim = await verifyDkim(m.data, dkimResolver);
    } catch {
      dkim = { verdict: 'temperror', domain: null, passedDomains: [] };
    }
    // The SPF identity: the MAIL FROM domain, or the HELO name for a null return-path.
    // Both are attacker-controlled and get spliced into Authentication-Results, which
    // clients parse to make trust decisions — a value carrying the AR delimiters (";",
    // "=", space) would forge a method result under our own authserv-id (RFC 8601 §5).
    // Only a hostname-shaped token is a usable identity; anything else yields none.
    const rawSpfDomain = m.from.includes('@') ? (m.from.split('@').pop() ?? '') : m.helo;
    const spfDomain = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(rawSpfDomain) ? rawSpfDomain : '';
    let spf = 'none';
    try {
      spf = m.remoteAddress === '' ? 'none' : await checkSpf(m.remoteAddress, spfDomain, spfResolvers);
    } catch {
      spf = 'temperror';
    }
    // DMARC ties it together: an aligned DKIM or SPF pass, keyed to the From domain.
    let dmarc: { verdict: string; policy: string | null; fromDomain: string | null; pct: number } = { verdict: 'none', policy: null, fromDomain: null, pct: 100 };
    try {
      dmarc = await checkDmarc({
        rawMessage: m.data,
        dkimPassedDomains: dkim.passedDomains,
        spfResult: spf,
        spfDomain,
        resolveTxt: spfResolvers.txt,
      });
    } catch {
      dmarc = { verdict: 'temperror', policy: null, fromDomain: null, pct: 100 };
    }
    // ARC (RFC 8617 §5.2): validate any Authenticated Received Chain. A cv=pass means the
    // chain is intact and every seal + the newest message signature verify — but that only
    // says a chain exists, not that we should trust it; the trust decision is applied below
    // against `trustedArcSealers`. Reuses the DKIM key resolver (ARC keys are DKIM-format).
    let arc: Awaited<ReturnType<typeof verifyArc>> = { cv: 'none', instances: 0, sealDomains: [], outermostSealer: null, anomalies: [] };
    try {
      arc = await verifyArc(m.data, dkimResolver);
    } catch {
      arc = { cv: 'fail', instances: 0, sealDomains: [], outermostSealer: null, anomalies: ['arc-exception'] };
    }
    // Only a hostname-shaped d= is echoed into the header (defense in depth — the DKIM
    // parser already constrains it, but the AR header must never carry AR delimiters).
    const dkimDomain = dkim.domain !== null && /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(dkim.domain) ? dkim.domain : null;
    const authResults =
      `Authentication-Results: ${cfg.domain}; dkim=${dkim.verdict}${dkimDomain !== null ? ` header.d=${dkimDomain}` : ''}` +
      `; spf=${spf}${spfDomain !== '' ? ` smtp.mailfrom=${spfDomain}` : ''}` +
      `; dmarc=${dmarc.verdict}${dmarc.policy !== null ? ` (p=${dmarc.policy})` : ''}` +
      // arc's cv is a fixed enum (none/pass/fail) — safe to splice; the sealer domain is
      // NOT echoed (it is attacker-controlled and would need AR-delimiter sanitisation).
      `; arc=${arc.cv}`;
    // Strip any forged Authentication-Results claiming our authserv-id before adding
    // our own (RFC 8601 §5) — otherwise a client cannot tell ours from the attacker's.
    const cleaned = stripOwnAuthResults(m.data, cfg.domain);
    // One id correlates the log line below with the Received trace line in the message.
    const msgId = randomUUID();
    const traced = prependReceived(cleaned, {
      helo: m.helo,
      remoteAddress: m.remoteAddress,
      by: cfg.domain,
      protocol: protocolFor(m.overTls, false),
      id: msgId,
      ...(m.recipients.length === 1 ? { forRecipient: m.recipients[0]! } : {}),
      date: receivedAt,
    });
    const stamped = Buffer.concat([Buffer.from(`${authResults}\r\n`, 'latin1'), traced]);
    // DMARC enforcement (ADR 0010): a message that FAILS DMARC where the owner published
    // p=quarantine or p=reject is filed to Junk rather than the INBOX — never hard-rejected
    // (we don't do ARC, so rejecting would lose legitimately-forwarded mail; Junk is
    // recoverable). p=none stays informational. `pct` gates the share of failures acted on.
    const enforce = dmarc.verdict === 'fail' && (dmarc.policy === 'quarantine' || dmarc.policy === 'reject') && dmarcSample() < dmarc.pct;
    // ARC override (RFC 8617): a DMARC failure that would be junked is instead delivered to the
    // INBOX when a valid ARC chain (cv=pass) was sealed by a forwarder we trust — the case ARC
    // exists for (a mailing list rewrites the message, breaking the author's DKIM/SPF, but seals
    // that it authenticated cleanly on entry). We trust only the OUTERMOST sealer: the hop that
    // handed the message to us. An empty trust set means this never fires.
    const arcRescue = enforce && arc.cv === 'pass' && arc.outermostSealer !== null && trustedArcSealers.has(arc.outermostSealer.toLowerCase());
    const targetMailbox = enforce && !arcRescue ? 'Junk' : 'INBOX';
    if (arcRescue) log(`DMARC ${dmarc.policy} failure (from ${dmarc.fromDomain ?? '?'}) rescued to INBOX by trusted ARC seal ${arc.outermostSealer}`);
    else if (enforce) log(`DMARC ${dmarc.policy} failure (from ${dmarc.fromDomain ?? '?'}) filed to Junk`);
    // Every recipient was validated at RCPT time; one that no longer resolves here
    // (account disabled / alias removed between RCPT and end-of-DATA) must NOT be
    // silently skipped — that is mail accepted with 250 and then dropped. Resolve all
    // recipients BEFORE delivering any copy and reject the whole message with a
    // transient 451 on a miss: the sender retries, and the refreshed RCPT gate then
    // rejects that recipient permanently (550 5.1.1). No partial delivery either way.
    const resolved: string[] = [];
    for (const rcpt of m.recipients) {
      const login = loginForLocalAddress(rcpt);
      if (login === undefined) throw new MessageRejected('451 4.2.1 a recipient mailbox became unavailable — try again later');
      resolved.push(login);
    }
    // INTERNALDATE = the moment we accepted the message (RFC 9051 §2.3.3), the same
    // instant stamped into the Received trace line above. Deliver a copy to each of our
    // local recipients' mailbox (ADR 0009).
    for (const login of resolved) deliverTo(login, stamped, receivedAt.getTime(), targetMailbox);
    // One line per accepted inbound message — the operator's answer to "did it arrive,
    // and where was it filed". Envelope values are remote-controlled: sanitised, one line.
    log(sanitizeForTerminalLine(`inbound ${msgId}: from=<${m.from}> to=${m.recipients.map((r) => `<${r}>`).join(',')} size=${m.data.length} dkim=${dkim.verdict} spf=${spf} dmarc=${dmarc.verdict} filed=${targetMailbox}`));
  }, {
    domain: cfg.domain,
    tls: cfg.tls,
    host: cfg.host,
    port: cfg.smtpPort,
    // Accept mail only for a KNOWN local account on our domain — an unknown recipient is
    // rejected (no catch-all, ADR 0009), which also stops us relaying / becoming
    // backscatter for mail we can't deliver. The local-part is matched case-insensitively
    // against the account login (see loginForLocalAddress).
    acceptRecipient: (address) => loginForLocalAddress(address) !== undefined,
    ...(cfg.maxMessageSize !== undefined ? { maxMessageSize: cfg.maxMessageSize } : {}),
    maxReceivedHops: cfg.maxReceivedHops ?? 100,
    log,
  });

  // Submission (port 587, authenticated): our user sending out. Local recipients
  // land in the mailbox; remote ones are relayed to their MX (best-effort, logged).
  // MTA-STS (RFC 8461): only in production (real DNS + HTTPS). When a test injects its own
  // resolveHosts (delivery pointed at a capture server), MTA-STS stays off so no real
  // network lookup happens during tests.
  const stsCache = new StsCache();
  const stsDeps = { resolveTxt: spfResolvers.txt, fetchPolicy: httpsFetchPolicy(), now: (): number => Date.now() };
  const outboundOpts: OutboundOptions = {
    clientName: cfg.domain,
    log,
    ...(cfg.outbound?.resolveHosts ? { resolveHosts: cfg.outbound.resolveHosts } : { resolveStsPolicy: (domain: string) => stsCache.resolve(domain, stsDeps) }),
    ...(cfg.outbound?.port !== undefined ? { port: cfg.outbound.port } : {}),
  };
  // DKIM signer, if a key is configured. Signing moves outbound from spam to inbox.
  const signer = cfg.dkim !== undefined ? makeSigner(cfg.domain, cfg.dkim.selector, cfg.dkim.privateKeyPem) : undefined;

  // The persistent outbound queue (in the control DB) + the loop that drains it.
  const queue = SqliteQueue.open(controlDb);
  // Cap on queued outbound messages before submission applies 451 backpressure — bounds the disk a
  // runaway sender can consume. Generous vs any personal-scale backlog (incl. a downstream MX being
  // down and messages legitimately retrying), tiny vs the drain rate × a sane outage window.
  const maxQueueDepth = cfg.maxQueueDepth ?? 10_000;
  // HOLD mode (ADR 0019): everything up to the queue behaves identically — submission
  // still authorizes, signs, and durably enqueues — but the relay loop never runs, so
  // no byte leaves for a remote MX. One switch, checked at the only two places a relay
  // tick is ever triggered, rather than threaded through the relay internals.
  const holdOutbound = cfg.outboundMode === 'hold';
  const relayLoop = new RelayLoop(queue, (m) => relayOutbound(m, outboundOpts), {
    log,
    // RFC 5321 §6.1: notify the sender when we permanently give up. Build the bounce
    // and deliver it — to the local mailbox if the sender is one of ours, otherwise
    // relay it with a null return-path (which can never itself bounce).
    onBounce: ({ from, data, failures }) => {
      const bounce = buildBounceMessage({
        reportingMta: cfg.domain,
        originalSender: from,
        originalData: data,
        failures: failures.map((f) => ({ recipient: f.recipient, action: 'failed', status: f.status, detail: f.detail })),
        date: formatDate(new Date()),
        token: randomUUID(),
      });
      const login = loginForLocalAddress(from);
      if (login !== undefined) {
        deliverTo(login, bounce); // the sender is one of ours — the bounce lands in their INBOX
      } else {
        queue.enqueue('', [from], bounce, Date.now()); // null return-path, relayed onward
      }
      log(`bounce generated for <${from}> (${failures.length} recipient(s))`);
    },
  });

  const submissionHandler = (m: DeliveredMessage): void => {
    // ADR 0015 — submission sender-authorization. An authenticated user may send only AS an
    // address they OWN (their login, an alias, or a `base+tag` subaddress, ADR 0014), on our
    // domain. Without this, any authenticated account can put ANY address in From — including
    // another account's — the cross-account spoof. Fail closed BEFORE routing/signing/relay,
    // with a PERMANENT 550 (a policy no, not a "try again").
    //
    // The authenticated login, canonicalised through the registry (case-/alias-insensitive);
    // undefined if the account was disabled or removed between AUTH and DATA — fail closed.
    const authed = m.authenticatedUser !== undefined ? registry.resolveLocalPart(m.authenticatedUser) : undefined;
    if (authed === undefined) throw new MessageRejected('550 5.7.1 not authorized to send');
    // The envelope MAIL FROM must be an address this user owns. A submitting client always
    // sets a real return-path; a null sender <> is a bounce, which never originates here.
    if ((m.from === '' ? undefined : loginForLocalAddress(m.from)) !== authed) {
      throw new MessageRejected(`550 5.7.1 sender <${m.from}> not authorized for this account`);
    }
    const { local, remote } = routeRecipients(m.recipients, cfg.domain);
    // Re-resolve every LOCAL recipient before touching any state. RCPT already gated
    // them (acceptRecipient below), so a miss here is the narrow race with a live
    // config change (account disabled / alias removed mid-transaction) — but before
    // that gate existed this was the submission black hole: a typo'd local recipient
    // got 250 and the message simply vanished (no 550, no DSN, no queue row), breaking
    // the "never silently dropped" invariant. Fail the WHOLE message with a transient
    // 451 before any delivery or queueing; on retry the RCPT gate answers 550 5.1.1.
    const localLogins: string[] = [];
    for (const rcpt of local) {
      const login = loginForLocalAddress(rcpt);
      if (login === undefined) throw new MessageRejected(`451 4.2.1 mailbox <${rcpt}> became unavailable — try again later`);
      localLogins.push(login);
    }
    // Backpressure: the outbound queue drains serially (~11/s on a small VM), so a runaway or
    // compromised authenticated account submitting faster than that would grow the queue — and,
    // since each row stores the whole signed body, the DISK — without bound.
    // Reject a message needing outbound queuing once the queue is at capacity, with a
    // TRANSIENT 451 (RFC 3463 4.3.1) so a well-behaved sender retries and no mail is lost.
    // Checked BEFORE local delivery so a rejected message isn't half-delivered then retried.
    if (remote.length > 0 && queue.size >= maxQueueDepth) {
      throw new MessageRejected('451 4.3.1 mail queue full; retry later');
    }
    // RFC 6409 fix-up (submission only, never on the inbound port): add Date /
    // Message-ID when the client omitted them — Gmail rejects messages without.
    const fixed = ensureSubmissionHeaders(m.data, cfg.domain, m.from);
    // The From: header author must ALSO be owned. Checked after the fix-up so a client that
    // omitted From gets the (owned) envelope synthesized in — still exactly one, still owned.
    // Spoof-hardened parse (last angle-addr; comments/quoted-strings stripped) and exactly one
    // From (RFC 5322 §3.6.1; a second From is the display-spoof DMARC also rejects).
    const { address: fromAddr, count: fromCount } = fromAuthor(fixed);
    if (fromCount !== 1 || fromAddr === null) {
      throw new MessageRejected('550 5.7.1 message must carry exactly one From address');
    }
    if (loginForLocalAddress(fromAddr) !== authed) {
      throw new MessageRejected(`550 5.7.1 From <${fromAddr}> not authorized for this account`);
    }
    // Stamp our Received trace line (§4.4), then sign — DKIM does not cover
    // Received, so the order is fix-up → Received → DKIM-Signature on top.
    const msgId = randomUUID();
    const traced = prependReceived(fixed, {
      helo: m.helo,
      remoteAddress: m.remoteAddress,
      by: cfg.domain,
      protocol: protocolFor(m.overTls, m.authenticated),
      id: msgId,
      ...(m.recipients.length === 1 ? { forRecipient: m.recipients[0]! } : {}),
      date: new Date(),
    });
    for (const login of localLogins) deliverTo(login, traced);
    let queuedAs: string | null = null;
    if (remote.length > 0) {
      // Sign the outbound copy once, queue it, and kick the loop so the first
      // attempt is immediate; failures are retried, not dropped.
      const outData = signer !== undefined ? dkimSign(traced, signer) : traced;
      queuedAs = queue.enqueue(m.from, remote, outData, Date.now());
      if (!holdOutbound) void relayLoop.tick(Date.now());
    }
    // One line per accepted submission, correlating the message id with the queue row
    // (the id `queue list` shows). MAIL FROM is authorized-owned but still sanitised.
    log(sanitizeForTerminalLine(`submission ${msgId}: user=${authed} from=<${m.from}> local=${localLogins.length} remote=${remote.length}${queuedAs !== null ? ` queued=${queuedAs}` : ''} size=${m.data.length}`));
  };
  const submission = await SmtpReceiver.start(submissionHandler, {
    domain: cfg.domain,
    tls: cfg.tls,
    requireAuth: true,
    authenticate: verify,
    throttle: authThrottle,
    host: cfg.host,
    port: cfg.submissionPort,
    // Validate LOCAL recipients at RCPT time on submission too. An authenticated user
    // may relay to any remote domain, but an address at OUR domain that doesn't resolve
    // to an enabled account/alias must be refused with 550 5.1.1 here — not accepted and
    // silently skipped at delivery (the submission black hole). The submitter is
    // authenticated, so naming "no such user" leaks nothing to an attacker.
    acceptRecipient: (address) => {
      const at = address.lastIndexOf('@');
      if (at === -1 || address.slice(at + 1).toLowerCase() !== cfg.domain.toLowerCase()) return true;
      return loginForLocalAddress(address) !== undefined;
    },
    log,
    ...(cfg.maxMessageSize !== undefined ? { maxMessageSize: cfg.maxMessageSize } : {}),
    maxReceivedHops: cfg.maxReceivedHops ?? 100,
  });
  // Multi-account IMAP (ADR 0009): the base catalog is a never-served placeholder —
  // every authenticated connection rebinds to its own user's store via resolveAccount,
  // or is rejected — so no session is ever served this empty catalog.
  const imap = await ImapServer.start(new MemoryCatalog(), {
    tls: cfg.tls,
    host: cfg.host,
    port: cfg.imapPort,
    authenticate: verify,
    throttle: authThrottle,
    resolveAccount: (login) => {
      const s = stores.get(login);
      return s === undefined ? undefined : { catalog: s.catalog, notifier: s.notifier };
    },
    log,
    // One size limit for the whole server: a message importable over SMTP must be
    // importable over IMAP APPEND too (imapsync migrations move large legacy mail).
    ...(cfg.maxMessageSize !== undefined ? { maxAppendLiteral: cfg.maxMessageSize } : {}),
  });

  // Drain the queue on a timer, and once now to recover anything left by a crash.
  // In HOLD mode the loop never starts: held mail (including anything left over from a
  // previous run) stays durably queued until a boot without hold relays it.
  if (!holdOutbound) {
    relayLoop.start(cfg.relayIntervalMs ?? 60_000);
    void relayLoop.tick(Date.now());
  }

  // Expose an INBOX for the single-account integration harness — ANY enabled account's,
  // scanning the configured accounts rather than fixing on accounts[0]. Otherwise disabling
  // the primary (MAIL_USER) account would brick the whole daemon on the next boot, taking
  // down every OTHER enabled account too. Only a genuinely
  // empty/all-disabled registry is fatal.
  // Scan the REGISTRY (the source of truth, ADR 0012), not the env seeds — a passwordless
  // deployment has an empty cfg.accounts but a populated registry, and this must still find
  // an INBOX to expose. Skips disabled accounts so disabling the primary can't brick the rest.
  const enabledLogins = registry.list().filter((a) => a.enabled).map((a) => a.login);
  const mailbox = enabledLogins.map((login) => stores.get(login)?.catalog.get('INBOX')).find((m) => m !== undefined);
  if (mailbox === undefined) {
    // Fail closed WITHOUT leaking the already-bound listeners + relay timer — an embedder
    // that catches this must not be left with orphaned handles keeping the loop alive. Await the
    // loop so no in-flight tick races the controlDb.close() below.
    await relayLoop.stop();
    await inbound.close();
    await submission.close();
    await imap.close();
    stores.closeAll();
    controlDb.close();
    throw new Error('a mail server needs at least one enabled account');
  }

  return {
    inbound,
    submission,
    imap,
    mailbox,
    logins: enabledLogins,
    stores,
    queue,
    relayLoop,
    async close() {
      // Await the relay loop (not just clear its timer) so an in-flight tick draining the queue
      // finishes before we close its database — otherwise the tick hits "database is not open".
      await relayLoop.stop();
      await inbound.close();
      await submission.close();
      await imap.close();
      stores.closeAll();
      controlDb.close();
    },
  };
}

/**
 * Parse a positive-integer env var, falling back to `fallback` for an unset, empty,
 * non-numeric, non-integer, or non-positive value. `Number('abc')` is NaN, and a NaN
 * limit silently disables every `value > limit` guard — so a malformed MAIL_MAX_SIZE or
 * port must fall back to a sane default, never poison a bound.
 */
function posIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Whether `host` is a loopback bind address (safe to serve the dev cert on). */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * Validate an env-provided account login before it becomes a `mail-<login>.db` filename.
 * The `account` CLI applies `validLogin`; env seeding must too, or a malformed entry like
 * `../x:pw` would build `mail-../x.db`. Operator-trusted config, so a bad value fails loud
 * at boot rather than silently building a surprising path.
 */
function requireValidLogin(login: string, source: string): string {
  if (!validLogin(login)) {
    throw new Error(`${source}: invalid account login ${JSON.stringify(login)} — letters/digits then letters/digits/._- (max 64); it becomes the mailbox database filename`);
  }
  return login;
}

/** Build a config from environment variables, with dev-friendly defaults. Exported for tests. */
export function configFromEnv(): MailServerConfig & { usingDevCert: boolean; devCertForcedPublic: boolean } {
  const certPath = process.env.MAIL_TLS_CERT;
  const keyPath = process.env.MAIL_TLS_KEY;
  const usingDevCert = certPath === undefined || keyPath === undefined;
  const host = process.env.MAIL_HOST ?? '127.0.0.1';
  // The refusal below can be bypassed with MAIL_ALLOW_DEV_CERT=1 for a throwaway test.
  // When that override is ACTUALLY EXERCISED on a public bind it must be loud (a distinct
  // WARNING in main(), reusing the refusal's language) — the same gentle dev-cert NOTE as
  // a loopback run would let the override normalise in a copy-pasted unit file.
  const devCertForcedPublic = usingDevCert && !isLoopbackHost(host) && process.env.MAIL_ALLOW_DEV_CERT === '1';
  // Fail closed: the bundled dev certificate's private key is
  // committed in the repo (src/testing/tls-test-cert.ts), so serving it on a non-loopback
  // interface lets a trivial MITM present the same cert and capture AUTH credentials on
  // 587/993. Refuse to boot rather than silently serve it publicly. MAIL_ALLOW_DEV_CERT=1
  // is an explicit, unsafe opt-in for a throwaway local test on a public interface.
  if (usingDevCert && !isLoopbackHost(host) && process.env.MAIL_ALLOW_DEV_CERT !== '1') {
    throw new Error(
      `refusing to bind ${host} with the bundled self-signed DEV certificate — its private key is public, so serving it on a public interface exposes account credentials. Set MAIL_TLS_CERT and MAIL_TLS_KEY to a real certificate. (For a deliberate throwaway test, set MAIL_ALLOW_DEV_CERT=1 — never in production.)`,
    );
  }
  // The bundled dev certificate is imported lazily only when no real cert is given.
  const dev = usingDevCert ? loadDevCert() : { cert: readFileSync(certPath!, 'utf8'), key: readFileSync(keyPath!, 'utf8') };
  // DKIM signing is enabled only when both a key file and a selector are given.
  const dkimKeyPath = process.env.MAIL_DKIM_KEY;
  const dkimSelector = process.env.MAIL_DKIM_SELECTOR;
  const dkim = dkimKeyPath !== undefined && dkimSelector !== undefined ? { selector: dkimSelector, privateKeyPem: readFileSync(dkimKeyPath, 'utf8') } : undefined;
  return {
    // The control DB (registry + queue). MAIL_DB now names the FIRST account's mail
    // database, so an existing single-account deploy migrates with no data loss: its
    // mail.db becomes that user's mail store, and the control DB is a new file alongside.
    dbPath: process.env.MAIL_CONTROL_DB ?? 'control.db',
    host,
    smtpPort: posIntEnv(process.env.MAIL_SMTP_PORT, 2525),
    submissionPort: posIntEnv(process.env.MAIL_SUBMISSION_PORT, 5587),
    imapPort: posIntEnv(process.env.MAIL_IMAP_PORT, 5993),
    domain: process.env.MAIL_DOMAIN ?? 'mail.example.com',
    // The primary account keeps its existing mail database (MAIL_DB) for a clean
    // migration; additional accounts come from MAIL_ACCOUNTS ("user:pass,user2:pass2")
    // and default their mail DB to mail-<user>.db beside the control DB.
    accounts: [
      // The env primary is a CREATE-ONLY bootstrap seed, included ONLY when MAIL_USER is
      // explicitly set. When it is unset the daemon runs entirely off the registry (accounts
      // created by `init`/`account`), so a production unit needs no credentials at all; a
      // genuinely empty registry gets a dev `demo/demo` fallback in startServer, not here.
      // The primary's mail DB: MAIL_DB when set; otherwise 'mail.db' — EXCEPT when the
      // control DB is :memory:, where no path is passed so mailDbPathFor's in-memory
      // default applies. The old unconditional `?? 'mail.db'` made the path always
      // explicit, which bypassed that default: a "fully ephemeral" MAIL_CONTROL_DB=
      // :memory: run with MAIL_USER set silently reopened whatever ./mail.db was lying
      // around — stale mail leaking into what the README promises is an in-memory run.
      ...(process.env.MAIL_USER !== undefined
        ? [{
            user: requireValidLogin(process.env.MAIL_USER, 'MAIL_USER'),
            pass: process.env.MAIL_PASS ?? 'demo',
            ...(process.env.MAIL_DB !== undefined
              ? { mailDbPath: process.env.MAIL_DB }
              : (process.env.MAIL_CONTROL_DB ?? 'control.db') === ':memory:'
                ? {}
                : { mailDbPath: 'mail.db' }),
          }]
        : []),
      ...(process.env.MAIL_ACCOUNTS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.includes(':'))
        .map((pair) => ({ user: requireValidLogin(pair.slice(0, pair.indexOf(':')), 'MAIL_ACCOUNTS'), pass: pair.slice(pair.indexOf(':') + 1) })),
    ],
    tls: dev,
    ...(dkim !== undefined ? { dkim } : {}),
    // 25 MiB default. Validated: a malformed value must NOT become NaN, or every
    // `len > NaN` size check is false and the DATA size cap silently disappears —
    // removing the last bound on a multi-signature-flood DoS (see MAX_DKIM_SIGNATURES).
    maxMessageSize: posIntEnv(process.env.MAIL_MAX_SIZE, 26_214_400),
    outboundMode: parseOutboundMode(process.env.MAIL_OUTBOUND),
    // Forwarders (e.g. a mailing list) whose valid ARC chain may rescue a DMARC failure to
    // the INBOX (ADR 0011). Comma-separated domains; empty = ARC is recorded but never
    // overrides DMARC (the safe default).
    trustedArcSealers: (process.env.MAIL_TRUSTED_ARC_SEALERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    usingDevCert,
    devCertForcedPublic,
  };
}

/**
 * MAIL_OUTBOUND: 'deliver' (default) or 'hold'. FAIL LOUD on anything else — an operator
 * who typed 'holdd' believing no mail can escape must not get a silently really-relaying
 * server; this is the one env var where a fallback default inverts a safety property.
 */
function parseOutboundMode(raw: string | undefined): 'deliver' | 'hold' {
  if (raw === undefined || raw === '' || raw === 'deliver') return 'deliver';
  if (raw === 'hold') return 'hold';
  throw new Error(`MAIL_OUTBOUND must be "deliver" or "hold", got ${JSON.stringify(raw)} — refusing to guess (a typo here could mean real mail leaves a test instance).`);
}

/** The bundled self-signed certificate, for local development only. */
function loadDevCert(): { key: string; cert: string } {
  return { key: DEV_KEY, cert: DEV_CERT };
}

/**
 * Turn a listener bind failure into an actionable line instead of a raw stack trace. EADDRINUSE
 * and EACCES on ports 25/587/993 are the two most common first-run failures (a system MTA or a
 * stale instance already on the port; a privileged port without root/setcap), so name the cause
 * and the fix rather than dumping a Node error object. Returns null for anything else.
 */
function describeBindError(err: unknown): string | null {
  const e = err as { code?: string; port?: number; syscall?: string };
  if (e.syscall !== 'listen') return null;
  const port = e.port !== undefined ? String(e.port) : 'a listener port';
  if (e.code === 'EADDRINUSE') {
    return `cannot start: port ${port} is already in use. Another mail server or a previous instance of this one is running — stop it, or set MAIL_SMTP_PORT / MAIL_SUBMISSION_PORT / MAIL_IMAP_PORT to free ports.`;
  }
  if (e.code === 'EACCES') {
    return `cannot start: not permitted to bind port ${port}. Ports below 1024 (25/587/993) need privilege — run as root, grant node the capability once with \`sudo setcap 'cap_net_bind_service=+ep' $(command -v node)\`, or set MAIL_SMTP_PORT / MAIL_SUBMISSION_PORT / MAIL_IMAP_PORT to high ports (≥1024).`;
  }
  return null;
}

/**
 * A boot-time warning for an expired or soon-expiring TLS certificate, or null when it is
 * fine. `doctor` has always checked this, but doctor only helps when it is run — a daemon
 * serving a cert every client rejects, while journalctl shows a healthy start, is exactly
 * the silent-drift scenario DEPLOYMENT.md warns about. Unparseable input returns null
 * (the TLS server itself will fail loudly on garbage). Exported for its unit test.
 */
export function describeCertExpiry(certPem: string, now: number = Date.now()): string | null {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return null;
  }
  const expires = Date.parse(cert.validTo);
  if (Number.isNaN(expires)) return null;
  const days = Math.floor((expires - now) / 86_400_000);
  if (days < 0) return `WARNING: the TLS certificate EXPIRED ${-days} day(s) ago (${cert.validTo}) — every client TLS handshake will fail until it is renewed.`;
  if (days <= 14) return `WARNING: the TLS certificate expires in ${days} day(s) (${cert.validTo}) — renew now; is the certbot deploy hook wired up (docs/DEPLOYMENT.md)?`;
  return null;
}

async function main(): Promise<void> {
  const cfg = configFromEnv();
  // Every daemon log line carries its own ISO timestamp: under systemd journald adds one
  // too (harmless), but a plain `npm start > daemon.log` would otherwise have no times at
  // all — and "when did that bounce happen" is the first forensic question.
  const log = (s: string): void => {
    process.stdout.write(`${new Date().toISOString()} ${s}\n`);
  };
  let server: RunningServer;
  try {
    server = await startServer({ ...cfg, onEvent: log });
  } catch (err) {
    const friendly = describeBindError(err);
    if (friendly !== null) {
      process.stderr.write(`${friendly}\n`);
      process.exit(1);
    }
    throw err;
  }
  // The RESOLVED path: databases are created relative to the working directory, and
  // "started from a different cwd, all my accounts vanished" was the single most-hit
  // trap in usability testing — the banner is where the operator finds out.
  const dbShown = cfg.dbPath === ':memory:' ? ':memory: (nothing is persisted)' : resolvePath(cfg.dbPath);
  log(`mail server "${cfg.domain}" started (control db: ${dbShown}; mail databases live beside it)`);
  log(`  inbound SMTP     ${cfg.host}:${server.inbound.port}`);
  log(`  submission (AUTH) ${cfg.host}:${server.submission.port}`);
  log(`  IMAPS            ${cfg.host}:${server.imap.port}`);
  log(`  accounts: ${server.logins.join(', ')}`);
  if (cfg.outboundMode === 'hold') {
    log('  outbound: HOLD (MAIL_OUTBOUND=hold) — remote mail is queued locally and NEVER relayed. Inspect with `node src/main.ts queue list`; restart without hold to release.');
  } else {
    log(`  outbound: remote mail is queued and relayed to its MX, with retry${cfg.dkim !== undefined ? ' and DKIM signing' : ''}.`);
  }
  if (cfg.devCertForcedPublic) {
    log(`  WARNING: MAIL_ALLOW_DEV_CERT=1 is serving the bundled DEV certificate on ${cfg.host} — its private key is PUBLIC (committed to the repo), so anyone can MITM these listeners and capture account credentials. Throwaway tests only; never production.`);
  } else if (cfg.usingDevCert) {
    log('  NOTE: using the bundled self-signed DEV certificate — set MAIL_TLS_CERT/MAIL_TLS_KEY in production.');
  }
  const certWarn = describeCertExpiry(cfg.tls.cert);
  if (certWarn !== null) log(`  ${certWarn}`);
  const shutdown = (): void => {
    log('shutting down...');
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // SIGHUP is the reflexive "reload" signal from a lifetime of other daemons; Node's
  // default would TERMINATE the process on it, silently. There is no live reload here
  // (a deliberate omission — restart instead; docs/BACKLOG.md records live cert reload
  // as a candidate), so say that, and stay up.
  process.on('SIGHUP', () => {
    log('SIGHUP ignored — no live reload; restart the daemon to pick up a renewed certificate or changed configuration (a restart drops connected IMAP sessions).');
  });
}

// Run as a daemon when invoked directly with no arguments; with arguments, run the
// operator CLI (setup, ... — see src/ops/cli.ts) against the same env configuration.
// One entry point on purpose: the daemon IS the toolbox, there is no second artifact.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Every file this process creates — the control DB and per-user mail DBs (with SCRAM
  // credential material + raw message bytes), their WAL sidecars, and backup artifacts —
  // is private to the mail user. A 0o077 umask makes new files 0600 and new dirs 0700 by
  // default, closing the local-disclosure gap. Applies to the daemon and every
  // operator subcommand (backup, account, setup) since they share this one entry point.
  process.umask(0o077);
  const opsArgs = process.argv.slice(2);
  if (opsArgs.length > 0) {
    const io = {
      out: (line: string): void => void process.stdout.write(`${line}\n`),
      err: (line: string): void => void process.stderr.write(`${line}\n`),
    };
    // process.exitCode (not exit()) so buffered stdout drains — same lesson as src/cli.ts.
    runOps(opsArgs, io, process.env).then((code) => {
      process.exitCode = code;
    }).catch((err: unknown) => {
      process.stderr.write(`${String(err)}\n`);
      process.exitCode = 1;
    });
  } else {
    main().catch((err: unknown) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(1);
    });
  }
}
