/**
 * Slow-consumer memory guard (docs/PERFORMANCE.md). The server frames a whole FETCH body and
 * hands it to the socket; a client that stops reading leaves it buffered in the process with no
 * bound, so many stalled readers OOM it — reproduced live: ~112 connections each stalling on a
 * 25 MB body triggered the Linux OOM-killer on the 3.7 GB box. The fix caps the SUMMED write
 * backlog and drops the slowest-draining connections when it is exceeded.
 *
 * The shedding decision is a pure function so it can be tested deterministically — the alternative
 * (real sockets) depends on kernel send-buffer sizes, which vary by platform (macOS loopback
 * absorbs tens of MB in the kernel where `writableLength` never grows; Linux buffers in-process,
 * where it does and where the OOM actually happens). The real end-to-end behaviour is validated on
 * the Linux box by perf/oom.bench.ts, which plateaus at the budget instead of being OOM-killed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shedToBudget, type Sheddable } from './imap-server.ts';

function fakeSocket(writableLength: number): Sheddable & { destroyed: boolean } {
  return {
    writableLength,
    destroyed: false,
    destroy(): void {
      this.destroyed = true;
    },
  };
}

test('under budget: nothing is shed', () => {
  const socks = [fakeSocket(1_000_000), fakeSocket(2_000_000), fakeSocket(0)];
  assert.equal(shedToBudget(socks, 10_000_000), 0);
  assert.ok(socks.every((s) => !s.destroyed));
});

test('over budget: sheds the biggest backlogs first, until back under, and no further', () => {
  // 25 MB + 25 MB + 25 MB + 1 KB = ~75 MB, budget 40 MB → drop the two 25 MB consumers (50→25 MB
  // ≤ 40), leaving the third 25 MB and the tiny one. (Dropping the largest first minimises kills.)
  const big1 = fakeSocket(25 * 1024 * 1024);
  const big2 = fakeSocket(25 * 1024 * 1024);
  const big3 = fakeSocket(25 * 1024 * 1024);
  const tiny = fakeSocket(1024);
  const shed = shedToBudget([big1, big2, big3, tiny], 40 * 1024 * 1024);
  assert.equal(shed, 2, 'drops exactly enough of the largest to get under budget');
  assert.equal([big1, big2, big3].filter((s) => s.destroyed).length, 2);
  assert.equal(tiny.destroyed, false, 'a near-empty (draining) socket is never shed');
});

test('a promptly-draining client (writableLength ~0) is never the one shed', () => {
  // One stalled 100 MB reader, plus 50 healthy clients holding ~0. Budget 8 MB.
  const stalled = fakeSocket(100 * 1024 * 1024);
  const healthy = Array.from({ length: 50 }, () => fakeSocket(0));
  const shed = shedToBudget([...healthy, stalled], 8 * 1024 * 1024);
  assert.equal(shed, 1, 'only the stalled consumer is dropped');
  assert.ok(stalled.destroyed);
  assert.ok(healthy.every((s) => !s.destroyed), 'every draining client survives');
});

test('total exceeds budget only via many mid-size backlogs: sheds enough of them', () => {
  // 20 connections each 20 MB = 400 MB, budget 256 MB → must shed the largest until ≤256 MB.
  const socks = Array.from({ length: 20 }, () => fakeSocket(20 * 1024 * 1024));
  const shed = shedToBudget(socks, 256 * 1024 * 1024);
  const remaining = socks.filter((s) => !s.destroyed).reduce((n, s) => n + s.writableLength, 0);
  assert.ok(remaining <= 256 * 1024 * 1024, 'remaining backlog is within budget');
  assert.ok(shed >= 8 && shed < 20, `shed enough but not all (${shed})`);
});

test('shed-the-victim: the socket that just wrote (exempt) is never dropped for others', () => {
  // The abuse from audit run-9: an attacker holds many modest, genuinely-stalled sockets, each kept
  // below a victim's transient peak; the victim's OWN large FETCH is what pushes the total over
  // budget. Because the shed samples writableLength synchronously right after the victim's write —
  // before the kernel drains a byte — the victim's socket shows its full pre-drain size and would be
  // selected as the single biggest backlog. Exempting the triggering socket must send the shed to
  // the attacker's accumulated backlog instead, and spare the victim.
  const attackers = Array.from({ length: 255 }, () => fakeSocket(1 * 1024 * 1024)); // 255 MB stalled
  const victim = fakeSocket(20 * 1024 * 1024); // just wrote a 20 MB body; sampled at pre-drain peak
  const shed = shedToBudget([...attackers, victim], 256 * 1024 * 1024, victim);
  assert.equal(victim.destroyed, false, 'the promptly-reading victim is NOT shed');
  assert.ok(shed >= 19, `sheds the attacker's stalled backlog instead (${shed})`);
  assert.equal(attackers.filter((s) => s.destroyed).length, shed, 'every shed socket is an attacker');
  const remaining = [...attackers, victim].filter((s) => !s.destroyed).reduce((n, s) => n + s.writableLength, 0);
  assert.ok(remaining <= 256 * 1024 * 1024, 'and the total is brought back within budget');
});

test('exempt still counts toward the total (memory bound is preserved)', () => {
  // If the exempt socket did not count toward `total`, a large exempt write plus a full-budget
  // backlog of others would sit unbounded above budget. It must count, so others are shed to fit.
  const others = Array.from({ length: 10 }, () => fakeSocket(30 * 1024 * 1024)); // 300 MB
  const exempt = fakeSocket(20 * 1024 * 1024);
  shedToBudget([...others, exempt], 256 * 1024 * 1024, exempt);
  const remaining = [...others, exempt].filter((s) => !s.destroyed).reduce((n, s) => n + s.writableLength, 0);
  assert.ok(remaining <= 256 * 1024 * 1024, 'exempt is counted, so the total is still bounded');
  assert.equal(exempt.destroyed, false);
});
