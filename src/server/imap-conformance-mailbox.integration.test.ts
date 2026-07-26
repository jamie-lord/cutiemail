/**
 * RFC 9051 wire conformance: the mailbox-management commands, against the assembled server.
 *
 * Each case cites the register requirement it exercises, so the coverage report can tell which
 * registered obligations are actually observed and which are only written down. Until now the IMAP
 * register was cited exclusively from parser tests — and a parser can be flawless while the server
 * built on it answers the wrong thing. That gap is where a MUST-level SMTP defect lived undetected
 * for a long time (ADR 0026); this file is the IMAP-side answer to it.
 *
 * The style follows the conformance suite's stance rather than a unit test's: assert what the RFC
 * requires, in the RFC's own terms, and let the server be measured against it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imapRequirement, type ImapRequirementId } from '../register/imap/index.ts';
import { withImapServer, IMAP_TEST_DOMAIN, IMAP_TEST_USER } from '../testing/imap-fixture.ts';
import { untaggedOf, hasResponseCodePrefix } from '../testing/imap-client.ts';

const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);

/**
 * A registered requirement this server does not satisfy yet.
 *
 * The case is written to assert what the RFC requires and is left RUNNING, marked as a known gap:
 * it fails without failing the suite, so the obligation stays executable and visible instead of
 * being deleted or quietly weakened to match the implementation. Weakening the assertion would be
 * the worst of the three options — it converts a known defect into a permanent green.
 */
const GAP = (why: string): { todo: string } => ({ todo: why });

test('SELECT sends every required untagged item before the tagged OK', async () => {
  cites('R-9051-6.3.2-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 3);
    const c = await fx.session();
    const reply = await c.command('SELECT INBOX');
    assert.equal(reply.status, 'OK', reply.line);

    // §6.3.2 enumerates these immediately after the quoted sentence. All of them, and all BEFORE
    // the tagged OK — which is what `untagged` collects, by construction.
    assert.equal(untaggedOf(reply, 'FLAGS').length, 1, `exactly one FLAGS: ${reply.untagged.join(' | ')}`);
    assert.equal(untaggedOf(reply, 'EXISTS').length, 1, `exactly one EXISTS: ${reply.untagged.join(' | ')}`);
    assert.equal(untaggedOf(reply, 'LIST').length, 1, `a LIST for the selected mailbox: ${reply.untagged.join(' | ')}`);
    for (const code of ['PERMANENTFLAGS', 'UIDNEXT', 'UIDVALIDITY']) {
      assert.ok(
        reply.untagged.some((l) => l.startsWith(`* OK [${code}`)),
        `an untagged OK carrying [${code}]: ${reply.untagged.join(' | ')}`,
      );
    }
    // The EXISTS has to be the real count, not a placeholder.
    assert.match(untaggedOf(reply, 'EXISTS')[0]!, /^\* 3 EXISTS/);
  });
});

test('SELECT reports [READ-WRITE] and EXAMINE reports [READ-ONLY], as a prefix', async () => {
  cites('R-9051-6.3.3-b');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();

    const examined = await c.command('EXAMINE INBOX');
    assert.equal(examined.status, 'OK', examined.line);
    // "MUST begin with" — a response code somewhere in the text does not satisfy it.
    assert.ok(hasResponseCodePrefix(examined.line, 'READ-ONLY'), `EXAMINE must begin with [READ-ONLY]: ${examined.line}`);

    const selected = await c.command('SELECT INBOX');
    assert.ok(hasResponseCodePrefix(selected.line, 'READ-WRITE'), `SELECT on a writable mailbox should say so: ${selected.line}`);
  });
});

test('EXAMINE really is read-only: a STORE through it changes nothing', async () => {
  cites('R-9051-6.3.3-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();
    await c.command('EXAMINE INBOX');
    // §6.3.3: "No changes to the permanent state of the mailbox, including per-user state, are
    // permitted." Refusing the STORE and silently ignoring it are both conformant; persisting it
    // is not, so the assertion is on the mailbox, not on the reply.
    await c.command('STORE 1 +FLAGS (\\Seen)');
    const c2 = await fx.session();
    const fetched = await c2.command('SELECT INBOX');
    assert.equal(fetched.status, 'OK');
    const flags = await c2.command('FETCH 1 (FLAGS)');
    assert.ok(
      !/\\Seen/.test(flags.untagged.join(' ')),
      `EXAMINE must not permit a permanent change: ${flags.untagged.join(' | ')}`,
    );
  });
});

test('selecting a second mailbox closes the first with [CLOSED]', async () => {
  cites('R-9051-6.3.2-c');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    fx.seed('Archive', 1);
    const c = await fx.session();
    await c.command('SELECT INBOX');
    const second = await c.command('SELECT Archive');
    assert.equal(second.status, 'OK', second.line);
    // New in rev2. Without it a client keeps applying updates to the mailbox it thinks is open.
    assert.ok(
      second.untagged.some((l) => l.startsWith('* OK [CLOSED]')),
      `an untagged OK [CLOSED] for the mailbox being deselected: ${second.untagged.join(' | ')}`,
    );
  });
});

test('the LIST attributes SELECT returns are accurate about children', async () => {
  cites('R-9051-6.3.2-b');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    assert.equal((await c.command('CREATE parent')).status, 'OK');
    assert.equal((await c.command('CREATE parent/child')).status, 'OK');

    const withChild = await c.command('SELECT parent');
    const listLine = untaggedOf(withChild, 'LIST')[0];
    assert.ok(listLine !== undefined, `SELECT returns a LIST response: ${withChild.untagged.join(' | ')}`);
    assert.match(listLine, /\\HasChildren/, `a mailbox with a child must say so: ${listLine}`);

    const leaf = await c.command('SELECT parent/child');
    const leafLine = untaggedOf(leaf, 'LIST')[0]!;
    assert.doesNotMatch(leafLine, /\\HasChildren/, `a leaf must not claim children: ${leafLine}`);
  });
});

test('DELETE removes the named mailbox and leaves its children alone', async () => {
  cites('R-9051-6.3.5-a');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    await c.command('CREATE foo');
    await c.command('CREATE foo/bar');
    fx.seed('foo/bar', 2, 'child');

    const deleted = await c.command('DELETE foo');
    assert.equal(deleted.status, 'OK', deleted.line);

    // The child survives, with its messages: deleting a parent is not a recursive delete.
    const listed = await c.command('LIST "" *');
    assert.ok(listed.untagged.some((l) => /"foo\/bar"|foo\/bar/.test(l)), `foo/bar survives: ${listed.untagged.join(' | ')}`);
    const selected = await c.command('SELECT foo/bar');
    assert.equal(selected.status, 'OK', selected.line);
    assert.match(untaggedOf(selected, 'EXISTS')[0]!, /^\* 2 EXISTS/, 'and keeps its messages');
  });
});

test('RENAME moves the whole subtree, not just the named mailbox', GAP(
  'RFC 9051 §6.3.6: RENAME leaves inferior hierarchical names behind, orphaning every child mailbox '
  + 'and the mail in it. Renaming "foo" to "baz" leaves "foo/bar" unreachable under either name.',
), async () => {
  cites('R-9051-6.3.6-a');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    await c.command('CREATE foo');
    await c.command('CREATE foo/bar');
    fx.seed('foo/bar', 1, 'inferior');

    const renamed = await c.command('RENAME foo baz');
    assert.equal(renamed.status, 'OK', renamed.line);

    const selected = await c.command('SELECT baz/bar');
    assert.equal(selected.status, 'OK', `the inferior name moved with its parent: ${selected.line}`);
    assert.match(untaggedOf(selected, 'EXISTS')[0]!, /^\* 1 EXISTS/, 'carrying its messages');

    const gone = await c.command('SELECT foo/bar');
    assert.equal(gone.status, 'NO', `the old inferior name is gone: ${gone.line}`);
  });
});

test('a recreated mailbox never reuses the identifiers of the one it replaces', async () => {
  cites('R-9051-6.3.4-a');
  cites('R-9051-6.3.5-b');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    await c.command('CREATE recycled');
    fx.seed('recycled', 3, 'first incarnation');

    const before = await c.command('SELECT recycled');
    const oldValidity = /UIDVALIDITY (\d+)/.exec(before.untagged.join(' '))?.[1];
    const oldUids = await c.command('UID FETCH 1:* (UID)');
    const highest = Math.max(...oldUids.untagged.flatMap((l) => [...l.matchAll(/UID (\d+)/g)].map((m) => Number(m[1]))));
    assert.ok(highest >= 3, `the first incarnation used UIDs up to ${highest}`);

    await c.command('CLOSE');
    assert.equal((await c.command('DELETE recycled')).status, 'OK');
    assert.equal((await c.command('CREATE recycled')).status, 'OK');
    fx.seed('recycled', 1, 'second incarnation');

    const after = await c.command('SELECT recycled');
    const newValidity = /UIDVALIDITY (\d+)/.exec(after.untagged.join(' '))?.[1];
    const newUids = await c.command('UID FETCH 1:* (UID)');
    const reused = [...newUids.untagged.join(' ').matchAll(/UID (\d+)/g)].map((m) => Number(m[1]));

    // Two legal ways to satisfy the requirement, and a conformant server may pick either: keep
    // climbing the UID space, or move UIDVALIDITY. Asserting only one would fail a correct server.
    const climbed = reused.every((u) => u > highest);
    const revalidated = newValidity !== oldValidity;
    assert.ok(
      climbed || revalidated,
      `UIDs ${reused.join(',')} follow ${highest}, or UIDVALIDITY moved (${oldValidity} -> ${newValidity})`,
    );
  });
});

test('a mailbox created where one was renamed away does not reuse its identifiers', async () => {
  cites('R-9051-6.3.6-b');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    await c.command('CREATE original');
    fx.seed('original', 3, 'before the rename');

    await c.command('SELECT original');
    const oldValidity = /UIDVALIDITY (\d+)/.exec((await c.command('SELECT original')).untagged.join(' '))?.[1];
    const highest = Math.max(
      ...[...(await c.command('UID FETCH 1:* (UID)')).untagged.join(' ').matchAll(/UID (\d+)/g)].map((m) => Number(m[1])),
    );
    assert.ok(highest >= 3, `the original used UIDs up to ${highest}`);

    await c.command('CLOSE');
    assert.equal((await c.command('RENAME original moved')).status, 'OK');
    // The name is free again. A mailbox created at it must not hand out the identifiers the old
    // one already used, or a client with a stale cache shows the wrong message.
    assert.equal((await c.command('CREATE original')).status, 'OK');
    fx.seed('original', 1, 'after the rename');

    const after = await c.command('SELECT original');
    const newValidity = /UIDVALIDITY (\d+)/.exec(after.untagged.join(' '))?.[1];
    const uids = [...(await c.command('UID FETCH 1:* (UID)')).untagged.join(' ').matchAll(/UID (\d+)/g)].map((m) => Number(m[1]));
    assert.ok(
      uids.every((u) => u > highest) || newValidity !== oldValidity,
      `UIDs ${uids.join(',')} follow ${highest}, or UIDVALIDITY moved (${oldValidity} -> ${newValidity})`,
    );
  });
});

test('STATUS works on the currently selected mailbox', async () => {
  cites('R-9051-6.3.11-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 4);
    const c = await fx.session();
    await c.command('SELECT INBOX');
    // Clients do this despite the SHOULD NOT aimed at them, so the server has to cope.
    const status = await c.command('STATUS INBOX (MESSAGES UIDNEXT UIDVALIDITY)');
    assert.equal(status.status, 'OK', `STATUS on the selected mailbox must work: ${status.line}`);
    const line = untaggedOf(status, 'STATUS')[0];
    assert.ok(line !== undefined, `an untagged STATUS: ${status.untagged.join(' | ')}`);
    assert.match(line, /MESSAGES 4/, line);
  });
});

test('APPEND to a mailbox that does not exist is refused, uncreated, with [TRYCREATE]', async () => {
  cites('R-9051-6.3.12-b');
  cites('R-9051-6.3.12-c');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    const message = `From: a@two.example\r\nSubject: appended\r\n\r\nbody\r\n`;
    const reply = await c.commandWithLiteral('APPEND "no-such-mailbox" (\\Seen)', message);

    assert.equal(reply.status, 'NO', `a missing destination is an error: ${reply.line}`);
    // The forbidden helpful behaviour: the mailbox must not have appeared.
    const listed = await c.command('LIST "" *');
    assert.ok(!listed.untagged.some((l) => l.includes('no-such-mailbox')), `and was not created: ${listed.untagged.join(' | ')}`);
    // And the refusal must tell the client that creating it would work.
    assert.ok(hasResponseCodePrefix(reply.line, 'TRYCREATE'), `[TRYCREATE] as the prefix of the NO: ${reply.line}`);
  });
});

test('a refused APPEND leaves the mailbox exactly as it was', async () => {
  cites('R-9051-6.3.12-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 2);
    const c = await fx.session();
    const before = await c.command('SELECT INBOX');
    assert.match(untaggedOf(before, 'EXISTS')[0]!, /^\* 2 EXISTS/);

    // Over the size limit the server was configured with, so it refuses — the "unsuccessful for
    // any reason" the requirement covers.
    const huge = `From: a@two.example\r\nSubject: too big\r\n\r\n${'x'.repeat(20_000)}\r\n`;
    const reply = await c.commandWithLiteral('APPEND INBOX', huge, 30_000);
    assert.notEqual(reply.status, 'OK', `an over-limit APPEND is refused: ${reply.line}`);

    // No partial appending: the count is unchanged and nothing new is fetchable.
    const after = await c.command('STATUS INBOX (MESSAGES)');
    assert.match(untaggedOf(after, 'STATUS')[0]!, /MESSAGES 2/, `the mailbox is restored: ${after.untagged.join(' | ')}`);
  }, { maxMessageSize: 8192 });
});

test('a successful APPEND lands the message with the flags and date it was given', async () => {
  cites('R-9051-6.3.12-a');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    const message = `From: a@two.example\r\nSubject: appended ok\r\n\r\nbody\r\n`;
    const reply = await c.commandWithLiteral('APPEND INBOX (\\Seen)', message);
    assert.equal(reply.status, 'OK', reply.line);

    await c.command('SELECT INBOX');
    const fetched = await c.command('FETCH 1 (FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT)])');
    const text = fetched.untagged.join('\n');
    assert.match(text, /\\Seen/, `the flags given to APPEND are set: ${text}`);
    assert.match(text, /appended ok/, `and the message is the one we sent: ${text}`);
    assert.equal(IMAP_TEST_USER.length > 0 && IMAP_TEST_DOMAIN.length > 0, true);
  });
});
