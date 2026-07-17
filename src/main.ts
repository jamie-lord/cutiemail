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
import { ensureSubmissionHeaders } from './server/submission-fixup.ts';
import { dkimSign, makeSigner } from './server/dkim-signer.ts';
import { prependReceived, protocolFor } from './server/received.ts';
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
}

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

  // Inbound (port 25): mail arriving for us — stamp our Received trace line
  // (RFC 5321 §4.4: the final-delivery MTA prepends one) and store it.
  const inbound = await SmtpReceiver.start((m) => {
    const receivedAt = new Date();
    const traced = prependReceived(m.data, {
      helo: m.helo,
      remoteAddress: m.remoteAddress,
      by: cfg.domain,
      protocol: protocolFor(m.overTls, false),
      id: randomUUID(),
      ...(m.recipients.length === 1 ? { forRecipient: m.recipients[0]! } : {}),
      date: receivedAt,
    });
    // INTERNALDATE = the moment we accepted the message (RFC 9051 §2.3.3), the same
    // instant stamped into the Received trace line above.
    storeLocal(traced, receivedAt.getTime());
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
  const relayLoop = new RelayLoop(queue, (m) => relayOutbound(m, outboundOpts), { log });

  const submissionHandler = (m: DeliveredMessage): void => {
    const { local, remote } = routeRecipients(m.recipients, cfg.domain);
    // RFC 6409 fix-up (submission only, never on the inbound port): add Date /
    // Message-ID when the client omitted them — Gmail rejects messages without.
    const fixed = ensureSubmissionHeaders(m.data, cfg.domain);
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
