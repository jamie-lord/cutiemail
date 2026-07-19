/**
 * Test-only: materialise every message in a mailbox (metadata + body) through the
 * ServableMailbox interface.
 *
 * This is the convenience the old `ServableMailbox.messages` getter gave — a whole-mailbox
 * array with each message's raw bytes — now made EXPLICIT and confined to tests. Production
 * never loads a whole mailbox: it drives `index()` (metadata, no BLOBs) and fetches a single
 * body with `raw(uid)` only when a command needs one (docs/PERFORMANCE.md). Tests that assert
 * on delivered content legitimately want the whole thing, so they say so here.
 *
 * Returns the same StoredMessage shape the getter did, so it is a drop-in for `.messages`.
 */

import type { ServableMailbox } from '../server/imap-server.ts';
import type { StoredMessage } from '../store/mailbox.ts';

export function readMessages(box: ServableMailbox): StoredMessage[] {
  return box.index().map((m) => ({
    uid: m.uid,
    flags: m.flags,
    internalDate: m.internalDate,
    modseq: m.modseq,
    raw: box.raw(m.uid) ?? Buffer.alloc(0),
  }));
}
