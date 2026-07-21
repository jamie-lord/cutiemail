/**
 * `queue` + `dead-letter` CLI (backlog B5) — presentation over the tested store.
 *
 * The store semantics (transactional dead-letter move, requeue, purge) are
 * proven in dead-letter.test.ts; here the claims are the CLI's own: every
 * pending / retained entry is VISIBLE with the fields an operator acts on
 * (negative direction: an id the store doesn't have is a clean error, never a
 * silent success), show's --raw stream is BYTE-EXACT (an .eml you can replay),
 * and requeue-through-the-CLI really moves the message back to the live queue.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQueue, runDeadLetter } from './queue-cli.ts';
import { SqliteQueue } from '../store/sqlite-queue.ts';
import { openMailDb } from '../store/open-mail-db.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'queue-cli-test-'));
}
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

const MESSAGE = Buffer.from('From: a@b.example\r\nSubject: hello\r\n\r\nbody bytes \x00\xff here', 'latin1');

/** A control DB with one pending entry and one dead letter; returns their ids. */
function makeWorld(dir: string): { dbPath: string; pendingId: string; deadId: string } {
  const dbPath = join(dir, 'control.db');
  const db = openMailDb(dbPath);
  const queue = SqliteQueue.open(db);
  const pendingId = queue.enqueue('sender@here.example', ['slow@there.example'], Buffer.from('pending message', 'latin1'), 1000);
  const deadId = queue.enqueue('sender@here.example', ['gone@there.example'], MESSAGE, 2000);
  const entry = queue.due(Number.MAX_SAFE_INTEGER).find((e) => e.id === deadId)!;
  queue.deadLetter(entry, { failedRecipients: ['gone@there.example'], lastError: 'permanent: 550 5.1.1 no such user', now: 3000 });
  db.close();
  return { dbPath, pendingId, deadId };
}

test('queue list shows every pending entry with recipients, attempts, and next-attempt timing', () => {
  const dir = tmp();
  try {
    const { dbPath, pendingId, deadId } = makeWorld(dir);
    const cap = capture();
    assert.equal(runQueue(['list', '--db', dbPath], cap.io, {}), 0);
    const text = cap.out.join('\n');
    assert.match(text, new RegExp(pendingId));
    assert.match(text, /to=slow@there\.example/);
    assert.match(text, /attempts=0/);
    assert.match(text, /1 message\(s\) pending/);
    // The dead-lettered message is NOT in the live queue (the move is exclusive).
    assert.equal(text.includes(deadId), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dead-letter list carries the final error; show prints headers; --raw is byte-exact', () => {
  const dir = tmp();
  try {
    const { dbPath, deadId } = makeWorld(dir);
    const list = capture();
    assert.equal(runDeadLetter(['list', '--db', dbPath], list.io, {}), 0);
    assert.match(list.out.join('\n'), /550 5\.1\.1 no such user/);
    assert.match(list.out.join('\n'), /1 retained message\(s\)/);

    const show = capture();
    assert.equal(runDeadLetter(['show', deadId, '--db', dbPath], show.io, {}), 0);
    const text = show.out.join('\n');
    assert.match(text, /Subject: hello/); // headers shown
    assert.equal(text.includes('body bytes'), false); // body not dumped without --raw

    // --raw: the .eml path — byte-exact including the non-ASCII body bytes (non-TTY sink).
    const chunks: Buffer[] = [];
    assert.equal(runDeadLetter(['show', deadId, '--raw', '--db', dbPath], capture().io, {}, (b) => void chunks.push(b), false), 0);
    assert.deepEqual(Buffer.concat(chunks), MESSAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dead-letter show sanitises terminal escape sequences in attacker-controlled headers', () => {
  const dir = tmp();
  try {
    const dbPath = join(dir, 'control.db');
    const db = openMailDb(dbPath);
    const queue = SqliteQueue.open(db);
    // A message whose Subject carries an OSC 52 clipboard-write + a CSI screen-clear.
    // OSC 52 clipboard-write + CSI screen-clear + a lone CR line-overwrite in the Subject.
    const evil = Buffer.from('From: a@b.example\r\nSubject: \x1b]52;c;ZXZpbA==\x07\x1b[2Jok\rFORGED\r\n\r\nbody\r\n', 'latin1');
    const id = queue.enqueue('s@here.example', ['gone@there.example'], evil, 2000);
    const entry = queue.due(Number.MAX_SAFE_INTEGER).find((e) => e.id === id)!;
    queue.deadLetter(entry, { failedRecipients: ['gone@there.example'], lastError: 'permanent: nope', now: 3000 });
    db.close();

    const show = capture();
    assert.equal(runDeadLetter(['show', id, '--db', dbPath], show.io, {}, () => {}, false), 0);
    const text = show.out.join('\n');
    assert.equal(text.includes('\x1b'), false, 'no ESC byte reaches the terminal');
    assert.equal(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/.test(text), false, 'no C0/C1 controls reach the terminal');
    // A lone CR (line-overwrite forgery) is neutralised too.
    assert.equal(/\r(?!\n)/.test(text), false, 'no lone CR reaches the terminal');
    assert.match(text, /Subject: /); // the header is still shown, just neutralised
    // The escapes are also neutralised in the `list` line (lastError can carry remote bytes).
    const list = capture();
    runDeadLetter(['list', '--db', dbPath], list.io, {}, () => {}, false);
    assert.equal(list.out.join('\n').includes('\x1b'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dead-letter show --raw refuses a terminal (escape bytes would execute) but writes to a file sink', () => {
  const dir = tmp();
  try {
    const { dbPath, deadId } = makeWorld(dir);
    // isTty=true → refuse, exit 2, write nothing.
    const chunks: Buffer[] = [];
    const cap = capture();
    assert.equal(runDeadLetter(['show', deadId, '--raw', '--db', dbPath], cap.io, {}, (b) => void chunks.push(b), true), 2);
    assert.equal(chunks.length, 0, 'no bytes written to a TTY');
    assert.match(cap.err.join('\n'), /refusing to write to a terminal/);
    // isTty=false (redirected) → the exact bytes are written.
    assert.equal(runDeadLetter(['show', deadId, '--raw', '--db', dbPath], capture().io, {}, (b) => void chunks.push(b), false), 0);
    assert.deepEqual(Buffer.concat(chunks), MESSAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requeue moves the message back to the live queue (and out of dead-letter)', () => {
  const dir = tmp();
  try {
    const { dbPath, deadId } = makeWorld(dir);
    const cap = capture();
    assert.equal(runDeadLetter(['requeue', deadId, '--db', dbPath], cap.io, {}), 0);

    const db = openMailDb(dbPath);
    const queue = SqliteQueue.open(db);
    assert.equal(queue.getDeadLetter(deadId), undefined); // gone from dead-letter
    const live = queue.due(Number.MAX_SAFE_INTEGER);
    assert.equal(live.length, 2); // the original pending one + the requeued one
    assert.ok(live.some((e) => e.data.equals(MESSAGE))); // byte-exact through the round trip
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('purge removes exactly the named entry; unknown ids are clean errors (exit 1), never silent', () => {
  const dir = tmp();
  try {
    const { dbPath, deadId } = makeWorld(dir);
    assert.equal(runDeadLetter(['purge', 'no-such-id', '--db', dbPath], capture().io, {}), 1);
    assert.equal(runDeadLetter(['requeue', 'no-such-id', '--db', dbPath], capture().io, {}), 1);
    assert.equal(runDeadLetter(['show', 'no-such-id', '--db', dbPath], capture().io, {}), 1);

    assert.equal(runDeadLetter(['purge', deadId, '--db', dbPath], capture().io, {}), 0);
    const after = capture();
    runDeadLetter(['list', '--db', dbPath], after.io, {});
    assert.match(after.out.join('\n'), /empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage errors: bad verb / missing id / typo path exit 2; empty stores say so', () => {
  const dir = tmp();
  try {
    const { dbPath } = makeWorld(dir);
    assert.equal(runQueue([], capture().io, {}), 2);
    assert.equal(runQueue(['flush', '--db', dbPath], capture().io, {}), 2);
    assert.equal(runDeadLetter(['show', '--db', dbPath], capture().io, {}), 2); // id required
    assert.equal(runDeadLetter(['list', '--db', join(dir, 'typo.db')], capture().io, {}), 2); // no silent CREATE

    const emptyDb = join(dir, 'fresh.db');
    const db = openMailDb(emptyDb);
    SqliteQueue.open(db);
    db.close();
    const cap = capture();
    assert.equal(runQueue(['list', '--db', emptyDb], cap.io, {}), 0);
    assert.match(cap.out.join('\n'), /empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queue retry makes a deferred entry due now; unknown ids are clean errors', () => {
  const dir = tmp();
  try {
    const { dbPath, pendingId } = makeWorld(dir);
    // Push the pending entry far into the future (a long backoff the operator wants to skip).
    {
      const db = openMailDb(dbPath);
      SqliteQueue.open(db).reschedule(pendingId, ['slow@there.example'], 3, Date.now() + 3_600_000);
      db.close();
    }
    const c = capture();
    assert.equal(runQueue(['retry', pendingId, '--db', dbPath], c.io, {}), 0);
    assert.match(c.out.join('\n'), /made due now/);
    const db = openMailDb(dbPath);
    const entry = SqliteQueue.open(db).due(Date.now() + 1000).find((e) => e.id === pendingId);
    db.close();
    assert.ok(entry !== undefined, 'the entry is due immediately after retry');

    const miss = capture();
    assert.equal(runQueue(['retry', 'no-such-id', '--db', dbPath], miss.io, {}), 1);
    assert.match(miss.err.join('\n'), /no pending message/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queue retry --all touches every pending entry', () => {
  const dir = tmp();
  try {
    const { dbPath, pendingId } = makeWorld(dir);
    {
      const db = openMailDb(dbPath);
      SqliteQueue.open(db).reschedule(pendingId, ['slow@there.example'], 3, Date.now() + 3_600_000);
      db.close();
    }
    const c = capture();
    assert.equal(runQueue(['retry', '--all', '--db', dbPath], c.io, {}), 0);
    assert.match(c.out.join('\n'), /1 message\(s\) made due now/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queue cancel retains the message in dead-letter — cancellation is never a silent discard', () => {
  const dir = tmp();
  try {
    const { dbPath, pendingId } = makeWorld(dir);
    const c = capture();
    assert.equal(runQueue(['cancel', pendingId, '--db', dbPath], c.io, {}), 0);
    assert.match(c.out.join('\n'), /retained in dead-letter/);
    const db = openMailDb(dbPath);
    const queue = SqliteQueue.open(db);
    assert.equal(queue.due(Number.MAX_SAFE_INTEGER).some((e) => e.id === pendingId), false, 'off the live queue');
    const dead = queue.getDeadLetter(pendingId);
    db.close();
    assert.ok(dead !== undefined, 'retained as a dead letter');
    assert.equal(dead.data.toString('latin1'), 'pending message', 'bytes retained exactly');
    assert.match(dead.lastError, /cancelled by operator/);

    const miss = capture();
    assert.equal(runQueue(['cancel', 'no-such-id', '--db', dbPath], miss.io, {}), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
