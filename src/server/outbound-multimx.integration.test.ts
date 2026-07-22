/**
 * Multi-MX fallback and post-DATA duplication (RFC 5321 §5.1 / §4.5.4.1 / §4.5.3.2.6).
 *
 * relayOutbound tries a recipient's MX hosts in preference order; the per-host outcomes must be
 * MERGED, not overwritten last-host-wins. These cases pin the aggregate semantics:
 *   - a 5yz from a REACHABLE MX is authoritative-permanent and stops the walk;
 *   - a higher-preference transient failure is NOT overridden by a later lower-preference 5yz;
 *   - a delivered message is never sent a second time (no same-tick double-send);
 *   - a post-EOD indeterminate outcome defers WITHOUT walking to the next MX (no duplicate).
 *
 * Two candidate hosts are modelled as two connections to ONE stateful capture server (the relay
 * loop uses a single port for all hosts), so connection #0 is the "primary" and #1 the "backup".
 * A per-connection behaviour script gives each MX its role.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { relayOutbound } from './outbound.ts';

type Mode = 'accept' | 'greet-421' | 'reject-mail-550' | 'withhold-eod' | 'close-after-eod';

interface Capture {
  readonly connections: () => number;
  readonly deliveries: () => readonly { conn: number }[];
  readonly port: number;
  readonly close: () => Promise<void>;
}

/** A stateful capture MX: connection N is handled per `modes[N]`. */
async function multiMx(modes: readonly Mode[]): Promise<Capture> {
  let conns = 0;
  const deliveries: { conn: number }[] = [];
  const server = net.createServer((sock) => {
    const idx = conns++;
    const mode: Mode = modes[idx] ?? 'accept';
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let inData = false;
    sock.write(mode === 'greet-421' ? '421 4.3.2 service not available\r\n' : '220 mx.test ESMTP\r\n');
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (inData) {
          const at = buf.indexOf('\r\n.\r\n');
          if (at === -1) return;
          buf = buf.subarray(at + 5);
          inData = false;
          if (mode === 'withhold-eod') return; // consume the message but never reply (indeterminate)
          if (mode === 'close-after-eod') { sock.destroy(); return; } // consumed, then vanished - also indeterminate
          deliveries.push({ conn: idx });
          sock.write('250 2.0.0 accepted\r\n');
          continue;
        }
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        const line = buf.subarray(0, nl).toString('latin1').trim();
        buf = buf.subarray(nl + 1);
        const verb = line.split(/\s+/)[0]?.toUpperCase() ?? '';
        if (verb === 'EHLO' || verb === 'HELO') sock.write('250 mx.test\r\n');
        else if (verb === 'MAIL') sock.write(mode === 'reject-mail-550' ? '550 5.1.0 sender rejected\r\n' : '250 2.1.0 Ok\r\n');
        else if (verb === 'RCPT') sock.write('250 2.1.5 Ok\r\n');
        else if (verb === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); return; }
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    connections: () => conns,
    deliveries: () => deliveries,
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const MSG = { from: 'me@sender.test', recipients: ['friend@elsewhere.example'], data: Buffer.from('Subject: t\r\n\r\nhi\r\n', 'latin1') };

/** Relay MSG to the capture server, presenting it as TWO equal candidate MX hosts. */
async function relayTwoHosts(mx: Capture, opts: { postDataReplyTimeoutMs?: number } = {}) {
  return relayOutbound(MSG, {
    clientName: 'sender.test',
    resolveHosts: async () => ['127.0.0.1', '127.0.0.1'],
    port: mx.port,
    ...(opts.postDataReplyTimeoutMs !== undefined ? { postDataReplyTimeoutMs: opts.postDataReplyTimeoutMs } : {}),
  });
}

test('primary transient + secondary accepts → delivered via the backup', async () => {
  const mx = await multiMx(['greet-421', 'accept']);
  try {
    const [r] = await relayTwoHosts(mx);
    assert.equal(r!.ok, true, `should deliver via the backup: ${r!.detail}`);
    assert.equal(r!.classification, 'success');
    assert.equal(mx.connections(), 2, 'both hosts were tried');
    assert.deepEqual(mx.deliveries().map((d) => d.conn), [1], 'the message landed once, on the backup only');
  } finally {
    await mx.close();
  }
});

test('primary 5yz is authoritative-permanent: the walk STOPS, the backup is never tried', async () => {
  const mx = await multiMx(['reject-mail-550', 'accept']);
  try {
    const [r] = await relayTwoHosts(mx);
    assert.equal(r!.ok, false);
    assert.equal(r!.classification, 'permanent', 'a reachable MX 5yz bounces, it is not downgraded to transient');
    assert.equal(mx.connections(), 1, 'the loop stops at the authoritative 5yz - no probing of backups');
    assert.equal(mx.deliveries().length, 0, 'and nothing was delivered to a reachable backup');
  } finally {
    await mx.close();
  }
});

test('primary transient + secondary 5yz → TRANSIENT (a stale backup 5yz never bounces mail the primary would take)', async () => {
  const mx = await multiMx(['greet-421', 'reject-mail-550']);
  try {
    const [r] = await relayTwoHosts(mx);
    assert.equal(r!.ok, false);
    assert.equal(r!.classification, 'transient', 'the higher-preference transient failure wins - the primary may recover');
    assert.equal(mx.connections(), 2, 'both were tried');
  } finally {
    await mx.close();
  }
});

test('primary accepts → the secondary receives NOTHING (no same-tick double-send)', async () => {
  const mx = await multiMx(['accept', 'accept']);
  try {
    const [r] = await relayTwoHosts(mx);
    assert.equal(r!.ok, true);
    assert.equal(mx.connections(), 1, 'only the primary was contacted');
    assert.deepEqual(mx.deliveries().map((d) => d.conn), [0], 'exactly one delivery, to the primary');
  } finally {
    await mx.close();
  }
});

test('post-EOD indeterminate defers WITHOUT walking to the next MX (RFC 5321 §4.5.3.2.6, no duplicate)', async () => {
  // The primary consumes the whole message + terminating dot, then withholds the 250. With a short
  // post-EOD timeout the outcome is indeterminate: the loop must NOT try the backup (that would
  // duplicate to an org that may already hold the message), and must defer for a later retry.
  const mx = await multiMx(['withhold-eod', 'accept']);
  try {
    const [r] = await relayTwoHosts(mx, { postDataReplyTimeoutMs: 200 });
    assert.equal(r!.ok, false);
    assert.equal(r!.classification, 'transient', 'an indeterminate outcome defers, it does not bounce');
    assert.match(r!.detail, /indeterminate/, 'the reason names the indeterminate post-EOD outcome');
    assert.equal(mx.connections(), 1, 'the backup MX was NOT contacted (no same-tick resend to a second host)');
  } finally {
    await mx.close();
  }
});

test('a peer that CLOSES after consuming the terminator is also indeterminate (no next-MX resend, no throw)', async () => {
  // The close variant of the indeterminate outcome: the peer took the whole message then dropped
  // the connection without a 250. The QUIT send then fails on a dead wire - which must NOT throw
  // out into a plain transient that walks to the backup and duplicates. It stays a deferred
  // indeterminate on the first host only.
  const mx = await multiMx(['close-after-eod', 'accept']);
  try {
    const [r] = await relayTwoHosts(mx, { postDataReplyTimeoutMs: 5_000 });
    assert.equal(r!.ok, false);
    assert.equal(r!.classification, 'transient', 'a close-after-EOD defers, it does not bounce');
    assert.equal(mx.connections(), 1, 'the backup MX was NOT contacted');
  } finally {
    await mx.close();
  }
});
