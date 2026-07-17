/**
 * The SQLite mailbox conformance corpus.
 *
 * Differential: one `exercise` sequence is run against BOTH the reference mailbox
 * (src/store/mailbox.ts, the specification) and the SQLite-backed implementation,
 * and their observable results must be identical — so persistence does not change
 * the semantics. The reference model's own corpus (mailbox.test.ts) already proves
 * these invariant checks have teeth via its defects; here the SQLite implementation
 * must satisfy them. Then two SQLite-only properties: survive a close/reopen, and
 * store bytes exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Mailbox, DELETED } from './mailbox.ts';
import { SqliteMailbox } from './sqlite-mailbox.ts';

const b = (s: string): Buffer => Buffer.from(s, 'latin1');

interface MailboxLike {
  readonly uidNext: number;
  readonly uidValidity: number;
  readonly highestModseq: number;
  readonly messages: ReadonlyArray<{ uid: number; flags: ReadonlySet<string>; raw: Buffer; modseq: number }>;
  append(raw: Buffer, flags?: readonly string[], internalDate?: number): number;
  expunge(uid: number): void;
  storeFlags(uid: number, mode: 'add' | 'remove' | 'replace', flags: readonly string[]): void;
  expungeDeleted(): readonly number[];
  expungedSince(modseq: number, restrictTo?: ReadonlySet<number>): number[];
  sequenceNumber(uid: number): number | null;
  invalidate(newValidity: number): boolean;
}

/** A fixed sequence of operations whose observable results characterise the mailbox. */
function exercise(mb: MailboxLike): unknown {
  const emptyModseq = mb.highestModseq; // nonzero even with no messages (RFC 7162)
  const uids = [mb.append(b('a')), mb.append(b('b')), mb.append(b('c'))];
  const modseqOfB = mb.messages.find((m) => m.uid === uids[1])?.modseq ?? 0;
  mb.expunge(uids[0]!);
  const afterExpunge = mb.append(b('d')); // must NOT reuse uids[0]
  const highestAfterAppends = mb.highestModseq;
  mb.storeFlags(uids[1]!, 'add', ['\\Seen']);
  const seenSet = mb.messages.find((m) => m.uid === uids[1])?.flags.has('\\Seen') ?? false;
  // A flag change assigns a new, higher mod-sequence to that message.
  const modseqOfBAfterStore = mb.messages.find((m) => m.uid === uids[1])?.modseq ?? 0;
  const seqOfLast = mb.sequenceNumber(afterExpunge);
  mb.storeFlags(uids[2]!, 'add', [DELETED]);
  const expunged = [...mb.expungeDeleted()];
  // QRESYNC expunge log: both uids[0] (single expunge) and uids[2] (expungeDeleted)
  // must be reported as vanished-since-0, ascending; a restrict set narrows it; and
  // nothing is vanished after the latest mod-sequence.
  const vanishedAll = [...mb.expungedSince(0)];
  const vanishedRestricted = [...mb.expungedSince(0, new Set([uids[2]!]))];
  const vanishedAboveLatest = mb.expungedSince(mb.highestModseq).length;
  const validityBefore = mb.uidValidity;
  // A UIDVALIDITY change wipes the expunge log — old UIDs are meaningless afterward.
  const invalidateOk = mb.invalidate(validityBefore + 1);
  const vanishedAfterInvalidate = mb.expungedSince(0).length;
  const invalidateRejected = !mb.invalidate(validityBefore); // now below current -> refused
  return {
    ascending: uids[0]! < uids[1]! && uids[1]! < uids[2]!,
    noReuse: afterExpunge > uids[2]!,
    seenSet,
    seqOfLast,
    expunged,
    invalidateOk,
    invalidateRejected,
    countAfterInvalidate: mb.messages.length,
    // CONDSTORE mod-sequence observables — identical numeric progression on both.
    emptyModseqNonzero: emptyModseq >= 1,
    modseqOfB,
    highestAfterAppends,
    modseqOfBAfterStore,
    storeBumpedModseq: modseqOfBAfterStore > modseqOfB,
    highestTracksLastChange: modseqOfBAfterStore <= highestAfterAppends + 2,
    highestAfterInvalidate: mb.highestModseq,
    // QRESYNC expunge-log observables — identical on both backends.
    vanishedAll,
    vanishedRestricted,
    vanishedAboveLatest,
    vanishedAfterInvalidate,
  };
}

test('the SQLite mailbox matches the reference mailbox, operation for operation', () => {
  const reference = exercise(new Mailbox(1));
  const db = new DatabaseSync(':memory:');
  const sqlite = exercise(SqliteMailbox.open(db, 1));
  db.close();
  assert.deepEqual(sqlite, reference, 'the persistent implementation reproduces the reference semantics');
});

test('the SQLite mailbox survives a close and reopen (persistence)', () => {
  const path = join(tmpdir(), `mailbox-${randomUUID()}.db`);
  try {
    const first = new DatabaseSync(path);
    const mb = SqliteMailbox.open(first, 7);
    const uid = mb.append(b('persist me'), ['\\Flagged'], 123);
    first.close();

    // Reopen the same file — the data and UID bookkeeping must still be there.
    const second = new DatabaseSync(path);
    const reopened = SqliteMailbox.open(second, 7);
    assert.equal(reopened.uidValidity, 7, 'UIDVALIDITY persisted');
    assert.equal(reopened.uidNext, uid + 1, 'UIDNEXT persisted (UID not reusable)');
    assert.equal(reopened.messages.length, 1);
    assert.equal(reopened.messages[0]!.raw.toString('latin1'), 'persist me');
    assert.ok(reopened.messages[0]!.flags.has('\\Flagged'), 'flags persisted');
    // The mod-sequence must survive a restart — that is the whole point of CONDSTORE
    // (a reconnecting client resyncs against a value the server still recognises).
    const modseqBefore = reopened.messages[0]!.modseq;
    assert.ok(modseqBefore >= 1 && reopened.highestModseq >= modseqBefore, 'HIGHESTMODSEQ persisted and is nonzero');
    reopened.storeFlags(uid, 'add', ['\\Seen']);
    assert.ok(reopened.messages[0]!.modseq > modseqBefore, 'a post-reopen flag change advances the mod-sequence, not resets it');
    // The QRESYNC expunge log must also survive a restart — a client reconnecting after
    // the server bounced must still learn which UIDs vanished while it was away.
    const uid2 = reopened.append(b('doomed'));
    reopened.expunge(uid2);
    assert.deepEqual(reopened.expungedSince(0), [uid2], 'the expunge is logged');
    second.close();
    const third = new DatabaseSync(path);
    const again = SqliteMailbox.open(third, 7);
    assert.deepEqual(again.expungedSince(0), [uid2], 'the expunge log survived the reopen');
    third.close();
  } finally {
    rmSync(path, { force: true });
  }
});

test('the SQLite mailbox stores message bytes exactly (including 8-bit and NUL)', () => {
  const db = new DatabaseSync(':memory:');
  const mb = SqliteMailbox.open(db);
  const raw = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x41]); // NUL, 0xFF, CRLF, 0x80, 'A'
  const uid = mb.append(raw);
  assert.deepEqual(mb.messages[0]!.raw, raw, 'bytes round-trip through SQLite unchanged');
  assert.equal(mb.sequenceNumber(uid), 1);
  db.close();
});
