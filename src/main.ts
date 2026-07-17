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
 */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SqliteMailbox, SqliteCatalog } from './store/sqlite-mailbox.ts';
import { AccountStore } from './store/accounts.ts';
import { SmtpReceiver } from './server/smtp-receiver.ts';
import type { DeliveredMessage } from './server/smtp-receiver.ts';
import { ImapServer } from './server/imap-server.ts';
import { relayOutbound, routeRecipients, type OutboundOptions } from './server/outbound.ts';
import { ensureSubmissionHeaders, formatDate } from './server/submission-fixup.ts';
import { buildBounceMessage } from './server/bounce.ts';
import { verifyDkim, type DkimKeyResolver } from './server/dkim-inbound.ts';
import { checkSpf, type SpfResolvers } from './auth/spf-check.ts';
import { checkDmarc } from './server/dmarc-inbound.ts';
import { resolveTxt, resolve4, resolve6, resolveMx } from 'node:dns/promises';
import { dkimSign, makeSigner } from './server/dkim-signer.ts';
import { prependReceived, protocolFor, stripOwnAuthResults } from './server/received.ts';
import { MailboxNotifier } from './server/mailbox-notifier.ts';
import { SqliteQueue } from './store/sqlite-queue.ts';
import { RelayLoop } from './server/relay-loop.ts';
// Bundled self-signed certificate — local development default only.
import { TEST_CERT as DEV_CERT, TEST_KEY as DEV_KEY } from './testing/tls-test-cert.ts';

export interface MailServerConfig {
  readonly dbPath: string;
  readonly host: string;
  readonly smtpPort: number;
  readonly submissionPort: number;
  readonly imapPort: number;
  readonly domain: string;
  readonly accounts: ReadonlyArray<{ readonly user: string; readonly pass: string }>;
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
  /** Max accepted message size in octets (RFC 1870 SIZE). Undefined = no limit. */
  readonly maxMessageSize?: number;
  /** Reject a message with at least this many Received hops as a loop (default 100). */
  readonly maxReceivedHops?: number;
  /** Resolve DKIM public keys for inbound verification (injected in tests). Default: DNS. */
  readonly dkimKeyResolver?: DkimKeyResolver;
  /** DNS resolvers for inbound SPF evaluation (injected in tests). Default: real DNS. */
  readonly spfResolvers?: SpfResolvers;
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

export interface RunningServer {
  readonly inbound: SmtpReceiver;
  readonly submission: SmtpReceiver;
  readonly imap: ImapServer;
  readonly mailbox: SqliteMailbox;
  readonly queue: SqliteQueue;
  readonly relayLoop: RelayLoop;
  close(): Promise<void>;
}

/** Assemble and start the server from a full config. Returns the running handles. */
export async function startServer(cfg: MailServerConfig): Promise<RunningServer> {
  const db = new DatabaseSync(cfg.dbPath);
  // WAL journaling: cleaner crash recovery and a reader never blocks the writer —
  // the right mode for a server. (A no-op for an in-memory db, used by tests.)
  try {
    db.exec('PRAGMA journal_mode=WAL');
  } catch {
    /* :memory: and some builds don't support WAL — harmless */
  }
  // The catalog of named mailboxes: INBOX plus whatever the client creates
  // (real Thunderbird's first act is CREATE "Trash"). Inbound mail lands in INBOX.
  const catalog = SqliteCatalog.open(db, 1);
  const mailbox = catalog.get('INBOX')!;
  // Pre-provision the conventional special-use folders (RFC 6154) so a client
  // discovers them via LIST/SPECIAL-USE and files Sent/Drafts/Trash there, instead
  // of inventing its own "Sent Items"/"Deleted Messages" duplicates. Names match the
  // SPECIAL_USE table in imap-server.ts, which tags them in LIST responses.
  for (const name of ['Sent', 'Drafts', 'Trash', 'Junk', 'Archive']) catalog.create(name);

  const accounts = new AccountStore();
  for (const a of cfg.accounts) accounts.setPassword(a.user, a.pass, randomBytes(16), 4096, 'sha256');
  const verify = (user: string, pass: string): boolean => accounts.verifyPassword(user, pass);

  const log = cfg.onEvent ?? ((): void => {});
  // Notify idling IMAP connections when INBOX gains a message (IDLE, RFC 2177).
  const notifier = new MailboxNotifier();
  const storeLocal = (data: Buffer, internalDate: number = Date.now()): void => {
    mailbox.append(data, [], internalDate);
    notifier.notify('INBOX');
  };

  // Inbound (port 25): mail arriving for us — verify DKIM, stamp Authentication-Results
  // and a Received trace line (RFC 5321 §4.4 / RFC 8601), and store it.
  const dkimResolver: DkimKeyResolver = cfg.dkimKeyResolver ?? resolveDkimKeyViaDns;
  const spfResolvers: SpfResolvers = cfg.spfResolvers ?? dnsSpfResolvers;
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
    const spfDomain = m.from.includes('@') ? (m.from.split('@').pop() ?? '') : m.helo;
    let spf = 'none';
    try {
      spf = m.remoteAddress === '' ? 'none' : await checkSpf(m.remoteAddress, spfDomain, spfResolvers);
    } catch {
      spf = 'temperror';
    }
    // DMARC ties it together: an aligned DKIM or SPF pass, keyed to the From domain.
    let dmarc: { verdict: string; policy: string | null } = { verdict: 'none', policy: null };
    try {
      dmarc = await checkDmarc({
        rawMessage: m.data,
        dkimPassedDomains: dkim.passedDomains,
        spfResult: spf,
        spfDomain,
        resolveTxt: spfResolvers.txt,
      });
    } catch {
      dmarc = { verdict: 'temperror', policy: null };
    }
    const authResults =
      `Authentication-Results: ${cfg.domain}; dkim=${dkim.verdict}${dkim.domain !== null ? ` header.d=${dkim.domain}` : ''}` +
      `; spf=${spf}${spfDomain !== '' ? ` smtp.mailfrom=${spfDomain}` : ''}` +
      `; dmarc=${dmarc.verdict}${dmarc.policy !== null ? ` (p=${dmarc.policy})` : ''}`;
    // Strip any forged Authentication-Results claiming our authserv-id before adding
    // our own (RFC 8601 §5) — otherwise a client cannot tell ours from the attacker's.
    const cleaned = stripOwnAuthResults(m.data, cfg.domain);
    const traced = prependReceived(cleaned, {
      helo: m.helo,
      remoteAddress: m.remoteAddress,
      by: cfg.domain,
      protocol: protocolFor(m.overTls, false),
      id: randomUUID(),
      ...(m.recipients.length === 1 ? { forRecipient: m.recipients[0]! } : {}),
      date: receivedAt,
    });
    const stamped = Buffer.concat([Buffer.from(`${authResults}\r\n`, 'latin1'), traced]);
    // INTERNALDATE = the moment we accepted the message (RFC 9051 §2.3.3), the same
    // instant stamped into the Received trace line above.
    storeLocal(stamped, receivedAt.getTime());
  }, {
    domain: cfg.domain,
    tls: cfg.tls,
    host: cfg.host,
    port: cfg.smtpPort,
    // Accept inbound mail only for our own domain (catch-all to the single mailbox).
    // Rejecting other domains at RCPT is what stops us relaying / becoming backscatter
    // for mail we can't deliver. The local-part is NOT case-folded or restricted —
    // §2.4 makes it case-sensitive and the domain's own business; every local address
    // maps to the one mailbox here.
    acceptRecipient: (address) => {
      const at = address.lastIndexOf('@');
      return at !== -1 && address.slice(at + 1).toLowerCase() === cfg.domain.toLowerCase();
    },
    ...(cfg.maxMessageSize !== undefined ? { maxMessageSize: cfg.maxMessageSize } : {}),
    maxReceivedHops: cfg.maxReceivedHops ?? 100,
  });

  // Submission (port 587, authenticated): our user sending out. Local recipients
  // land in the mailbox; remote ones are relayed to their MX (best-effort, logged).
  const outboundOpts: OutboundOptions = {
    clientName: cfg.domain,
    log,
    ...(cfg.outbound?.resolveHosts ? { resolveHosts: cfg.outbound.resolveHosts } : {}),
    ...(cfg.outbound?.port !== undefined ? { port: cfg.outbound.port } : {}),
  };
  // DKIM signer, if a key is configured. Signing moves outbound from spam to inbox.
  const signer = cfg.dkim !== undefined ? makeSigner(cfg.domain, cfg.dkim.selector, cfg.dkim.privateKeyPem) : undefined;

  // The persistent outbound queue + the loop that drains it (survives restart).
  const queue = SqliteQueue.open(db);
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
      const at = from.lastIndexOf('@');
      const senderDomain = at === -1 ? '' : from.slice(at + 1).toLowerCase();
      if (senderDomain === cfg.domain.toLowerCase()) {
        storeLocal(bounce); // the sender is local — the bounce lands in their INBOX
      } else {
        queue.enqueue('', [from], bounce, Date.now()); // null return-path, relayed onward
      }
      log(`bounce generated for <${from}> (${failures.length} recipient(s))`);
    },
  });

  const submissionHandler = (m: DeliveredMessage): void => {
    const { local, remote } = routeRecipients(m.recipients, cfg.domain);
    // RFC 6409 fix-up (submission only, never on the inbound port): add Date /
    // Message-ID when the client omitted them — Gmail rejects messages without.
    const fixed = ensureSubmissionHeaders(m.data, cfg.domain, m.from);
    // Stamp our Received trace line (§4.4), then sign — DKIM does not cover
    // Received, so the order is fix-up → Received → DKIM-Signature on top.
    const traced = prependReceived(fixed, {
      helo: m.helo,
      remoteAddress: m.remoteAddress,
      by: cfg.domain,
      protocol: protocolFor(m.overTls, m.authenticated),
      id: randomUUID(),
      ...(m.recipients.length === 1 ? { forRecipient: m.recipients[0]! } : {}),
      date: new Date(),
    });
    if (local.length > 0) storeLocal(traced);
    if (remote.length > 0) {
      // Sign the outbound copy once, queue it, and kick the loop so the first
      // attempt is immediate; failures are retried, not dropped.
      const outData = signer !== undefined ? dkimSign(traced, signer) : traced;
      queue.enqueue(m.from, remote, outData, Date.now());
      void relayLoop.tick(Date.now());
    }
  };
  const submission = await SmtpReceiver.start(submissionHandler, {
    domain: cfg.domain,
    tls: cfg.tls,
    requireAuth: true,
    authenticate: verify,
    host: cfg.host,
    port: cfg.submissionPort,
    ...(cfg.maxMessageSize !== undefined ? { maxMessageSize: cfg.maxMessageSize } : {}),
    maxReceivedHops: cfg.maxReceivedHops ?? 100,
  });
  const imap = await ImapServer.start(catalog, { tls: cfg.tls, host: cfg.host, port: cfg.imapPort, authenticate: verify, notifier });

  // Drain the queue on a timer, and once now to recover anything left by a crash.
  relayLoop.start(cfg.relayIntervalMs ?? 60_000);
  void relayLoop.tick(Date.now());

  return {
    inbound,
    submission,
    imap,
    mailbox,
    queue,
    relayLoop,
    async close() {
      relayLoop.stop();
      await inbound.close();
      await submission.close();
      await imap.close();
      db.close();
    },
  };
}

/** Build a config from environment variables, with dev-friendly defaults. */
function configFromEnv(): MailServerConfig & { usingDevCert: boolean } {
  const certPath = process.env.MAIL_TLS_CERT;
  const keyPath = process.env.MAIL_TLS_KEY;
  const usingDevCert = certPath === undefined || keyPath === undefined;
  // The bundled dev certificate is imported lazily only when no real cert is given.
  const dev = usingDevCert ? loadDevCert() : { cert: readFileSync(certPath!, 'utf8'), key: readFileSync(keyPath!, 'utf8') };
  // DKIM signing is enabled only when both a key file and a selector are given.
  const dkimKeyPath = process.env.MAIL_DKIM_KEY;
  const dkimSelector = process.env.MAIL_DKIM_SELECTOR;
  const dkim = dkimKeyPath !== undefined && dkimSelector !== undefined ? { selector: dkimSelector, privateKeyPem: readFileSync(dkimKeyPath, 'utf8') } : undefined;
  return {
    dbPath: process.env.MAIL_DB ?? 'mail.db',
    host: process.env.MAIL_HOST ?? '127.0.0.1',
    smtpPort: Number(process.env.MAIL_SMTP_PORT ?? 2525),
    submissionPort: Number(process.env.MAIL_SUBMISSION_PORT ?? 5587),
    imapPort: Number(process.env.MAIL_IMAP_PORT ?? 5993),
    domain: process.env.MAIL_DOMAIN ?? 'mail.example.com',
    accounts: [{ user: process.env.MAIL_USER ?? 'demo', pass: process.env.MAIL_PASS ?? 'demo' }],
    tls: dev,
    ...(dkim !== undefined ? { dkim } : {}),
    maxMessageSize: Number(process.env.MAIL_MAX_SIZE ?? 26_214_400), // 25 MiB default
    usingDevCert,
  };
}

/** The bundled self-signed certificate, for local development only. */
function loadDevCert(): { key: string; cert: string } {
  return { key: DEV_KEY, cert: DEV_CERT };
}

async function main(): Promise<void> {
  const cfg = configFromEnv();
  const log = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const server = await startServer({ ...cfg, onEvent: log });
  log(`mail server "${cfg.domain}" started (db: ${cfg.dbPath})`);
  log(`  inbound SMTP     ${cfg.host}:${server.inbound.port}`);
  log(`  submission (AUTH) ${cfg.host}:${server.submission.port}`);
  log(`  IMAPS            ${cfg.host}:${server.imap.port}`);
  log(`  accounts: ${cfg.accounts.map((a) => a.user).join(', ')}`);
  log(`  outbound: remote mail is queued and relayed to its MX, with retry${cfg.dkim !== undefined ? ' and DKIM signing' : ''}.`);
  if (cfg.usingDevCert) log('  NOTE: using the bundled self-signed DEV certificate — set MAIL_TLS_CERT/MAIL_TLS_KEY in production.');
  const shutdown = (): void => {
    log('shutting down...');
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run as a daemon when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
