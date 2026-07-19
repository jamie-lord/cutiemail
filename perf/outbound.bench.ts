/**
 * Outbound ceiling — the real send leg, end to end. Starts the ACTUAL daemon (startServer)
 * with DKIM signing on, TLS on, and the relay DNS pointed at a local capture sink instead of
 * the internet, then measures the two stages that have different limits:
 *
 *   A. Submission accept — authenticated clients (STARTTLS + AUTH PLAIN) send messages to a
 *      REMOTE recipient. This is our CPU/disk ingest ceiling: sender-authz, header fix-up,
 *      DKIM RSA signing, enqueue. Measured with persistent connections (reuse TLS+auth, many
 *      messages each) so the number reflects per-message cost, not TLS handshake cost.
 *   B. Relay drain — the RelayLoop draining the queue to the sink (connect + send per message).
 *      Measured by how fast the sink receives them, and whether the queue fully drains.
 *
 * The gap between A and B is the interesting part: if we accept faster than we relay, the queue
 * backs up — Phase B reports whether it drained and how far behind it fell.
 *
 *   node --expose-gc perf/outbound.bench.ts [connections] [msgsPerConn]
 */

import net from 'node:net';
import tls from 'node:tls';
import { generateKeyPairSync } from 'node:crypto';
import { startServer, type MailServerConfig } from '../src/main.ts';
import { SmtpReceiver } from '../src/server/smtp-receiver.ts';
import { TEST_CERT, TEST_KEY } from '../src/testing/tls-test-cert.ts';
import { scratchDir, makeMessage, pad } from './lib.ts';

const connections = parseInt(process.argv[2] ?? '16', 10);
const msgsPerConn = parseInt(process.argv[3] ?? '50', 10);
const total = connections * msgsPerConn;
const now = (): number => Number(process.hrtime.bigint()) / 1e6;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const token = (u: string, p: string): string => Buffer.from(`\0${u}\0${p}`, 'latin1').toString('base64');

/** Read until a needle appears past the current offset. */
function reader(sock: NodeJS.ReadableStream): (needle: string) => Promise<void> {
  let acc = '';
  sock.on('data', (d: Buffer) => (acc += d.toString('latin1')));
  return (needle) =>
    new Promise((resolve, reject) => {
      const t = setInterval(() => {
        if (acc.includes(needle)) {
          clearInterval(t);
          acc = '';
          resolve();
        }
      }, 3);
      setTimeout(() => {
        clearInterval(t);
        reject(new Error(`timeout waiting for "${needle}"; got: ${acc.slice(-80)}`));
      }, 20000);
    });
}

/** One persistent authenticated submission connection; sends `k` messages, returns count accepted. */
async function submitMany(port: number, k: number): Promise<number> {
  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  const rr = reader(raw);
  await rr('ESMTP');
  raw.write(Buffer.from('EHLO perf\r\n', 'latin1'));
  await rr('250 STARTTLS');
  raw.write(Buffer.from('STARTTLS\r\n', 'latin1'));
  await rr('Ready to start TLS');
  const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
  secure.on('error', () => {});
  await new Promise<void>((r) => secure.once('secureConnect', () => r()));
  const sr = reader(secure);
  secure.write(Buffer.from('EHLO perf\r\n', 'latin1'));
  await sr('250 AUTH PLAIN');
  secure.write(Buffer.from('AUTH PLAIN ' + token('alice', 'correct horse') + '\r\n', 'latin1'));
  await sr('235');
  let accepted = 0;
  for (let i = 0; i < k; i++) {
    secure.write(Buffer.from('MAIL FROM:<alice@sender.example>\r\n', 'latin1'));
    await sr('2.1.0 Ok');
    secure.write(Buffer.from(`RCPT TO:<dest${i}@remote.example>\r\n`, 'latin1'));
    await sr('2.1.5 Ok');
    secure.write(Buffer.from('DATA\r\n', 'latin1'));
    await sr('354');
    // From: must be the authenticated user (ADR 0015 sender-authz). Pad the body to ~4 KB.
    const filler = makeMessage(i, 4096).subarray(400).toString('latin1').replace(/\r\n\./g, '\r\n..');
    const body =
      `From: alice@sender.example\r\nTo: dest${i}@remote.example\r\nSubject: perf ${i}\r\n\r\n` + filler;
    secure.write(Buffer.from(body + '\r\n.\r\n', 'latin1'));
    await sr('message stored');
    accepted++;
  }
  secure.write(Buffer.from('QUIT\r\n', 'latin1'));
  secure.end();
  return accepted;
}

async function main(): Promise<void> {
  const dir = scratchDir('outbound');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dkimPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  // The capture sink: a plain SMTP receiver standing in for every remote MX.
  let sinkReceived = 0;
  const sinkTimes: number[] = [];
  const sink = await SmtpReceiver.start(
    () => {
      sinkReceived++;
      sinkTimes.push(now());
    },
    { acceptRecipient: () => true },
  );

  const cfg: MailServerConfig = {
    dbPath: `${dir.path}/control.db`,
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'sender.example',
    accounts: [{ user: 'alice', pass: 'correct horse', mailDbPath: `${dir.path}/mail-alice.db` }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    outbound: { resolveHosts: async () => ['127.0.0.1'], port: sink.port },
    dkim: { selector: 'perf', privateKeyPem: dkimPem },
    relayIntervalMs: 250,
  };
  const server = await startServer(cfg);
  process.stderr.write(`daemon up: submission :${server.submission.port}, relay -> sink :${sink.port}. Sending ${total} messages.\n`);

  // --- Phase A: submission accept ceiling ---
  const tA = now();
  const accepts = await Promise.all(Array.from({ length: connections }, () => submitMany(server.submission.port, msgsPerConn)));
  const acceptMs = now() - tA;
  const accepted = accepts.reduce((a, b) => a + b, 0);

  // --- Phase B: relay drain to the sink ---
  // The loop was kicked on every enqueue; wait until the sink has everything (or we stall).
  const tB = now();
  let lastSeen = -1;
  let stallTicks = 0;
  while (sinkReceived < accepted && stallTicks < 40) {
    await delay(250);
    if (sinkReceived === lastSeen) stallTicks++;
    else {
      stallTicks = 0;
      lastSeen = sinkReceived;
    }
  }
  const drainMs = now() - tB;
  const relaySpanMs = sinkTimes.length > 1 ? sinkTimes[sinkTimes.length - 1]! - sinkTimes[0]! : drainMs;

  await server.close();
  await sink.close();
  dir.cleanup();

  console.log(`\nOutbound ceiling — ${connections} conns × ${msgsPerConn} msgs = ${total}, DKIM+TLS on, relay->local sink\n`);
  console.log([pad('stage', 34, true), pad('value', 14)].join(' '));
  console.log('-'.repeat(50));
  console.log([pad('submission accepted', 34, true), pad(`${accepted}/${total}`, 14)].join(' '));
  console.log([pad('submission accept rate', 34, true), pad(`${Math.round(accepted / (acceptMs / 1000))}/s`, 14)].join(' '));
  console.log([pad('relayed to sink', 34, true), pad(`${sinkReceived}/${accepted}`, 14)].join(' '));
  console.log([pad('relay throughput (span)', 34, true), pad(`${Math.round(sinkReceived / (relaySpanMs / 1000))}/s`, 14)].join(' '));
  console.log([pad('queue fully drained?', 34, true), pad(sinkReceived >= accepted ? 'YES' : `NO (${accepted - sinkReceived} stuck)`, 14)].join(' '));
  console.log(
    `\nSubmission accept is our ingest ceiling (authz + DKIM-sign + enqueue). Relay throughput is the` +
      `\nloop draining to a MX that always accepts instantly — the real internet will be slower.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
