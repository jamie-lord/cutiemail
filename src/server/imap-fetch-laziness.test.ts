/**
 * The performance contract as a test: a metadata command must NOT load message bodies.
 *
 * The scaling fix (docs/PERFORMANCE.md) rests on one invariant — the IMAP server answers
 * FLAGS/SIZE/STATUS/metadata-SEARCH from `index()` alone and fetches a body via `raw(uid)`
 * ONLY when a body-bearing attribute is asked for. That is exactly the kind of property that
 * a well-meaning refactor can silently break (revert an accessor to eager loading, add a
 * `.raw` read to the list path) with every existing test still green. So we pin it: wrap a
 * real mailbox in a counter and assert, over the wire, how many bodies each command loads.
 *
 * A regression here means the O(mailbox-bytes)-per-command tax is back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Mailbox, type MessageMeta } from '../store/mailbox.ts';
import { canonicalMailboxName } from '../store/mailbox-name.ts';
import { ImapServer, type ServableCatalog, type ServableMailbox } from './imap-server.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A ServableMailbox that delegates to a real Mailbox and counts body (raw) loads. */
class CountingMailbox implements ServableMailbox {
  rawCalls = 0;
  indexCalls = 0;
  readonly inner: Mailbox;
  constructor(inner: Mailbox) {
    this.inner = inner;
  }
  get uidValidity(): number {
    return this.inner.uidValidity;
  }
  get uidNext(): number {
    return this.inner.uidNext;
  }
  get highestModseq(): number {
    return this.inner.highestModseq;
  }
  index(): readonly MessageMeta[] {
    this.indexCalls++;
    return this.inner.index();
  }
  raw(uid: number): Buffer | undefined {
    this.rawCalls++;
    return this.inner.raw(uid);
  }
  append(raw: Buffer, flags?: readonly string[], internalDate?: number): number {
    return this.inner.append(raw, flags, internalDate);
  }
  expunge(uid: number): void {
    this.inner.expunge(uid);
  }
  storeFlags(uid: number, mode: 'add' | 'remove' | 'replace', flags: readonly string[]): void {
    this.inner.storeFlags(uid, mode, flags);
  }
  expungeDeleted(): readonly number[] {
    return this.inner.expungeDeleted();
  }
  expungedSince(modseq: number, restrictTo?: ReadonlySet<number>): number[] {
    return this.inner.expungedSince(modseq, restrictTo);
  }
}

function connect(port: number): { sock: net.Socket; run: (cmd: string, tag: string) => Promise<string> } {
  const sock = net.connect(port, '127.0.0.1');
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('error', () => {});
  const run = async (cmd: string, tag: string): Promise<string> => {
    const from = acc.length;
    sock.write(Buffer.from(cmd, 'latin1'));
    for (let i = 0; i < 400; i++) {
      if (new RegExp(`^${tag} (OK|NO|BAD)`, 'm').test(acc.slice(from))) return acc.slice(from);
      await delay(5);
    }
    throw new Error(`timeout on ${tag}: ${acc.slice(from)}`);
  };
  return { sock, run };
}

test('a metadata command loads zero bodies; a body fetch loads exactly one', async () => {
  const inner = new Mailbox(1);
  const body = Buffer.from('From: a@b.c\r\nSubject: hi\r\n\r\nhello world body text\r\n', 'latin1');
  for (let i = 0; i < 5; i++) inner.append(body, i % 2 === 0 ? [] : ['\\Seen']);
  const box = new CountingMailbox(inner);
  const catalog: ServableCatalog = {
    listNames: () => ['INBOX'],
    get: (name) => (canonicalMailboxName(name) === 'INBOX' ? box : undefined),
    create: () => undefined,
  };
  const server = await ImapServer.start(catalog, { authenticate: () => true });
  const c = connect(server.port);

  try {
    await new Promise<void>((r) => c.sock.once('connect', () => r()));
    await c.run('a LOGIN u p\r\n', 'a');
    await c.run('b SELECT INBOX\r\n', 'b');

    const bodiesFor = async (cmd: string, tag: string): Promise<number> => {
      box.rawCalls = 0;
      await c.run(cmd, tag);
      return box.rawCalls;
    };

    // Metadata-only commands: NOT a single body may be loaded, at any mailbox size.
    assert.equal(await bodiesFor('c FETCH 1:* (FLAGS)\r\n', 'c'), 0, 'FETCH FLAGS loads no bodies');
    assert.equal(await bodiesFor('d FETCH 1:* (RFC822.SIZE INTERNALDATE UID)\r\n', 'd'), 0, 'SIZE comes from metadata');
    assert.equal(await bodiesFor('e STATUS INBOX (MESSAGES UNSEEN SIZE DELETED)\r\n', 'e'), 0, 'STATUS loads no bodies');
    assert.equal(await bodiesFor('f SEARCH UNSEEN\r\n', 'f'), 0, 'a flag SEARCH loads no bodies');
    assert.equal(await bodiesFor('g SEARCH LARGER 1\r\n', 'g'), 0, 'a size SEARCH loads no bodies (uses metadata)');

    // A single-message body fetch loads exactly one body — not the whole mailbox.
    assert.equal(await bodiesFor('h FETCH 3 (BODY[])\r\n', 'h'), 1, 'BODY[] of one message loads exactly one body');
    assert.equal(await bodiesFor('i FETCH 2 (BODY[HEADER])\r\n', 'i'), 1, 'BODY[HEADER] loads one body, once');

    // A body/text SEARCH must read bodies (only then) — but that is the sole such path.
    assert.ok((await bodiesFor('j SEARCH BODY "hello"\r\n', 'j')) > 0, 'a body SEARCH does read bodies');
  } finally {
    c.sock.destroy();
    await server.close();
  }
});
