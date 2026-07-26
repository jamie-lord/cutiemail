/**
 * A running mail server for the IMAP wire-conformance cases.
 *
 * The whole daemon, assembled by `startServer`, on ephemeral loopback ports — not an `ImapServer`
 * constructed directly with a `MemoryCatalog`. That distinction is the point of these cases: the
 * requirements in the IMAP register bind the assembled server, and a defect in how the pieces are
 * wired together is invisible to a test that constructs the pieces itself.
 */

import { startServer, type MailServerConfig, type RunningServer } from '../main.ts';
import { TEST_CERT, TEST_KEY } from './tls-test-cert.ts';
import { ImapClient } from './imap-client.ts';

export const IMAP_TEST_DOMAIN = 'imap.one.example';
export const IMAP_TEST_USER = 'you';
export const IMAP_TEST_PASS = 'a-real-passphrase';

export interface ImapFixture {
  readonly server: RunningServer;
  /** Connect and log in, returning a ready session in the authenticated state. */
  session(user?: string, pass?: string): Promise<ImapClient>;
  /** Put `count` messages in `mailbox`, straight into the store — no protocol involved. */
  seed(mailbox: string, count: number, prefix?: string): void;
}

/**
 * Run `fn` against a live server, closing every session and the server afterwards.
 *
 * Sessions are tracked and destroyed centrally because an IMAP socket left open keeps the event
 * loop alive and turns a failed assertion into a hung test run rather than a red one.
 */
export async function withImapServer(fn: (fixture: ImapFixture) => Promise<void>, overrides: Partial<MailServerConfig> = {}): Promise<void> {
  const cfg: MailServerConfig = {
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: IMAP_TEST_DOMAIN,
    accounts: [{ user: IMAP_TEST_USER, pass: IMAP_TEST_PASS }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    dkimKeyResolver: async () => null,
    spfResolvers: { txt: async () => [], a: async () => [], mx: async () => [] },
    outboundMode: 'hold',
    ...overrides,
  };
  const server = await startServer(cfg);
  const open: ImapClient[] = [];
  try {
    await fn({
      server,
      async session(user = IMAP_TEST_USER, pass = IMAP_TEST_PASS) {
        const client = await ImapClient.connect(server.imap.port);
        open.push(client);
        const reply = await client.command(`LOGIN ${user} ${pass}`);
        if (reply.status !== 'OK') throw new Error(`LOGIN failed: ${reply.line}`);
        return client;
      },
      seed(mailbox, count, prefix = 'seeded') {
        const store = server.stores.get(IMAP_TEST_USER);
        if (store === undefined) throw new Error('the test account has no store');
        const box = store.catalog.get(mailbox) ?? store.catalog.create(mailbox);
        if (box === undefined) throw new Error(`could not create ${mailbox}`);
        for (let i = 0; i < count; i++) {
          box.append(
            Buffer.from(`From: sender@two.example\r\nTo: ${IMAP_TEST_USER}@${IMAP_TEST_DOMAIN}\r\nSubject: ${prefix} ${i}\r\n\r\nbody ${i}\r\n`, 'latin1'),
            [],
            1_700_000_000_000 + i * 1000,
          );
        }
      },
    });
  } finally {
    for (const client of open) client.close();
    await server.close();
  }
}
