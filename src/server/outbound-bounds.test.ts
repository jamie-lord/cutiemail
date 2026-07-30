/**
 * Outbound delivery is BOUNDED and CANCELLABLE, so a hostile recipient domain cannot stall every
 * account's mail or hold shutdown open. RFC 5321 §5.1 puts no ceiling on an MX RRset, and the
 * relay loop is single-flight: one queued message to a domain that publishes thousands of MX
 * records — all resolving to public IPs it controls that black-hole the connection — used to walk
 * them serially at a full connect timeout each, for hours, while `stop()` blocked on the in-flight
 * walk (the SIGTERM/cutover hang).
 *
 * The bounds are enforced at the single chokepoint every host attempt funnels through, so no path
 * can re-inflate them:
 *   - MAX_DELIVERY_HOSTS caps the serial walk (proven: connections stop at the cap);
 *   - a per-recipient wall-clock budget defers a recipient that fails over too long;
 *   - opts.signal unwinds an in-flight walk at the next host/recipient boundary.
 * Injected resolveHosts points delivery at a local capture server, so these are the real code path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { relayOutbound } from './outbound.ts';

/** A capture TCP server that counts connections and applies `onConn` to each raw socket. */
async function captureServer(onConn: (sock: net.Socket) => void): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  let connections = 0;
  const server = net.createServer((sock) => {
    connections++;
    sock.on('error', () => {});
    onConn(sock);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    connections: () => connections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('a huge MX RRset is walked no further than MAX_DELIVERY_HOSTS, and the truncation is logged', async () => {
  // Every connection is dropped immediately → each host fails transient → the walk would try them
  // all, if it were not capped. Point 5000 "MX hosts" at the one capture server.
  const cap = await captureServer((sock) => sock.destroy());
  const logs: string[] = [];
  try {
    const hosts = Array.from({ length: 5000 }, () => '127.0.0.1');
    const results = await relayOutbound(
      { from: 'me@ours.test', recipients: ['victim@hostile.test'], data: Buffer.from('x') },
      { clientName: 'ours.test', port: cap.port, resolveHosts: async () => hosts, log: (l) => logs.push(l) },
    );
    assert.equal(cap.connections(), 10, 'the serial walk stops at MAX_DELIVERY_HOSTS, not 5000');
    assert.equal(results[0]!.classification, 'transient', 'all hosts failed → deferred, never dropped');
    assert.ok(logs.some((l) => /5000 MX hosts offered; attempting the first 10/.test(l)), 'the truncation is logged, not silent');
  } finally {
    await cap.close();
  }
});

test('a recipient that fails over past its time budget is deferred instead of monopolising the loop', async () => {
  // Each host accepts, holds 40 ms, then drops — so a single attempt outlasts a 20 ms budget and
  // the budget (checked BETWEEN hosts) breaks the walk after the first, deferring the recipient.
  const cap = await captureServer((sock) => setTimeout(() => sock.destroy(), 40));
  try {
    const hosts = ['127.0.0.1', '127.0.0.1', '127.0.0.1'];
    const results = await relayOutbound(
      { from: 'me@ours.test', recipients: ['victim@slow.test'], data: Buffer.from('x') },
      { clientName: 'ours.test', port: cap.port, resolveHosts: async () => hosts, deliveryBudgetMs: 20 },
    );
    assert.equal(cap.connections(), 1, 'the budget breaks the walk after the first host, not all three');
    assert.equal(results[0]!.classification, 'transient');
    assert.match(results[0]!.detail, /delivery time budget/);
  } finally {
    await cap.close();
  }
});

test('an aborted signal defers every recipient without opening a single connection', async () => {
  const cap = await captureServer((sock) => sock.destroy());
  try {
    const results = await relayOutbound(
      { from: 'me@ours.test', recipients: ['a@x.test', 'b@y.test'], data: Buffer.from('x') },
      { clientName: 'ours.test', port: cap.port, resolveHosts: async () => ['127.0.0.1'], signal: AbortSignal.abort() },
    );
    assert.equal(cap.connections(), 0, 'nothing is dialled once the signal is aborted');
    assert.deepEqual(results.map((r) => r.classification), ['transient', 'transient'], 'both recipients deferred, none dropped');
    assert.match(results[0]!.detail, /stopping/);
  } finally {
    await cap.close();
  }
});

test('a signal aborted mid-walk stops before the next host', async () => {
  // The first connection trips the signal; the host-loop boundary check then abandons the rest.
  const controller = new AbortController();
  const cap = await captureServer((sock) => {
    controller.abort();
    sock.destroy();
  });
  try {
    const hosts = ['127.0.0.1', '127.0.0.1', '127.0.0.1', '127.0.0.1'];
    const results = await relayOutbound(
      { from: 'me@ours.test', recipients: ['victim@hostile.test'], data: Buffer.from('x') },
      { clientName: 'ours.test', port: cap.port, resolveHosts: async () => hosts, signal: controller.signal },
    );
    assert.equal(cap.connections(), 1, 'the walk stops at the boundary after the abort, not after all four hosts');
    assert.equal(results[0]!.classification, 'transient');
  } finally {
    await cap.close();
  }
});
