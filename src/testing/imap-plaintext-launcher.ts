/**
 * Plaintext IMAP launcher for third-party conformance/stress tools (Dovecot's
 * imaptest). NOT part of the daemon and never used in production — the real
 * server is IMAPS-only. This exists so an external tester can drive the exact
 * same ImapServer code over a plain socket (imaptest's TLS client path is
 * awkward to build), on a throwaway database.
 *
 *   node src/testing/imap-plaintext-launcher.ts <port> <dbPath> <user> <pass>
 *
 * Wiring mirrors src/main.ts: a SqliteCatalog with INBOX + the RFC 6154
 * special-use folders, a MailboxNotifier, and a fixed-credential authenticate.
 */

import { SqliteCatalog } from '../store/sqlite-mailbox.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { ImapServer } from '../server/imap-server.ts';
import { MailboxNotifier } from '../server/mailbox-notifier.ts';

async function main(): Promise<void> {
  const port = Number(process.argv[2] ?? 14300);
  const dbPath = process.argv[3] ?? ':memory:';
  const user = process.argv[4] ?? 'test';
  const pass = process.argv[5] ?? 'test';

  const db = openMailDb(dbPath);
  const catalog = SqliteCatalog.open(db, 1);
  for (const name of ['Sent', 'Drafts', 'Trash', 'Junk', 'Archive']) catalog.create(name);

  const notifier = new MailboxNotifier();
  const server = await ImapServer.start(catalog, {
    host: '127.0.0.1',
    port,
    authenticate: (u, p) => u === user && p === pass,
    notifier,
  });
  process.stdout.write(`imap-plaintext-launcher listening on 127.0.0.1:${server.port} (user=${user})\n`);
}

void main();
