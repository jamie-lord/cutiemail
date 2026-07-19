/**
 * Inbound-burst stress — how much mail can the server accept at once, and does concurrent
 * delivery ever raise SQLITE_BUSY?
 *
 * Fires `total` deliveries with `concurrency` connections open at a time, split across
 * `users` recipient mailboxes (each its own DB file). Because node:sqlite is synchronous
 * and the server is single-threaded, every append runs to completion before the next — so
 * this measures the real sustained accept rate and confirms the busy_timeout keeps
 * concurrent writers from ever erroring.
 *
 *   node perf/inbound-burst.bench.ts [total] [concurrency] [users]
 */

import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openMailDb } from '../src/store/open-mail-db.ts';
import { SqliteCatalog } from '../src/store/sqlite-mailbox.ts';
import { SmtpReceiver } from '../src/server/smtp-receiver.ts';
import { scratchDir, makeMessage, pad } from './lib.ts';

const total = parseInt(process.argv[2] ?? '5000', 10);
const concurrency = parseInt(process.argv[3] ?? '32', 10);
const users = parseInt(process.argv[4] ?? '10', 10);
const now = (): number => Number(process.hrtime.bigint()) / 1e6;
const msg = makeMessage(7, 4096).toString('latin1');

async function deliver(port: number, user: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let stage = 0;
    const steps = ['EHLO x\r\n', 'MAIL FROM:<s@ex.com>\r\n', 'RCPT TO:<' + user + '@ex.net>\r\n', 'DATA\r\n', msg + '\r\n.\r\n'];
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (!/(\r\n|^)(\d{3}) /.test(buf)) return;
      const code = buf.trim().slice(-3);
      buf = '';
      if (stage >= steps.length) {
        sock.destroy();
        resolve(buf.length === 0);
        return;
      }
      if (code.startsWith('5') || code.startsWith('4')) {
        sock.destroy();
        resolve(false);
        return;
      }
      sock.write(Buffer.from(steps[stage++]!, 'latin1'));
    });
    sock.on('error', () => resolve(false));
    // Kick off after the 220 greeting (handled by the first data event with stage 0).
  });
}

async function main(): Promise<void> {
  const dir = scratchDir('burst');
  const stores = new Map<string, { cat: SqliteCatalog; db: DatabaseSync }>();
  for (let u = 0; u < users; u++) {
    const db = openMailDb(`${dir.path}/mail-u${u}.db`);
    stores.set(`u${u}`, { cat: SqliteCatalog.open(db), db });
  }
  let busyErrors = 0;
  let accepted = 0;
  const smtp = await SmtpReceiver.start(
    (m) => {
      // Route by the recipient's local part carried in the envelope.
      const to = (m.recipients[0] ?? 'u0@ex.net').split('@')[0] ?? 'u0';
      const s = stores.get(to) ?? stores.get('u0')!;
      try {
        s.cat.get('INBOX')!.append(m.data, [], Date.now());
        accepted++;
      } catch (e) {
        if (String(e).includes('BUSY') || String(e).includes('locked')) busyErrors++;
        throw e;
      }
    },
    { acceptRecipient: () => true },
  );

  const t0 = now();
  let sent = 0;
  let ok = 0;
  let inFlight = 0;
  let next = 0;
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (inFlight < concurrency && next < total) {
        const u = `u${next % users}`;
        next++;
        inFlight++;
        deliver(smtp.port, u).then((good) => {
          sent++;
          if (good) ok++;
          inFlight--;
          if (sent === total) resolve();
          else pump();
        });
      }
    };
    pump();
  });
  const ms = now() - t0;

  await smtp.close();
  for (const s of stores.values()) s.db.close();
  dir.cleanup();

  console.log(`\nInbound burst — ${total} deliveries, ${concurrency} concurrent, ${users} recipient DBs\n`);
  console.log([pad('metric', 30, true), pad('value', 12)].join(' '));
  console.log('-'.repeat(43));
  console.log([pad('wall time', 30, true), pad(`${ms.toFixed(0)} ms`, 12)].join(' '));
  console.log([pad('accepted (250)', 30, true), pad(ok, 12)].join(' '));
  console.log([pad('sustained accept rate', 30, true), pad(`${Math.round(total / (ms / 1000))}/s`, 12)].join(' '));
  console.log([pad('SQLITE_BUSY / locked errors', 30, true), pad(busyErrors, 12)].join(' '));
  console.log(
    `\nThe accept rate is the single synchronous writer's ceiling — concurrency does not raise it` +
      `\n(one event loop), but ${busyErrors === 0 ? 'no delivery ever hit SQLITE_BUSY (busy_timeout holds).' : 'BUSY errors appeared — investigate.'}\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
