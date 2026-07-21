/**
 * `mail list/show` — the read-only mailbox view (UX pressure test: the only way to answer
 * "did it arrive, what was the subject" was a full IMAP client). The claims here are the
 * CLI's own: listing shows the acting fields (uid/date/size/flags/from/subject), show is
 * headers-only unless --raw, --raw is byte-exact and refuses a TTY, reading NEVER mutates
 * flags, and a typo'd path/login/uid is a clean error — never a silently-created database.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMail } from './mail-cli.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';

interface Cap {
  readonly out: string[];
  readonly err: string[];
  readonly io: { out(l: string): void; err(l: string): void };
}
function capture(): Cap {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l) => void out.push(l), err: (l) => void err.push(l) } };
}

const MESSAGE = Buffer.from(
  'From: Sender <sender@example.net>\r\nTo: alice@here.example\r\nSubject: the quarterly\r\n numbers\r\n\r\nbody bytes \x00\xff here',
  'latin1',
);

function makeWorld(dir: string): { dbPath: string; mailDbPath: string; uid: number } {
  const dbPath = join(dir, 'control.db');
  const mailDbPath = join(dir, 'mail-alice.db');
  const control = openMailDb(dbPath);
  AccountRegistry.open(control).upsert('alice', 'pw', mailDbPath, { iterations: 1 });
  control.close();
  const mdb = openMailDb(mailDbPath);
  const catalog = SqliteCatalog.open(mdb);
  const uid = catalog.get('INBOX')!.append(MESSAGE, ['\\Flagged'], Date.UTC(2026, 6, 21, 12, 0, 0));
  catalog.create('Junk');
  catalog.get('Junk')!.append(Buffer.from('Subject: spam\r\n\r\nx', 'latin1'), [], Date.UTC(2026, 6, 21));
  mdb.close();
  return { dbPath, mailDbPath, uid };
}

test('mail list shows uid/date/size/flags/from/subject, unfolds headers, and names other mailboxes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-cli-'));
  try {
    const { dbPath } = makeWorld(dir);
    const c = capture();
    assert.equal(runMail(['list', 'alice', '--db', dbPath], c.io, {}), 0);
    const text = c.out.join('\n');
    assert.match(text, /2026-07-21T12:00:00Z/, 'the INTERNALDATE is shown');
    assert.match(text, /\\Flagged/, 'flags are shown');
    assert.match(text, /sender@example\.net/, 'From is shown');
    assert.match(text, /the quarterly numbers/, 'a folded Subject is unfolded');
    assert.match(text, /INBOX of alice: 1 message\(s\)/);
    assert.match(text, /other mailboxes with mail: Junk \(1\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mail show prints headers only; --raw is byte-exact to a file sink and refuses a TTY; flags never change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-cli-'));
  try {
    const { dbPath, mailDbPath, uid } = makeWorld(dir);
    const c = capture();
    assert.equal(runMail(['show', 'alice', String(uid), '--db', dbPath], c.io, {}), 0);
    const text = c.out.join('\n');
    assert.match(text, /Subject: the quarterly/);
    assert.doesNotMatch(text, /body bytes/, 'the body is not dumped without --raw');

    const chunks: Buffer[] = [];
    const rawCap = capture();
    assert.equal(runMail(['show', 'alice', String(uid), '--db', dbPath, '--raw'], rawCap.io, {}, (b) => void chunks.push(b), false), 0);
    assert.ok(Buffer.concat(chunks).equals(MESSAGE), '--raw is byte-exact');

    const tty = capture();
    assert.equal(runMail(['show', 'alice', String(uid), '--db', dbPath, '--raw'], tty.io, {}, () => {}, true), 2, '--raw to a TTY is refused');

    // Reading is read-only: the \Seen flag was never added by list/show.
    const mdb = openMailDb(mailDbPath);
    const flags = [...SqliteCatalog.open(mdb).get('INBOX')!.index()[0]!.flags];
    mdb.close();
    assert.deepEqual(flags, ['\\Flagged'], 'no flag was mutated by reading');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clean errors: unknown login names the db, unknown uid points at list, a typo path creates NOTHING', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-cli-'));
  try {
    const { dbPath } = makeWorld(dir);
    const noAcct = capture();
    assert.equal(runMail(['list', 'bob', '--db', dbPath], noAcct.io, {}), 1);
    assert.match(noAcct.err.join('\n'), /no account "bob" in /);

    const noUid = capture();
    assert.equal(runMail(['show', 'alice', '999', '--db', dbPath], noUid.io, {}), 1);
    assert.match(noUid.err.join('\n'), /no message with uid 999/);

    const typoPath = join(dir, 'nope', 'control.db');
    const typo = capture();
    assert.equal(runMail(['list', 'alice', '--db', typoPath], typo.io, {}), 2);
    assert.match(typo.err.join('\n'), /does not exist/);
    assert.equal(existsSync(typoPath), false, 'nothing was created at the typo path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
