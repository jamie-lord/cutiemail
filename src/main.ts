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
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SqliteMailbox } from './store/sqlite-mailbox.ts';
import { AccountStore } from './store/accounts.ts';
import { SmtpReceiver } from './server/smtp-receiver.ts';
import { ImapServer } from './server/imap-server.ts';
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
}

export interface RunningServer {
  readonly inbound: SmtpReceiver;
  readonly submission: SmtpReceiver;
  readonly imap: ImapServer;
  readonly mailbox: SqliteMailbox;
  close(): Promise<void>;
}

/** Assemble and start the server from a full config. Returns the running handles. */
export async function startServer(cfg: MailServerConfig): Promise<RunningServer> {
  const db = new DatabaseSync(cfg.dbPath);
  const mailbox = SqliteMailbox.open(db, 1);

  const accounts = new AccountStore();
  for (const a of cfg.accounts) accounts.setPassword(a.user, a.pass, randomBytes(16), 4096, 'sha256');
  const verify = (user: string, pass: string): boolean => accounts.verifyPassword(user, pass);

  const store = (m: { data: Buffer }): void => void mailbox.append(m.data);

  const inbound = await SmtpReceiver.start(store, { domain: cfg.domain, tls: cfg.tls, host: cfg.host, port: cfg.smtpPort });
  const submission = await SmtpReceiver.start(store, {
    domain: cfg.domain,
    tls: cfg.tls,
    requireAuth: true,
    authenticate: verify,
    host: cfg.host,
    port: cfg.submissionPort,
  });
  const imap = await ImapServer.start(mailbox, { tls: cfg.tls, host: cfg.host, port: cfg.imapPort, authenticate: verify });

  return {
    inbound,
    submission,
    imap,
    mailbox,
    async close() {
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
  return {
    dbPath: process.env.MAIL_DB ?? 'mail.db',
    host: process.env.MAIL_HOST ?? '127.0.0.1',
    smtpPort: Number(process.env.MAIL_SMTP_PORT ?? 2525),
    submissionPort: Number(process.env.MAIL_SUBMISSION_PORT ?? 5587),
    imapPort: Number(process.env.MAIL_IMAP_PORT ?? 5993),
    domain: process.env.MAIL_DOMAIN ?? 'mail.example.com',
    accounts: [{ user: process.env.MAIL_USER ?? 'demo', pass: process.env.MAIL_PASS ?? 'demo' }],
    tls: dev,
    usingDevCert,
  };
}

/** The bundled self-signed certificate, for local development only. */
function loadDevCert(): { key: string; cert: string } {
  return { key: DEV_KEY, cert: DEV_CERT };
}

async function main(): Promise<void> {
  const cfg = configFromEnv();
  const server = await startServer(cfg);
  const log = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  log(`mail server "${cfg.domain}" started (db: ${cfg.dbPath})`);
  log(`  inbound SMTP     ${cfg.host}:${server.inbound.port}`);
  log(`  submission (AUTH) ${cfg.host}:${server.submission.port}`);
  log(`  IMAPS            ${cfg.host}:${server.imap.port}`);
  log(`  accounts: ${cfg.accounts.map((a) => a.user).join(', ')}`);
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
