/**
 * The snapshot, and the census that decides whether a migration was lossless.
 *
 * The first test here is the most important one in the updater. A verbatim copy of the control
 * database still names the LIVE mailbox files, because the path is stored per account — so a
 * candidate booted against it would open, migrate and write real mail while believing it was
 * running against a copy. The rewrite is what makes a copy a copy, and if it ever regresses this is
 * what says so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMailDb } from '../store/open-mail-db.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';
import { SqliteQueue } from '../store/sqlite-queue.ts';
import { takeSnapshot, censusOf, compareCensus, schemaMovedForward, redirectAccountsIntoSnapshot, type Census } from './snapshot.ts';

/** A control database with two accounts, mail in both, and something in the outbound queue. */
function makeLiveData(dir: string): { controlDb: string; mailDbs: string[] } {
  const controlDb = join(dir, 'control.db');
  const db = openMailDb(controlDb);
  const registry = AccountRegistry.open(db);
  const mailDbs: string[] = [];
  for (const login of ['alice', 'bob']) {
    const path = join(dir, `mail-${login}.db`);
    registry.upsert(login, `${login}-password`, path);
    mailDbs.push(path);
    const userDb = openMailDb(path);
    const catalog = SqliteCatalog.open(userDb, 1);
    for (const name of ['Sent', 'Trash']) catalog.create(name);
    const inbox = catalog.get('INBOX')!;
    inbox.append(Buffer.from(`Subject: to ${login}\r\n\r\nbody one\r\n`, 'latin1'), [], 1_700_000_000_000);
    inbox.append(Buffer.from(`Subject: also to ${login}\r\n\r\nbody two\r\n`, 'latin1'), ['\\Seen'], 1_700_000_001_000);
    userDb.close();
  }
  registry.addAlias('postmaster', 'alice');
  const queue = SqliteQueue.open(db);
  queue.enqueue('alice@one.example', ['someone@two.example'], Buffer.from('Subject: outbound\r\n\r\nhi\r\n', 'latin1'), 1_700_000_000_000);
  db.close();
  return { controlDb, mailDbs };
}

function inTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-snapshot-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

test('the snapshot redirects every account at its own copy, so a candidate cannot reach live mail', () => {
  inTmp((dir) => {
    const { controlDb, mailDbs } = makeLiveData(dir);
    const snapshot = takeSnapshot(controlDb, join(dir, 'snap'));
    try {
      const copy = new DatabaseSync(snapshot.controlDb, { readOnly: true });
      const rows = copy.prepare('SELECT login, mail_db_path FROM accounts ORDER BY login').all() as Array<{ login: string; mail_db_path: string }>;
      copy.close();
      // Rebuilt as plain objects: node:sqlite hands back null-prototype rows, which deepEqual
      // distinguishes from object literals even when every field matches.
      assert.deepEqual(
        rows.map((r) => ({ login: r.login, path: r.mail_db_path })),
        [
          { login: 'alice', path: join(snapshot.dir, 'mail-alice.db') },
          { login: 'bob', path: join(snapshot.dir, 'mail-bob.db') },
        ],
        'every path points inside the snapshot, not at the live files',
      );
      // The live paths appear NOWHERE in the copy: not as a leftover row, not as a default.
      for (const live of mailDbs) {
        const check = new DatabaseSync(snapshot.controlDb, { readOnly: true });
        const hit = check.prepare('SELECT COUNT(*) c FROM accounts WHERE mail_db_path = ?').get(live) as { c: number | bigint };
        check.close();
        assert.equal(Number(hit.c), 0, `${live} is not referenced by the snapshot`);
      }
    } finally {
      snapshot.destroy();
    }
  });
});

test('a control copy with any account still pointing outside is refused, not used', () => {
  // The assertion that guards the rewrite. Driven directly, on a database where the rewrite was
  // deliberately not performed, because with correct code above it this can never be reached — and
  // a guard that has never been shown to fire is not a guard.
  inTmp((dir) => {
    const { controlDb } = makeLiveData(dir);
    const snapDir = join(dir, 'snap-manual');
    mkdirSync(snapDir, { recursive: true, mode: 0o700 });
    const controlCopy = join(snapDir, 'control.db');
    copyFileSync(controlDb, controlCopy);

    assert.throws(
      () => redirectAccountsIntoSnapshot(controlCopy, snapDir, false),
      /2 account\(s\) in the snapshot still point at live mail databases.*alice ->.*bob ->/s,
    );
    // And with the rewrite it passes, which is what the assertion is there to confirm.
    assert.doesNotThrow(() => redirectAccountsIntoSnapshot(controlCopy, snapDir));
    assert.doesNotThrow(() => redirectAccountsIntoSnapshot(controlCopy, snapDir, false));
  });
});

test('the snapshot is private, self-contained, and destroyed on request', () => {
  inTmp((dir) => {
    const { controlDb } = makeLiveData(dir);
    const snapshot = takeSnapshot(controlDb, join(dir, 'snap'));
    // It holds SCRAM material, app passwords and raw mail: owner-only, like the live databases.
    assert.equal(statSync(snapshot.dir).mode & 0o777, 0o700);
    assert.equal(statSync(snapshot.controlDb).mode & 0o777, 0o600);
    assert.equal(snapshot.mailDbs.length, 2);
    assert.ok(snapshot.bytes > 0);
    snapshot.destroy();
    assert.throws(() => statSync(snapshot.dir));
  });
});

test('taking a snapshot does not touch the live databases', () => {
  inTmp((dir) => {
    const { controlDb, mailDbs } = makeLiveData(dir);
    const before = [controlDb, ...mailDbs].map(sha256);
    const snapshot = takeSnapshot(controlDb, join(dir, 'snap'));
    snapshot.destroy();
    assert.deepEqual([controlDb, ...mailDbs].map(sha256), before, 'every live file is byte-identical afterwards');
  });
});

test('a census records what must survive a migration', () => {
  inTmp((dir) => {
    const { controlDb } = makeLiveData(dir);
    const snapshot = takeSnapshot(controlDb, join(dir, 'snap'));
    try {
      const census = censusOf(snapshot);
      assert.deepEqual(census.accounts.map((a) => a.login), ['alice', 'bob']);
      assert.deepEqual(census.accounts[0]!.aliases, ['postmaster']);
      assert.equal(census.queueDepth, 1);
      assert.equal(census.deadLetters, 0);
      const inboxes = census.mailboxes.filter((m) => m.mailbox === 'INBOX');
      assert.deepEqual(inboxes.map((m) => m.messages), [2, 2]);
      assert.equal(census.digestIsFull, true, 'a small store is hashed whole, not sampled');
      assert.notEqual(census.messageDigest, '');
      // Taking a census twice must produce the same answer, or comparing two of them means nothing.
      assert.deepEqual(censusOf(snapshot), census);
    } finally {
      snapshot.destroy();
    }
  });
});

/** A census with the given fields overridden, for the comparison tests. */
function censusOfLive(dir: string, controlDb: string): { census: Census; destroy: () => void } {
  const snapshot = takeSnapshot(controlDb, join(dir, `snap-${Math.random().toString(36).slice(2)}`));
  return { census: censusOf(snapshot), destroy: () => snapshot.destroy() };
}

test('the comparison catches every way a migration can lose or alter data', () => {
  inTmp((dir) => {
    const { controlDb } = makeLiveData(dir);
    const base = censusOfLive(dir, controlDb);
    try {
      const before = base.census;
      assert.deepEqual(compareCensus(before, before), [], 'identical censuses produce no findings');

      const withOneMessageGone: Census = {
        ...before,
        mailboxes: before.mailboxes.map((m) => (m.mailbox === 'INBOX' && m.login === 'alice' ? { ...m, messages: m.messages - 1 } : m)),
      };
      assert.match(compareCensus(before, withOneMessageGone).join('\n'), /alice\/INBOX: 2 message\(s\) before, 1 after/);

      assert.match(
        compareCensus(before, { ...before, mailboxes: before.mailboxes.filter((m) => !(m.login === 'bob' && m.mailbox === 'Trash')) }).join('\n'),
        /mailbox bob\/Trash disappeared/,
      );
      assert.match(
        compareCensus(before, { ...before, accounts: before.accounts.filter((a) => a.login !== 'bob') }).join('\n'),
        /accounts changed/,
      );
      assert.match(compareCensus(before, { ...before, messageDigest: 'different' }).join('\n'), /stored message bytes changed/);
      assert.match(
        compareCensus(before, { ...before, mailboxes: before.mailboxes.map((m) => ({ ...m, uidValidity: m.uidValidity + 1 })) }).join('\n'),
        /UIDVALIDITY changed .* force every client to resynchronise/,
      );
      assert.match(
        compareCensus(before, { ...before, mailboxes: before.mailboxes.map((m) => ({ ...m, uidNext: 1 })) }).join('\n'),
        /uid_next went backwards/,
      );
      assert.match(compareCensus(before, { ...before, controlSchemaVersion: before.controlSchemaVersion - 1 }).join('\n'), /control schema BACKWARDS/);
      // The quietest catastrophe available: nothing is deleted, no message moves, the server comes
      // up healthy and every client is locked out permanently — and the passwords cannot be
      // recovered from what is stored. Note this is NOT covered by the mail-path rung, which
      // authenticates with a credential the pre-flight minted for itself moments earlier.
      assert.match(
        compareCensus(before, { ...before, credentialDigest: 'rewritten by a migration' }).join('\n'),
        /authentication material changed .* cannot be recovered/s,
      );
    } finally {
      base.destroy();
    }
  });
});

test('the credential digest tracks real authentication material, not just a field name', () => {
  inTmp((dir) => {
    const { controlDb } = makeLiveData(dir);
    const base = censusOfLive(dir, controlDb);
    const first = base.census.credentialDigest;
    base.destroy();
    assert.match(first, /^[0-9a-f]{64}$/, 'a hash over something, not a placeholder');

    // Re-censusing unchanged data must give the same digest, or every migration would look like
    // credential loss and the check would be ignored within a week.
    const again = censusOfLive(dir, controlDb);
    assert.equal(again.census.credentialDigest, first, 'stable across repeated censuses');
    again.destroy();

    // Changing a stored verifier changes it. This is the migration-rewrites-credentials case,
    // produced the only honest way: by actually rewriting one.
    const db = openMailDb(controlDb);
    try {
      db.prepare('UPDATE accounts SET stored_key = ? WHERE login = ?').run(Buffer.from('a different stored key'), 'alice');
    } finally {
      db.close();
    }
    const after = censusOfLive(dir, controlDb);
    assert.notEqual(after.census.credentialDigest, first, 'a rewritten verifier is visible');
    after.destroy();

    // And adding an app password changes it too: app passwords are credentials, and a migration
    // that dropped them would lock out every device that holds one while the primary still worked.
    const db2 = openMailDb(controlDb);
    try {
      AccountRegistry.open(db2).addAppPassword('alice', 'a-device', 1_700_000_000_000);
    } finally {
      db2.close();
    }
    const withApp = censusOfLive(dir, controlDb);
    assert.notEqual(withApp.census.credentialDigest, after.census.credentialDigest, 'app passwords are covered');
    withApp.destroy();
  });
});

test('any relay activity at all shows up, not only a drained queue', () => {
  inTmp((dir) => {
    const { controlDb } = makeLiveData(dir);
    const base = censusOfLive(dir, controlDb);
    try {
      const before = base.census;
      // A successful relay removes the row. This is the loud case.
      assert.match(compareCensus(before, { ...before, queueDepth: 0, queueDigest: 'x' }).join('\n'), /1 message\(s\) before, 0 after/);
      // A FAILED relay keeps the row and bumps its attempt count. The depth is unchanged, so only
      // the digest catches it — and this is the case a depth-only check would have missed.
      const findings = compareCensus(before, { ...before, queueDigest: 'attempts went up' });
      assert.equal(findings.length, 1);
      assert.match(findings[0]!, /delivery state differs/);
      assert.match(findings[0]!, /Hold mode should have made that impossible/);
    } finally {
      base.destroy();
    }
  });
});

test('a forward schema move is reported rather than flagged, because rollback needs to know', () => {
  inTmp((dir) => {
    const { controlDb } = makeLiveData(dir);
    const base = censusOfLive(dir, controlDb);
    try {
      const before = base.census;
      const after: Census = { ...before, controlSchemaVersion: before.controlSchemaVersion + 1 };
      assert.deepEqual(compareCensus(before, after), [], 'migrating forward is what a migration does');
      assert.equal(schemaMovedForward(before, after), true);
      assert.equal(schemaMovedForward(before, before), false);
      const mailMoved: Census = { ...before, mailSchemaVersions: { ...before.mailSchemaVersions, alice: before.mailSchemaVersions.alice! + 1 } };
      assert.equal(schemaMovedForward(before, mailMoved), true);
    } finally {
      base.destroy();
    }
  });
});

test('a control database that does not exist is refused before anything is created', () => {
  inTmp((dir) => {
    assert.throws(() => takeSnapshot(join(dir, 'nope.db'), join(dir, 'snap')), /does not exist/);
  });
});

test('a login the account CLI could never have created is refused before anything is copied', () => {
  // The daemon owns the control database. A login is therefore untrusted input by the time the
  // updater reads it back, and interpolating it into a path let a `..` sequence steer VACUUM INTO
  // into the version store — a write the daemon cannot perform itself, performed for it by the one
  // process that can. See snapshotPathFor's comment.
  inTmp((dir) => {
    const { controlDb } = makeLiveData(dir);
    const codeStore = join(dir, 'versions', 'deadbeef', 'src');
    mkdirSync(codeStore, { recursive: true });

    // A real mail database for the row to point at, so the copy would otherwise succeed.
    const source = join(dir, 'mail-alice.db');
    const db = new DatabaseSync(controlDb);
    db.prepare('UPDATE accounts SET login = ? WHERE login = ?').run('a/../../../versions/deadbeef/src/IMPLANT', 'bob');
    db.prepare('UPDATE accounts SET mail_db_path = ? WHERE login = ?').run(source, 'a/../../../versions/deadbeef/src/IMPLANT');
    db.close();

    const dest = join(dir, 'snap');
    assert.throws(() => takeSnapshot(controlDb, dest), /is not a valid login/);
    assert.deepEqual(readdirSync(codeStore), [], 'nothing was written into the code store');
    assert.equal(existsSync(dest), false, 'no partial snapshot was left behind');
  });
});

test('a snapshot that fails part-way leaves no copy of live mail on disk', () => {
  // takeSnapshot throws before the caller ever receives the handle whose destroy() would clean up,
  // so it has to clean up after itself or a half-written copy of every secret stays on disk.
  //
  // The failure has to land AFTER the directory is created, or this test passes for the wrong
  // reason: the login guard runs before any mkdir, so a bad login proves nothing about cleanup.
  // A file that exists but is not a database gets past every pre-write check and fails inside the
  // copy loop, with the control database already copied.
  inTmp((dir) => {
    const { controlDb } = makeLiveData(dir);
    const notADatabase = join(dir, 'mail-bob.db');
    rmSync(notADatabase, { force: true });
    writeFileSync(notADatabase, 'this is not a SQLite file');

    const dest = join(dir, 'snap');
    assert.throws(() => takeSnapshot(controlDb, dest));
    assert.equal(existsSync(dest), false, 'the partial snapshot directory was removed');
  });
});
