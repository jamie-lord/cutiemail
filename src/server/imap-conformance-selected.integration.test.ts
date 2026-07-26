/**
 * RFC 9051 wire conformance: the selected-state commands — FETCH, STORE, COPY, MOVE, UID.
 *
 * This is where mail actually moves between mailboxes, and where the RFC stops describing
 * behaviour and starts stating safety properties: §6.4.8's "no message can be lost or orphaned" is
 * an invariant, not a sequence of steps. An invariant like that can only be checked from outside
 * the implementation, by counting what is really there before and after — which is what these
 * cases do, including for operations that FAIL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imapRequirement, type ImapRequirementId } from '../register/imap/index.ts';
import { withImapServer } from '../testing/imap-fixture.ts';
import { untaggedOf, hasResponseCodePrefix, type ImapClient } from '../testing/imap-client.ts';

const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);

/** How many messages a mailbox holds, asked over the wire rather than read from the store. */
async function messageCount(c: ImapClient, mailbox: string): Promise<number> {
  const status = await c.command(`STATUS ${mailbox} (MESSAGES)`);
  assert.equal(status.status, 'OK', status.line);
  const m = /MESSAGES (\d+)/.exec(untaggedOf(status, 'STATUS')[0] ?? '');
  assert.ok(m !== null, `a MESSAGES count: ${status.untagged.join(' | ')}`);
  return Number(m[1]);
}

test('the static data items of a message never change', async () => {
  cites('R-9051-6.4.5-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();
    await c.command('SELECT INBOX');

    const items = '(ENVELOPE INTERNALDATE RFC822.SIZE BODYSTRUCTURE)';
    const first = await c.command(`FETCH 1 ${items}`);
    assert.equal(first.status, 'OK', first.line);

    // A flag change between the two fetches: mutable state moving is exactly what would tempt an
    // implementation into rebuilding a "static" answer differently the second time.
    await c.command('STORE 1 +FLAGS (\\Flagged)');
    const second = await c.command(`FETCH 1 ${items}`);

    const strip = (r: typeof first): string => untaggedOf(r, 'FETCH').join('\n').replace(/^\* \d+ FETCH /, '');
    assert.equal(strip(second), strip(first), 'the msg-att-static items are byte-identical across fetches');
  });
});

test('fetching a body marks the message seen and says so in the same response', async () => {
  cites('R-9051-6.4.5-b');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();
    await c.command('SELECT INBOX');

    // BODY[] rather than BODY.PEEK[]: the implicit \Seen is the whole point.
    const fetched = await c.command('FETCH 1 (BODY[])');
    assert.equal(fetched.status, 'OK', fetched.line);
    const text = fetched.untagged.join('\n');
    assert.match(text, /\\Seen/, `the flag change caused by the fetch is reported with it: ${text}`);

    // And it is a real change, not just an announcement.
    const flags = await c.command('FETCH 1 (FLAGS)');
    assert.match(flags.untagged.join('\n'), /\\Seen/);
  });
});

test('BODY.PEEK does not mark the message seen', async () => {
  cites('R-9051-6.4.5-b');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();
    await c.command('SELECT INBOX');
    // The negative control for the case above: PEEK exists precisely so a client can read a message
    // without changing it, and a server that sets \Seen anyway silently marks mail read as the user
    // scrolls past it.
    await c.command('FETCH 1 (BODY.PEEK[])');
    const flags = await c.command('FETCH 1 (FLAGS)');
    assert.doesNotMatch(flags.untagged.join('\n'), /\\Seen/, 'PEEK leaves the message unread');
  });
});

test('STORE .SILENT suppresses the untagged FETCH but still applies the change', async () => {
  cites('R-9051-6.4.6-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();
    await c.command('SELECT INBOX');

    const silent = await c.command('STORE 1 +FLAGS.SILENT (\\Flagged)');
    assert.equal(silent.status, 'OK', silent.line);
    assert.deepEqual(untaggedOf(silent, 'FETCH'), [], 'no untagged FETCH for the requesting connection');

    // The half a naive implementation gets wrong: .SILENT means "do not tell me", not "do nothing".
    const flags = await c.command('FETCH 1 (FLAGS)');
    assert.match(flags.untagged.join('\n'), /\\Flagged/, 'the flag really was set');

    // And without .SILENT the untagged FETCH does arrive, so the suppression is what is being seen.
    const loud = await c.command('STORE 1 +FLAGS (\\Answered)');
    assert.equal(untaggedOf(loud, 'FETCH').length, 1, `a plain STORE reports the new flags: ${loud.untagged.join(' | ')}`);
  });
});

test('COPY preserves the flags and internal date of every message', async () => {
  cites('R-9051-6.4.7-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();
    await c.command('CREATE Filed');
    await c.command('SELECT INBOX');
    await c.command('STORE 1 +FLAGS (\\Flagged \\Seen)');

    const before = await c.command('FETCH 1 (INTERNALDATE)');
    const date = /INTERNALDATE ("[^"]+")/.exec(before.untagged.join('\n'))?.[1];
    assert.ok(date !== undefined, `an INTERNALDATE to compare: ${before.untagged.join(' | ')}`);

    assert.equal((await c.command('COPY 1 Filed')).status, 'OK');
    await c.command('SELECT Filed');
    const after = await c.command('FETCH 1 (FLAGS INTERNALDATE)');
    const text = after.untagged.join('\n');
    // A copy that loses INTERNALDATE re-sorts the destination by arrival time; one that loses the
    // flags comes back unread.
    assert.ok(text.includes(date), `the internal date survives the copy: ${text}`);
    assert.match(text, /\\Flagged/, text);
    assert.match(text, /\\Seen/, text);
  });
});

test('COPY to a mailbox that does not exist is refused, and does not create it', async () => {
  cites('R-9051-6.4.7-b');
  cites('R-9051-6.4.7-c');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();
    await c.command('SELECT INBOX');

    const reply = await c.command('COPY 1 "not-a-mailbox"');
    assert.equal(reply.status, 'NO', `a missing destination is an error: ${reply.line}`);
    const listed = await c.command('LIST "" *');
    assert.ok(!listed.untagged.some((l) => l.includes('not-a-mailbox')), `and it was not created: ${listed.untagged.join(' | ')}`);
    assert.ok(hasResponseCodePrefix(reply.line, 'TRYCREATE'), `with [TRYCREATE] as the prefix: ${reply.line}`);
  });
});

test('a COPY that cannot complete copies nothing at all', async () => {
  cites('R-9051-6.4.7-d');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 2);
    const c = await fx.session();
    await c.command('CREATE Filed');
    await c.command('SELECT INBOX');

    // A set spanning a real and a nonexistent UID. "Partial copy MUST NOT be done": either both
    // arrive or neither does, and since one cannot, neither may.
    const reply = await c.command('UID COPY 1,999 Filed');
    if (reply.status === 'OK') {
      // A server may legitimately treat the missing UID as vacuous and copy the one that exists.
      // What it may not do is copy some of an explicitly-enumerated set and report failure.
      assert.equal(await messageCount(c, 'Filed'), 1, 'a successful partial-set copy moved the messages that exist');
    } else {
      assert.equal(await messageCount(c, 'Filed'), 0, `a failed COPY leaves the destination untouched: ${reply.line}`);
    }
  });
});

test('MOVE leaves every message in exactly one of the two mailboxes', async () => {
  cites('R-9051-6.4.8-b');
  cites('R-9051-6.4.8-c');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 4);
    const c = await fx.session();
    await c.command('CREATE Filed');
    await c.command('SELECT INBOX');

    const before = (await messageCount(c, 'INBOX')) + (await messageCount(c, 'Filed'));
    await c.command('SELECT INBOX');
    const moved = await c.command('MOVE 2:3 Filed');
    assert.equal(moved.status, 'OK', moved.line);

    const inbox = await messageCount(c, 'INBOX');
    const filed = await messageCount(c, 'Filed');
    // The safety property, stated as the RFC states it: nothing lost, nothing orphaned.
    assert.equal(inbox + filed, before, `no message was lost: ${inbox} + ${filed} vs ${before}`);
    assert.equal(filed, 2, 'the named messages arrived');
    assert.equal(inbox, 2, 'and left');
  });
});

test('MOVE does not leak the \\Deleted flag or STORE responses', async () => {
  cites('R-9051-6.4.8-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 3);
    const mover = await fx.session();
    const watcher = await fx.session();
    await mover.command('CREATE Filed');
    await mover.command('SELECT INBOX');
    await watcher.command('SELECT INBOX');
    await watcher.unsolicited();

    const moved = await mover.command('MOVE 1 Filed');
    assert.equal(moved.status, 'OK', moved.line);

    // MOVE is specified as COPY + STORE \Deleted + EXPUNGE, and an implementation written literally
    // that way leaks the flag to anyone else watching the mailbox. A second connection is the only
    // place that is visible.
    const seen = await watcher.unsolicited();
    assert.ok(!seen.some((l) => /FETCH .*\\Deleted/.test(l)), `no \\Deleted leaked to another session: ${seen.join(' | ')}`);
    // And the messages that remain must not be flagged either.
    const remaining = await mover.command('FETCH 1:* (FLAGS)');
    assert.ok(!/\\Deleted/.test(remaining.untagged.join('\n')), `no message was left \\Deleted: ${remaining.untagged.join(' | ')}`);
  });
});

test('MOVE reports COPYUID before it reports the expunges', async () => {
  cites('R-9051-6.4.8-d');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 2);
    const c = await fx.session();
    await c.command('CREATE Filed');
    await c.command('SELECT INBOX');

    const moved = await c.command('MOVE 1 Filed');
    assert.equal(moved.status, 'OK', moved.line);
    const copyuid = moved.untagged.findIndex((l) => /^\* OK \[COPYUID /.test(l));
    const expunge = moved.untagged.findIndex((l) => /EXPUNGE\b/.test(l));
    assert.ok(copyuid !== -1, `an untagged OK [COPYUID]: ${moved.untagged.join(' | ')}`);
    assert.ok(expunge !== -1, `and expunge notifications: ${moved.untagged.join(' | ')}`);
    // Ordering is the requirement. After the EXPUNGE the client has already been told the source
    // messages are gone and has nothing left to correlate the new UIDs against.
    assert.ok(copyuid < expunge, `COPYUID must come first: ${moved.untagged.join(' | ')}`);
  });
});

test('MOVE to a mailbox that does not exist is refused, and does not create it', async () => {
  cites('R-9051-6.4.7-b');
  cites('R-9051-6.4.7-c');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();
    await c.command('SELECT INBOX');

    const reply = await c.command('MOVE 1 "still-not-a-mailbox"');
    assert.equal(reply.status, 'NO', `a missing destination is an error: ${reply.line}`);
    const listed = await c.command('LIST "" *');
    assert.ok(!listed.untagged.some((l) => l.includes('still-not-a-mailbox')), `and was not created: ${listed.untagged.join(' | ')}`);
    // The message must still be where it started: a refused MOVE that expunged the source would be
    // the exact loss §6.4.8 forbids.
    assert.equal(await messageCount(c, 'INBOX'), 1, 'and the message was not lost');
    assert.ok(hasResponseCodePrefix(reply.line, 'TRYCREATE'), `with [TRYCREATE] as the prefix: ${reply.line}`);
  });
});

test('a UID FETCH always reports the UID, asked for or not', async () => {
  cites('R-9051-6.4.9-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 2);
    const c = await fx.session();
    await c.command('SELECT INBOX');

    // FLAGS only. The UID must appear anyway: the untagged FETCH is keyed by sequence number, which
    // is precisely what a client using UIDs is trying not to depend on.
    const fetched = await c.command('UID FETCH 1:* (FLAGS)');
    assert.equal(fetched.status, 'OK', fetched.line);
    const lines = untaggedOf(fetched, 'FETCH');
    assert.equal(lines.length, 2, `one response per message: ${fetched.untagged.join(' | ')}`);
    for (const line of lines) assert.match(line, /\bUID \d+/, `the UID is included implicitly: ${line}`);
  });
});

test('a plain FETCH does not volunteer a UID it was not asked for', async () => {
  cites('R-9051-6.4.9-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();
    await c.command('SELECT INBOX');
    // The negative control that makes the case above mean something: the implicit UID is a property
    // of UID commands specifically, so a server that always includes it would pass that test while
    // proving nothing.
    const fetched = await c.command('FETCH 1 (FLAGS)');
    assert.doesNotMatch(untaggedOf(fetched, 'FETCH')[0]!, /\bUID \d+/, 'a sequence-number FETCH answers what was asked');
  });
});
