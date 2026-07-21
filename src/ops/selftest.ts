/**
 * `node src/main.ts selftest <login>` — prove the RUNNING daemon actually works end to end,
 * the way a real client exercises it: authenticated submission over STARTTLS, local delivery,
 * and read-back over IMAPS. `doctor` checks the outside (DNS, cert, port 25); this checks the
 * inside — the one question a new operator most wants answered after first boot, "did my setup
 * actually send and receive a message?" (ADR 0018).
 *
 * It connects to the configured submission + IMAP ports (MAIL_HOST/MAIL_SUBMISSION_PORT/
 * MAIL_IMAP_PORT, same env the daemon reads), submits a uniquely-tagged message from the account
 * TO ITSELF, then logs in over IMAP, finds the tag, and deletes it again so the self-test leaves
 * no trace. In the project's spirit the SMTP and IMAP clients are hand-rolled on the byte layer —
 * no mail libraries. TLS certificate trust is deliberately NOT verified here (a local run uses the
 * bundled self-signed dev cert, and connecting to 127.0.0.1 would fail a hostname check anyway):
 * cert validity is `doctor`'s job; this is a proof of the mail path.
 */

import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import type { OpsIo } from './cli.ts';
import { promptSecret, validLogin } from './account.ts';

const USAGE = [
  'usage: node src/main.ts selftest <login>',
  '',
  'End-to-end check against the RUNNING daemon: authenticated submission over STARTTLS,',
  'local delivery, and read-back over IMAPS, using the account <login>. Prompts for that',
  "account's password (or reads one line from stdin when piped). Sends a tagged message to",
  'the account itself and deletes it again, so nothing is left behind.',
  '',
  'Reads MAIL_HOST / MAIL_SUBMISSION_PORT / MAIL_IMAP_PORT / MAIL_DOMAIN (the daemon\'s own',
  'environment). Exit 0 = the whole path works; 1 = a step failed; 2 = usage.',
].join('\n');

/** Positive-integer env parse with a fallback (mirrors main.ts). */
function posInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** A minimal line/response reader over a socket, with a timeout so a hang can't wedge the check. */
function reader(sock: net.Socket): { until: (re: RegExp) => Promise<string> } {
  let buf = '';
  let waiter: { re: RegExp; res: (s: string) => void; rej: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  const tryMatch = (): void => {
    if (waiter !== null && waiter.re.test(buf)) {
      const matched = buf;
      buf = '';
      clearTimeout(waiter.timer);
      const w = waiter;
      waiter = null;
      w.res(matched);
    }
  };
  sock.on('data', (d: Buffer) => {
    buf += d.toString('latin1');
    tryMatch();
  });
  sock.on('error', (e: Error) => {
    if (waiter !== null) {
      clearTimeout(waiter.timer);
      waiter.rej(e);
      waiter = null;
    }
  });
  return {
    until: (re: RegExp): Promise<string> =>
      new Promise<string>((res, rej) => {
        const timer = setTimeout(() => {
          waiter = null;
          rej(new Error(`timed out waiting for ${re} (got: ${JSON.stringify(buf.slice(-200))})`));
        }, 8000);
        waiter = { re, res, rej, timer };
        tryMatch();
      }),
  };
}

const send = (sock: net.Socket, line: string): void => void sock.write(line + '\r\n', 'latin1');
const lastLine = (block: string): string => block.trim().split('\n').pop()!.trim();

/** Open a socket, rejecting with a clear message when the daemon isn't listening. */
function dialPlain(host: string, port: number, what: string): Promise<net.Socket> {
  return new Promise((res, rej) => {
    const s = net.connect(port, host);
    s.once('connect', () => res(s));
    s.once('error', (e: NodeJS.ErrnoException) => rej(e.code === 'ECONNREFUSED' ? new Error(`could not connect to the ${what} at ${host}:${port} — is the daemon running?`) : e));
  });
}

function upgradeTls(socket: net.Socket): Promise<tls.TLSSocket> {
  return new Promise((res, rej) => {
    const t = tls.connect({ socket, rejectUnauthorized: false });
    t.once('secureConnect', () => res(t));
    t.once('error', rej);
  });
}

function dialImaps(host: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((res, rej) => {
    const t = tls.connect({ host, port, rejectUnauthorized: false });
    t.once('secureConnect', () => res(t));
    t.once('error', (e: NodeJS.ErrnoException) => rej(e.code === 'ECONNREFUSED' ? new Error(`could not connect to IMAPS at ${host}:${port} — is the daemon running?`) : e));
  });
}

/** Submit a tagged message from <address> to itself over authenticated STARTTLS submission. */
async function submitTagged(host: string, port: number, login: string, password: string, address: string, subject: string, expectedDomain: string, warn: (line: string) => void): Promise<void> {
  const plain = await dialPlain(host, port, 'submission port');
  let sock: net.Socket = plain;
  try {
    let r = reader(plain);
    const greeting = await r.until(/^220 /m);
    // selftest reads its target from the SAME MAIL_* variables as the daemon — but run
    // without them it silently dials the DEFAULT ports, and on a shared machine that can
    // be a different instance entirely (it would even PASS against it). The greeting
    // names the server's domain; a mismatch is the cheap tell, so say it out loud.
    const greetHost = /^220 (\S+)/m.exec(greeting)?.[1];
    if (greetHost !== undefined && greetHost.toLowerCase() !== expectedDomain.toLowerCase()) {
      warn(`  note: the server greets as "${greetHost}" but this selftest expects "${expectedDomain}" — if that surprises you, you may be talking to a different instance; run selftest with the same MAIL_* environment as the daemon.`);
    }
    send(plain, 'EHLO selftest.local');
    await r.until(/^250[ -]/m);
    send(plain, 'STARTTLS');
    await r.until(/^220 /m);
    sock = await upgradeTls(plain);
    r = reader(sock);
    send(sock, 'EHLO selftest.local');
    await r.until(/^250 /m); // final 250 (space) ends the EHLO list
    const auth = Buffer.from(`\x00${login}\x00${password}`, 'utf8').toString('base64');
    send(sock, `AUTH PLAIN ${auth}`);
    const authReply = await r.until(/^\d{3} /m);
    if (!authReply.startsWith('235')) throw new Error(`authentication failed: ${lastLine(authReply)} (check the password for ${login})`);
    send(sock, `MAIL FROM:<${address}>`);
    if (!(await r.until(/^\d{3} /m)).startsWith('250')) throw new Error('server rejected MAIL FROM');
    send(sock, `RCPT TO:<${address}>`);
    const rcpt = await r.until(/^\d{3} /m);
    if (!rcpt.startsWith('250')) throw new Error(`server rejected RCPT TO <${address}>: ${lastLine(rcpt)}`);
    send(sock, 'DATA');
    await r.until(/^354/m);
    const msg = [`From: ${address}`, `To: ${address}`, `Subject: ${subject}`, '', 'This is an automated cutie-mail self-test message. It is safe to ignore; the', 'selftest command deletes it again once it has been read back.', '.'].join('\r\n');
    send(sock, msg);
    const stored = await r.until(/^\d{3} /m);
    if (!stored.startsWith('250')) throw new Error(`server did not accept the message: ${lastLine(stored)}`);
    send(sock, 'QUIT');
  } finally {
    // Always tear the connection down — otherwise an open socket keeps the event loop alive and
    // the CLI never exits (both on success and on any thrown step).
    sock.destroy();
    plain.destroy();
  }
}

/** Log in over IMAP, find the tagged message by subject, delete it, and confirm it was there. */
async function findAndCleanup(host: string, port: number, login: string, password: string, subject: string): Promise<void> {
  const sock = await dialImaps(host, port);
  try {
    const r = reader(sock);
    await r.until(/^\* OK/m);
    send(sock, `x1 LOGIN ${login} ${password}`);
    if (!/^x1 OK/m.test(await r.until(/^x1 (OK|NO|BAD)/m))) throw new Error(`IMAP login failed for ${login} (check the password)`);
    send(sock, 'x2 SELECT INBOX');
    await r.until(/^x2 (OK|NO|BAD)/m);
    // Delivery on the local path is synchronous, but retry a few times so a slower machine or an
    // in-flight relay tick doesn't cause a spurious miss. UID SEARCH so we can UID EXPUNGE exactly
    // the tag (UIDPLUS) without touching any other \Deleted message in the box.
    let uids: string[] = [];
    for (let attempt = 0; attempt < 10 && uids.length === 0; attempt++) {
      if (attempt > 0) await new Promise((res) => setTimeout(res, 200));
      send(sock, `x3 UID SEARCH HEADER SUBJECT "${subject}"`);
      const search = await r.until(/^x3 (OK|NO|BAD)/m);
      const line = search.split('\n').find((l) => /^\* SEARCH/i.test(l));
      uids = line ? line.replace(/\r$/, '').split(/\s+/).slice(2).filter((t) => /^\d+$/.test(t)) : [];
      if (attempt < 9 && uids.length === 0) {
        // NOOP to pick up a message delivered after our first SELECT snapshot.
        send(sock, 'x2b NOOP');
        await r.until(/^x2b (OK|NO|BAD)/m);
      }
    }
    if (uids.length === 0) throw new Error('submission was accepted but the message never appeared in INBOX over IMAP — delivery or IMAP read is broken');
    // Clean up: mark the tag \Deleted and UID EXPUNGE it, so the self-test leaves nothing behind.
    send(sock, `x4 UID STORE ${uids.join(',')} +FLAGS (\\Deleted)`);
    await r.until(/^x4 (OK|NO|BAD)/m);
    send(sock, `x5 UID EXPUNGE ${uids.join(',')}`);
    await r.until(/^x5 (OK|NO|BAD)/m);
    send(sock, 'x6 LOGOUT');
  } finally {
    sock.destroy();
  }
}

/**
 * Run the end-to-end self-test. `password` is injected by tests; in normal use it is read from a
 * hidden prompt (or one stdin line when piped), never from argv.
 */
export async function runSelftest(args: readonly string[], io: OpsIo, env: Record<string, string | undefined>, password?: string): Promise<number> {
  const login = args[0];
  if (login === undefined || !validLogin(login)) {
    io.err(login === undefined ? 'selftest: a login is required.' : `selftest: invalid login ${JSON.stringify(login)}.`);
    io.err(USAGE);
    return 2;
  }
  const domain = env.MAIL_DOMAIN ?? 'mail.example.com';
  const host = env.MAIL_HOST ?? '127.0.0.1';
  // The daemon may bind 0.0.0.0 / :: (all interfaces); connect to loopback for a local check.
  const connectHost = host === '0.0.0.0' || host === '::' || host === '::0' ? '127.0.0.1' : host;
  const submissionPort = posInt(env.MAIL_SUBMISSION_PORT, 5587);
  const imapPort = posInt(env.MAIL_IMAP_PORT, 5993);
  const address = `${login}@${domain}`;
  const subject = `cutie-mail selftest ${randomUUID()}`;
  const pw = password ?? (await promptSecret(`password for ${login}: `));

  try {
    io.out(`selftest: submitting a tagged message as <${address}> via ${connectHost}:${submissionPort} (STARTTLS + AUTH)...`);
    await submitTagged(connectHost, submissionPort, login, pw, address, subject, domain, (l) => io.out(l));
    io.out('  ok   authenticated submission accepted');
    io.out(`selftest: reading it back over IMAPS at ${connectHost}:${imapPort}...`);
    await findAndCleanup(connectHost, imapPort, login, pw, subject);
    io.out('  ok   message delivered locally, read back over IMAP, and cleaned up');
    io.out('');
    io.out('selftest PASSED — authenticated submission, local delivery, and IMAP read-back all work.');
    return 0;
  } catch (e) {
    io.err(`selftest FAILED: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
