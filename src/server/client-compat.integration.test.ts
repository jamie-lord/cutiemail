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
    for (let i = 0; i < 400; i++) {
      const s = this.#acc.toString('latin1');
      if (s.includes('* OK')) return s;
      await delay(5);
    }
    throw new Error('no greeting');
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
    assert.match(await s.greeting(), /\* OK \[CAPABILITY IMAP4rev2\]/);

    const cap = await s.run('t1', 'CAPABILITY');
    assert.match(cap, /^\* CAPABILITY IMAP4rev2\r$/m, 'CAPABILITY answers as a command');
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
