/**
 * The verification ladder, run for real: this repository as the candidate, a live control database
 * with mail and a queued message as the data, and actual child daemons on loopback ports.
 *
 * The point of this test is not that the ladder passes. It is that running the ladder CANNOT BREAK
 * THE INSTANCE — the single property the whole design rests on. So the assertions that matter most
 * are the ones taken after it finishes:
 *
 *   - every live database file is byte-identical to what it was before, so the candidate never
 *     opened, migrated or wrote real data;
 *   - the queued outbound message is still queued, with its attempt count untouched, so no relay
 *     tick ran against real mail.
 *
 * Rung 4 is skipped here for the obvious reason: it runs the candidate's entire test suite, and
 * this IS the candidate's test suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMailDb } from '../store/open-mail-db.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';
import { SqliteQueue } from '../store/sqlite-queue.ts';
import { runPreflight, renderPreflight, candidateEnv, conformanceVerifiedNothing } from './preflight.ts';

/** This checkout, used as the candidate. */
const REPO = resolve(import.meta.dirname, '..', '..');
const DOMAIN = 'preflight.one.example';

interface Live {
  readonly dir: string;
  readonly controlDb: string;
  readonly files: string[];
}

function makeLive(dir: string): Live {
  const controlDb = join(dir, 'control.db');
  const db = openMailDb(controlDb);
  const registry = AccountRegistry.open(db);
  const files = [controlDb];
  for (const login of ['alice', 'bob']) {
    const path = join(dir, `mail-${login}.db`);
    registry.upsert(login, `${login}-passphrase`, path);
    files.push(path);
    const userDb = openMailDb(path);
    const catalog = SqliteCatalog.open(userDb, 1);
    for (const name of ['Sent', 'Drafts', 'Trash', 'Junk', 'Archive']) catalog.create(name);
    const inbox = catalog.get('INBOX')!;
    for (let i = 0; i < 3; i++) {
      inbox.append(Buffer.from(`Subject: message ${i} for ${login}\r\nFrom: someone@two.example\r\n\r\nbody ${i}\r\n`, 'latin1'), [], 1_700_000_000_000 + i);
    }
    userDb.close();
  }
  // Something in the outbound queue: a candidate booted in deliver mode would relay it a second
  // time, and a failed attempt would still bump its attempt count. Either is visible below.
  SqliteQueue.open(db).enqueue('alice@' + DOMAIN, ['elsewhere@two.example'], Buffer.from('Subject: waiting\r\n\r\nqueued\r\n', 'latin1'), 1_700_000_000_000);
  db.close();
  return { dir, controlDb, files };
}

const digestOf = (files: readonly string[]): string[] =>
  files.map((f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent'));

/** Everything about the queue that a relay attempt, successful or not, would change. */
function queueState(controlDb: string): Array<{ id: string; attempts: number; next: number }> {
  const db = new DatabaseSync(controlDb, { readOnly: true });
  try {
    return (db.prepare('SELECT id, attempts, next_attempt FROM outbound_queue ORDER BY id').all() as Array<{
      id: string;
      attempts: number;
      next_attempt: number;
    }>).map((r) => ({ id: r.id, attempts: Number(r.attempts), next: Number(r.next_attempt) }));
  } finally {
    db.close();
  }
}

function baseOptions(live: Live, work: string, candidateDir = REPO): Parameters<typeof runPreflight>[0] {
  return {
    candidateDir,
    baselineDir: REPO,
    sha: 'f'.repeat(40),
    controlDbPath: live.controlDb,
    env: { ...process.env, MAIL_DOMAIN: DOMAIN, MAIL_CONTROL_DB: live.controlDb },
    workDir: work,
    bootTimeoutMs: 120_000,
  };
}

test('the ladder runs against real data and leaves every live file byte-identical', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-preflight-'));
  try {
    const live = makeLive(dir);
    const before = digestOf(live.files);
    const queueBefore = queueState(live.controlDb);
    assert.equal(queueBefore.length, 1, 'the fixture really does have something queued');

    const work = join(dir, 'work');
    const report = await runPreflight(baseOptions(live, work));

    assert.equal(report.ok, true, `the ladder should pass against this tree:\n${renderPreflight(report)}`);
    assert.deepEqual(
      report.rungs.map((r) => r.name),
      [
        'shape',
        'runs on this machine',
        'isolated boot and conformance',
        'migration against your data',
        'mail path against your data',
        'the running version can still read the migrated data',
      ],
    );
    assert.ok(report.migrationMs !== null && report.migrationMs > 0, 'the migration was timed, because that is the cutover downtime');

    // THE ASSERTIONS THAT MATTER. Four daemons were spawned across the ladder, two of them against
    // a copy of this data, and one was driven through authenticated submission, local delivery and
    // IMAP read-back — and none of it reached the real files.
    assert.deepEqual(digestOf(live.files), before, 'every live database is byte-identical after the pre-flight');
    assert.deepEqual(queueState(live.controlDb), queueBefore, 'the queued message was never touched: no relay tick ran against real mail');

    // The snapshot held every secret the live system holds; it does not outlive the check.
    assert.equal(existsSync(work), false, 'the work directory, snapshot included, is gone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a candidate that cannot start fails the ladder, and still leaves the live data alone', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-preflight-broken-'));
  try {
    const live = makeLive(dir);
    const before = digestOf(live.files);

    // A copy of this checkout whose entry point throws on load: the shape is right, so the failure
    // has to be caught by actually running it rather than by inspecting it.
    const broken = join(dir, 'broken-candidate');
    cpSync(REPO, broken, {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.includes(`${REPO}/.git`),
    });
    writeFileSync(join(broken, 'src', 'main.ts'), 'throw new Error("this version is broken");\n');

    const report = await runPreflight(baseOptions(live, join(dir, 'work'), broken));
    assert.equal(report.ok, false);
    const failed = report.rungs.find((r) => !r.ok);
    // Caught at rung 4, on nothing but an import, before a daemon was spawned and long before any
    // real data was involved. A tree that cannot be loaded cannot be run, and finding that out
    // costs an import rather than a boot and a ready-deadline.
    assert.equal(failed?.name, 'runs on this machine', 'caught by loading the tree, before anything was started');
    assert.match(failed!.detail, /src\/main\.ts/, 'the module that would not load is named');
    assert.match(failed!.detail, /this version is broken/, "the candidate's own error is reported, so the cause is visible");

    assert.deepEqual(digestOf(live.files), before, 'a failed candidate cannot touch live data either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a candidate that breaks conformance the running version satisfies is refused', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutiemail-preflight-regress-'));
  try {
    const live = makeLive(dir);
    const before = digestOf(live.files);

    // A candidate that boots perfectly well and answers every RCPT with a refusal. Rungs 3 and the
    // boot half of 5 all pass; only measuring its behaviour against the running version catches it.
    const regressed = join(dir, 'regressed-candidate');
    cpSync(REPO, regressed, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes(`${REPO}/.git`) });
    const mainPath = join(regressed, 'src', 'main.ts');
    const source = readFileSync(mainPath, 'utf8');
    const anchor = 'acceptRecipient: (address) => loginForLocalAddress(address) !== undefined,';
    assert.equal(source.split(anchor).length - 1, 1, 'the inbound acceptRecipient hook is where this test expects it');
    writeFileSync(mainPath, source.replace(anchor, 'acceptRecipient: () => false,'));

    const report = await runPreflight(baseOptions(live, join(dir, 'work'), regressed));
    assert.equal(report.ok, false);
    const failed = report.rungs.find((r) => !r.ok);
    assert.equal(failed?.name, 'isolated boot and conformance');
    assert.match(failed!.detail, /introduces \d+ conformance finding\(s\) the running version does not have/);

    assert.deepEqual(digestOf(live.files), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a conformance run where every case was inconclusive verified nothing', () => {
  // The blind spot in measuring readiness by "the ports accept": a listener that accepts and then
  // says nothing makes every case inconclusive, which produces no findings, which the regression
  // comparison would otherwise read as "no new findings" and wave through.
  const none = new Map<string, string>();
  assert.equal(conformanceVerifiedNothing({ total: 220, inconclusive: 220, findings: none }), true);
  assert.equal(conformanceVerifiedNothing({ total: 220, inconclusive: 219, findings: none }), false, 'one real answer is enough to have verified something');
  assert.equal(conformanceVerifiedNothing({ total: 220, inconclusive: 0, findings: none }), false);
  assert.equal(conformanceVerifiedNothing({ total: 0, inconclusive: 0, findings: none }), false, 'an empty corpus is a different problem');
});

test('the candidate is configured to hold outbound mail, on a snapshot, with no updater of its own', () => {
  const warnings: string[] = [];
  const env = candidateEnv(
    {
      env: {
        PATH: '/usr/bin',
        MAIL_DOMAIN: DOMAIN,
        MAIL_CONTROL_DB: '/live/control.db',
        MAIL_DB: '/live/mail.db',
        MAIL_OUTBOUND: 'deliver',
        MAIL_MAX_SIZE: '1000000',
        MAIL_UPDATE_MODE: 'apply',
        MAIL_UPDATE_REPO: 'https://one.example/repo.git',
        MAIL_TLS_CERT: '/does/not/exist/cert.pem',
        MAIL_TLS_KEY: '/does/not/exist/key.pem',
      },
    },
    { dir: '/snap', controlDb: '/snap/control.db' },
    warnings,
  );

  // The single most dangerous thing about testing with real data: the snapshot contains the
  // outbound queue, and a candidate in deliver mode would relay every queued message a second time.
  assert.equal(env.MAIL_OUTBOUND, 'hold', 'hold is forced, overriding whatever the real configuration says');
  assert.equal(env.MAIL_CONTROL_DB, '/snap/control.db', 'and it points at the copy, not the original');
  assert.equal(env.MAIL_DB, '/snap/mail.db');
  // A program we are still deciding whether to trust must not go and update anything itself.
  assert.equal(env.MAIL_UPDATE_MODE, undefined);
  assert.equal(env.MAIL_UPDATE_REPO, undefined);
  // The rest of the real configuration is what makes this rung worth anything.
  assert.equal(env.MAIL_DOMAIN, DOMAIN);
  assert.equal(env.MAIL_MAX_SIZE, '1000000');
  // An unreadable certificate degrades the check rather than failing it, and says so out loud.
  assert.equal(env.MAIL_TLS_CERT, undefined);
  assert.match(warnings.join('\n'), /TLS certificate is not readable/);
});
