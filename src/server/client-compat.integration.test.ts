/**
 * Client compatibility: the exact command sequence Thunderbird issues during
 * account setup, replayed against the live server. This sequence was probed
 * against the deployed box (2026-07-16) and every line marked FATAL below
 * answered "BAD command unknown" — a real client aborts at the first of them.
 * This test pins the whole conversation so the gap can never reopen.
 *
 *   CAPABILITY            (FATAL — the first thing every client sends)
 *   LOGIN
 *   ID / NAMESPACE        (NAMESPACE is rev2 base; ID answered NIL)
 *   LIST "" "" / "" "*"   (FATAL — mailbox discovery)
 *   LSUB "" "*"           (rev2 dropped it; answered as a compat concession)
 *   SELECT INBOX
 *   UID FETCH 1:* (FLAGS) (FATAL — clients sync exclusively by UID)
 *   UID FETCH n (UID RFC822.SIZE FLAGS BODY.PEEK[HEADER.FIELDS (...)])
 *   UID STORE n +FLAGS.SILENT (\Seen)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { Mailbox } from '../store/mailbox.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Session {
  #acc = Buffer.alloc(0);
  readonly #sock: net.Socket;
  constructor(sock: net.Socket) {
    this.#sock = sock;
    sock.on('data', (d: Buffer) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
    sock.on('error', () => {});
  }
  /** Send a command and return everything up to (and including) the tagged reply. */
  async run(tag: string, command: string): Promise<string> {
    const from = this.#acc.length;
    this.#sock.write(Buffer.from(`${tag} ${command}\r\n`, 'latin1'));
    for (let i = 0; i < 400; i++) {
      const s = this.#acc.subarray(from).toString('latin1');
      if (new RegExp(`^${tag} (OK|NO|BAD)`, 'm').test(s)) return s;
      await delay(5);
    }
    throw new Error(`timed out on ${tag} ${command}`);
  }
  async greeting(): Promise<string> {
    return this.waitFor('* OK');
  }
  /** Send raw bytes (for literal continuations). */
  raw(bytes: string): void {
    this.#sock.write(Buffer.from(bytes, 'latin1'));
  }
  /** Wait until the accumulated transcript contains `needle`; return it all. */
  async waitFor(needle: string): Promise<string> {
    for (let i = 0; i < 400; i++) {
      const s = this.#acc.toString('latin1');
      if (s.includes(needle)) return s;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
  }
}

test('the Thunderbird account-setup sequence completes against the server', async () => {
  const mailbox = new Mailbox(7);
  const raw = Buffer.from(
    'From: someone@example.net\r\nTo: test@mail.example.test\r\nSubject: compat\r\nDate: Thu, 16 Jul 2026 12:00:00 +0000\r\n\r\nthe body\r\n',
    'latin1',
  );
  mailbox.append(raw);
  mailbox.append(Buffer.from('Subject: second\r\n\r\ntwo\r\n', 'latin1'));

  const server = await ImapServer.start(mailbox, { authenticate: (u, p) => u === 'test' && p === 'pw' });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new Session(sock);
  try {
    assert.match(await s.greeting(), /\* OK \[CAPABILITY IMAP4rev2 IDLE UIDPLUS\]/);

    const cap = await s.run('t1', 'CAPABILITY');
    assert.match(cap, /^\* CAPABILITY IMAP4rev2 IDLE UIDPLUS\r$/m, 'CAPABILITY answers as a command');
    assert.match(cap, /^t1 OK/m);

    assert.match(await s.run('t2', 'LOGIN test pw'), /^t2 OK/m);
    assert.match(await s.run('t3', 'CAPABILITY'), /^t3 OK/m);

    const id = await s.run('t4', 'ID ("name" "Thunderbird" "version" "128.0")');
    assert.match(id, /^\* ID NIL\r$/m);
    assert.match(id, /^t4 OK/m);

    const ns = await s.run('t5', 'NAMESPACE');
    assert.match(ns, /^\* NAMESPACE \(\("" "\/"\)\) NIL NIL\r$/m);

    const listRoot = await s.run('t6', 'LIST "" ""');
    assert.match(listRoot, /^\* LIST \(\\Noselect\) "\/" ""\r$/m, 'LIST "" "" reports the hierarchy delimiter');

    const list = await s.run('t7', 'LIST "" "*"');
    assert.match(list, /^\* LIST \(\\HasNoChildren\) "\/" INBOX\r$/m, 'INBOX is discoverable');

    const lsub = await s.run('t8', 'LSUB "" "*"');
    assert.match(lsub, /^\* LSUB \(\) "\/" INBOX\r$/m);

    const sel = await s.run('t9', 'SELECT "INBOX"');
    assert.match(sel, /^\* 2 EXISTS\r$/m);
    assert.match(sel, /^t9 OK \[READ-WRITE\]/m);

    // The UID-based sync a client actually performs.
    const uidFlags = await s.run('t10', 'UID FETCH 1:* (FLAGS)');
    assert.match(uidFlags, /^\* 1 FETCH \(UID 1 FLAGS \(\)\)\r$/m);
    assert.match(uidFlags, /^\* 2 FETCH \(UID 2 FLAGS \(\)\)\r$/m);

    const hdr = await s.run('t11', 'UID FETCH 1 (UID RFC822.SIZE FLAGS BODY.PEEK[HEADER.FIELDS (From To Subject Date)])');
    assert.match(hdr, /UID 1 FLAGS \(\) RFC822\.SIZE \d+ BODY\[HEADER\.FIELDS \(FROM TO SUBJECT DATE\)\] \{\d+\}/);
    assert.ok(hdr.includes('From: someone@example.net\r\n'), 'the requested header fields are served');
    assert.ok(hdr.includes('Subject: compat\r\n'));
    assert.ok(!hdr.includes('the body'), 'HEADER.FIELDS serves headers only, not the body');

    // Mark read the way clients do: UID STORE, silent.
    const store = await s.run('t12', String.raw`UID STORE 1 +FLAGS.SILENT (\Seen)`);
    assert.doesNotMatch(store, /\* 1 FETCH/, '.SILENT suppresses the untagged reply');
    assert.match(store, /^t12 OK/m);
    assert.ok([...mailbox.messages[0]!.flags].includes('\\Seen'), 'the flag was stored');

    // And the read-back the preview pane triggers.
    const body = await s.run('t13', 'UID FETCH 1 (BODY.PEEK[])');
    assert.ok(body.includes('the body'), 'full body via UID FETCH');
    assert.match(body, /UID 1/, 'UID FETCH response always carries the UID');

    // The EXACT list-building fetch real Thunderbird 140 sends (captured from the
    // live box) — it uses the legacy RFC822.HEADER item, not BODY.PEEK[HEADER].
    const tbList = await s.run('t14', 'UID FETCH 1:3 (UID RFC822.SIZE RFC822.HEADER FLAGS)');
    assert.match(tbList, /^\* 1 FETCH \(UID 1 .*RFC822\.SIZE \d+ .*RFC822\.HEADER \{\d+\}/m, 'RFC822.HEADER is served, keyed as RFC822.HEADER');
    assert.ok(tbList.includes('Subject: compat\r\n'), 'the header block carries the real headers');
    assert.ok(!tbList.includes('the body'), 'RFC822.HEADER is headers only');

    assert.match(await s.run('t15', 'LOGOUT'), /^\* BYE/m);
  } finally {
    sock.destroy();
    await server.close();
  }
});

test('the Thunderbird folder workflow: CREATE Trash, APPEND to Sent, MOVE to delete', async () => {
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  inbox.append(Buffer.from('Subject: keep\r\n\r\none\r\n', 'latin1'));
  inbox.append(Buffer.from('Subject: bin me\r\n\r\ntwo\r\n', 'latin1'));

  const server = await ImapServer.start(catalog, { authenticate: (u, p) => u === 'test' && p === 'pw' });
  const sock = net.connect(server.port, '127.0.0.1');
  const s = new Session(sock);
  try {
    await s.greeting();
    await s.run('f1', 'LOGIN test pw');

    // TB's first act after setup (captured live 2026-07-16): create Trash.
    assert.match(await s.run('f2', 'CREATE "Trash"'), /^f2 OK/m);
    assert.match(await s.run('f3', 'CREATE "Sent"'), /^f3 OK/m);
    const list = await s.run('f4', 'LIST "" "*"');
    assert.match(list, /^\* LIST \(\\HasNoChildren \\Trash\) "\/" Trash\r$/m, 'Trash carries its special-use attribute');
    assert.match(list, /^\* LIST \(\\HasNoChildren \\Sent\) "\/" Sent\r$/m);
    assert.match(await s.run('f5', 'CREATE "Trash"'), /^f5 NO/m, 'duplicate CREATE is refused');

    // STATUS on a non-selected mailbox — how TB polls folder counts.
    const status = await s.run('f6', 'STATUS "INBOX" (MESSAGES UNSEEN UIDNEXT)');
    assert.match(status, /^\* STATUS INBOX \(MESSAGES 2 UNSEEN 2 UIDNEXT 3\)\r$/m);

    // APPEND with a synchronizing literal — how TB files the sent copy.
    const sentMsg = 'Subject: sent copy\r\n\r\nfiled by the client\r\n';
    s.raw(`f7 APPEND "Sent" (\\Seen) {${sentMsg.length}}\r\n`);
    await s.waitFor('+ Ready');
    s.raw(`${sentMsg}\r\n`);
    const appended = await s.waitFor('f7 ');
    assert.match(appended, /f7 OK \[APPENDUID 1 1\] APPEND completed/, 'APPEND returns the UIDPLUS APPENDUID of the filed message');
    assert.equal(catalog.get('Sent')!.messages.length, 1, 'the sent copy is filed');
    assert.ok(catalog.get('Sent')!.messages[0]!.flags.has('\\Seen'), 'APPEND flags are applied');

    // Delete-via-Trash: TB moves the message (rev2 MOVE), numbering stays consistent.
    await s.run('f8', 'SELECT "INBOX"');
    const move = await s.run('f9', 'UID MOVE 2 "Trash"');
    assert.match(move, /f9 OK \[COPYUID 1 2 1\] MOVE completed/, 'MOVE reports COPYUID (src uid 2 -> dst uid 1 in Trash)');
    assert.match(move, /^\* 2 EXPUNGE\r$/m, 'MOVE reports the expunged sequence number');
    assert.match(move, /^f9 OK/m);
    assert.equal(inbox.messages.length, 1, 'the message left INBOX');
    assert.equal(catalog.get('Trash')!.messages.length, 1, 'and landed in Trash');
    assert.ok(catalog.get('Trash')!.messages[0]!.raw.includes(Buffer.from('bin me')), 'byte content preserved through the move');

    // COPY leaves the original in place.
    const copy = await s.run('f10', 'UID COPY 1 "Sent"');
    assert.match(copy, /^f10 OK/m);
    assert.equal(inbox.messages.length, 1, 'COPY does not remove the source');
    assert.equal(catalog.get('Sent')!.messages.length, 2);

    // A COPY to a missing mailbox gets the TRYCREATE hint, not a BAD.
    assert.match(await s.run('f11', 'UID COPY 1 "Nowhere"'), /^f11 NO \[TRYCREATE\]/m);

    // UIDPLUS UID EXPUNGE: only \Deleted messages within the given UID set go.
    await s.run('f12', 'CREATE "Work"');
    // Put two messages in Work and mark both \Deleted.
    for (const body of ['a', 'b']) {
      const m = `Subject: ${body}\r\n\r\n${body}\r\n`;
      s.raw(`fA APPEND "Work" {${m.length}}\r\n`);
      await s.waitFor('+ Ready');
      s.raw(`${m}\r\n`);
      await s.waitFor('fA OK');
    }
    await s.run('f13', 'SELECT "Work"');
    await s.run('f14', String.raw`UID STORE 1:2 +FLAGS.SILENT (\Deleted)`);
    const uidExpunge = await s.run('f15', 'UID EXPUNGE 1'); // only uid 1, though both are \Deleted
    assert.match(uidExpunge, /^\* 1 EXPUNGE\r$/m, 'the targeted UID was expunged');
    assert.equal(catalog.get('Work')!.messages.length, 1, 'the other \\Deleted message (uid 2, not in the set) stayed');
    assert.equal(catalog.get('Work')!.messages[0]!.uid, 2);
  } finally {
    sock.destroy();
    await server.close();
  }
});
