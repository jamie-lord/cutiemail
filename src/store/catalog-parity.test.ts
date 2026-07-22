/**
 * Catalog-level differential parity (ADR 0016). The production `SqliteCatalog` and the
 * reference `MemoryCatalog` must be OBSERVABLY IDENTICAL across mailbox-management operations —
 * CREATE / DELETE / RENAME — exactly as `sqlite-mailbox.test.ts` already proves for the per-
 * mailbox operations. That harness never called the catalog-only methods, so RENAME (and its
 * QRESYNC-critical tombstone/mod-sequence effects) had no differential oracle at all — which is
 * how the INBOX-rename bugs reached production while the suite stayed green.
 *
 * `exerciseCatalog` runs one deliberately-nasty sequence and returns a fully-serialised view of
 * every mailbox: names, live UID/flag/mod_seq per message, uid_next, highest_modseq, and the
 * whole expunge log. `assert.deepEqual` of that view across the two implementations is the proof
 * that the fresh-target rename semantics are implemented identically in both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MemoryCatalog } from './memory-catalog.ts';
import { SqliteCatalog } from './sqlite-mailbox.ts';

interface MailboxView {
  readonly messages: ReadonlyArray<{ uid: number; modseq: number; flags: string[]; body: string }>;
  readonly uidNext: number;
  readonly uidValidity: number;
  readonly highestModseq: number;
  readonly expungedFrom0: number[];
}

interface CatalogLike {
  get(name: string): {
    append(raw: Buffer, flags?: readonly string[], internalDate?: number): number;
    expunge(uid: number): void;
    storeFlags(uid: number, mode: 'add' | 'remove' | 'replace', flags: readonly string[]): void;
    readonly messages: ReadonlyArray<{ uid: number; modseq: number; flags: ReadonlySet<string>; raw: Buffer }>;
    readonly uidNext: number;
    readonly uidValidity: number;
    readonly highestModseq: number;
    expungedSince(modseq: number): number[];
  } | undefined;
  create(name: string): unknown;
  delete(name: string): boolean;
  rename(from: string, to: string): 'ok' | 'notfound' | 'exists';
  listNames(): readonly string[];
}

function viewOf(cat: CatalogLike): Record<string, MailboxView> {
  const out: Record<string, MailboxView> = {};
  for (const name of [...cat.listNames()].sort()) {
    const mb = cat.get(name)!;
    out[name] = {
      messages: mb.messages.map((m) => ({ uid: m.uid, modseq: m.modseq, flags: [...m.flags].sort(), body: m.raw.toString('latin1') })),
      uidNext: mb.uidNext,
      // UIDVALIDITY is part of the observable view too (RFC 9051 §6.3.4): a monotonic-counter
      // divergence between the backends would recreate a name with a different validity in one
      // implementation than the other, which this parity assert now catches.
      uidValidity: mb.uidValidity,
      highestModseq: mb.highestModseq,
      expungedFrom0: mb.expungedSince(0),
    };
  }
  return out;
}

/** One exercise sequence driving the catalog-only operations, returning a serialised view. */
function exerciseCatalog(cat: CatalogLike): Record<string, MailboxView> {
  const inbox = cat.get('INBOX')!;
  const u1 = inbox.append(Buffer.from('alpha'), ['\\Seen'], 1000);
  inbox.append(Buffer.from('bravo'), [], 2000);
  const u3 = inbox.append(Buffer.from('charlie'), ['\\Flagged'], 3000);
  inbox.storeFlags(u3, 'add', ['\\Seen']); // bump a mod_seq
  inbox.expunge(u1); // a PRE-EXISTING INBOX tombstone (must not migrate on rename)

  cat.create('Work');
  cat.get('Work')!.append(Buffer.from('memo'), [], 4000);

  // First INBOX rename → fresh target 'Archive'; INBOX keeps its tombstone + gains the moved-out
  // UIDs as VANISHED.
  assert.equal(cat.rename('INBOX', 'Archive'), 'ok');
  // Second consecutive INBOX rename on the now-empty INBOX. INBOX's expunge
  // log must survive; 'Backup' must be a clean empty mailbox.
  assert.equal(cat.rename('INBOX', 'Backup'), 'ok');

  // A plain (non-INBOX) rename, for good measure.
  assert.equal(cat.rename('Work', 'Projects'), 'ok');
  assert.equal(cat.delete('Backup'), true);

  // Delete-then-recreate a name: the recreated mailbox must get a fresh, higher UIDVALIDITY in
  // BOTH backends identically (RFC 9051 §6.3.4), never the deleted incarnation's — so the
  // monotonic counter has to advance in lockstep. Recreate 'Backup' (just deleted above).
  assert.notEqual(cat.create('Backup'), undefined, 'the recreated Backup is created');

  return viewOf(cat);
}

test('SqliteCatalog and MemoryCatalog are observably identical across CREATE/DELETE/RENAME (incl. double INBOX rename)', () => {
  const mem = exerciseCatalog(new MemoryCatalog(1));
  const sql = exerciseCatalog(SqliteCatalog.open(new DatabaseSync(':memory:'), 1));
  assert.deepEqual(sql, mem);
});

test('DELETE then CREATE of the same name assigns a strictly-greater UIDVALIDITY (RFC 9051 §6.3.4, both implementations)', () => {
  // An INVARIANT assertion, not parity: reusing UIDVALIDITY 1 on a recreated name is a bug BOTH
  // backends shared before this fix (both hardcoded uidValidity = 1 in create()), so the
  // differential oracle above is blind to it — it only catches the two DIVERGING. An offline
  // client that cached (UIDVALIDITY 1, UID 1..n) for the old Work would show those stale bodies
  // for the new Work's freshly-assigned UID 1..m. The recreated mailbox must therefore never
  // reuse a prior incarnation's (UIDVALIDITY, UID) space.
  for (const cat of [new MemoryCatalog(1) as CatalogLike, SqliteCatalog.open(new DatabaseSync(':memory:'), 1)]) {
    cat.create('Work');
    cat.get('Work')!.append(Buffer.from('old body'));
    const firstValidity = cat.get('Work')!.uidValidity;
    assert.equal(cat.delete('Work'), true);
    cat.create('Work');
    const secondValidity = cat.get('Work')!.uidValidity;
    assert.ok(
      secondValidity > firstValidity,
      `recreated Work UIDVALIDITY ${secondValidity} must exceed the deleted incarnation's ${firstValidity}`,
    );
    assert.equal(cat.get('Work')!.messages.length, 0, 'the recreated mailbox is empty');
    // And a third incarnation climbs again — the counter is monotonic, never merely toggled.
    assert.equal(cat.delete('Work'), true);
    cat.create('Work');
    assert.ok(cat.get('Work')!.uidValidity > secondValidity, 'each recreation strictly increases');
  }
});

test('the double INBOX rename does not strand INBOX tombstones (both implementations)', () => {
  // Focused assertion on the exact residual: after two consecutive INBOX renames, a QRESYNC
  // client that synced INBOX before either rename must still be told its cached UIDs VANISHED.
  for (const cat of [new MemoryCatalog(1) as CatalogLike, SqliteCatalog.open(new DatabaseSync(':memory:'), 1)]) {
    const inbox = cat.get('INBOX')!;
    inbox.append(Buffer.from('a')); // uid 1
    inbox.append(Buffer.from('b')); // uid 2
    inbox.append(Buffer.from('c')); // uid 3
    const syncPoint = inbox.highestModseq; // the client's last-seen mod-sequence
    assert.equal(cat.rename('INBOX', 'A'), 'ok');
    assert.equal(cat.rename('INBOX', 'B'), 'ok'); // the second rename must not wipe INBOX's log
    const nowInbox = cat.get('INBOX')!;
    assert.deepEqual(nowInbox.expungedSince(syncPoint), [1, 2, 3], 'INBOX still reports the vanished UIDs after a second rename');
    assert.deepEqual(nowInbox.messages.length, 0, 'INBOX is empty');
  }
});
