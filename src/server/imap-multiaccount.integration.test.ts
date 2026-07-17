/**
 * Multi-account isolation (ADR 0009). With a `resolveAccount` resolver, each login is
 * served its OWN catalog + notifier. This is the security-critical property: a session
 * authenticated as one user must never reach another user's mailboxes, messages, or IDLE
 * notifications. The negative control proves the test detects a leak — with a resolver
 * deliberately mis-wired to hand Bob Alice's catalog, Bob sees Alice's secret mailbox.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';
import { MailboxNotifier } from './mailbox-notifier.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Session {
  #acc = Buffer.alloc(0);
  readonly sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
    sock.on('error', () => {});
  }
  send(s: string): void {
    this.sock.write(Buffer.from(s, 'latin1'));
  }
  async run(tag: string, command: string): Promise<string> {
    const from = this.#acc.length;
    this.send(`${tag} ${command}\r\n`);
    for (let i = 0; i < 400; i++) {
      const s = this.#acc.subarray(from).toString('latin1');
      if (new RegExp(`^${tag} (OK|NO|BAD)`, 'm').test(s)) return s;
      await delay(5);
    }
    throw new Error(`timed out on ${tag} ${command}`);
  }
  since(len: number): string {
    return this.#acc.subarray(len).toString('latin1');
  }
  get len(): number {
    return this.#acc.length;
  }
}

/** Two users, each with their own catalog + notifier; a distinct mailbox in each. */
function twoAccounts(): {
  alice: { catalog: MemoryCatalog; notifier: MailboxNotifier };
  bob: { catalog: MemoryCatalog; notifier: MailboxNotifier };
} {
  const alice = { catalog: new MemoryCatalog(), notifier: new MailboxNotifier() };
  const bob = { catalog: new MemoryCatalog(), notifier: new MailboxNotifier() };
  alice.catalog.get('INBOX')!.append(Buffer.from('Subject: alice-only mail\r\n\r\nhi alice\r\n', 'latin1'));
  alice.catalog.create('AliceSecret');
  bob.catalog.get('INBOX')!.append(Buffer.from('Subject: bob-only mail\r\n\r\nhi bob\r\n', 'latin1'));
  bob.catalog.get('INBOX')!.append(Buffer.from('Subject: bob second\r\n\r\nmore bob\r\n', 'latin1'));
  bob.catalog.create('BobSecret');
  return { alice, bob };
}

async function connect(server: Awaited<ReturnType<typeof ImapServer.start>>): Promise<Session> {
  const s = new Session(net.connect(server.port, '127.0.0.1'));
  await delay(30);
  return s;
}

test('each user sees only their own mailboxes and messages', async () => {
  const { alice, bob } = twoAccounts();
  const accounts: Record<string, { catalog: MemoryCatalog; notifier: MailboxNotifier }> = { alice, bob };
  const server = await ImapServer.start(alice.catalog, {
    authenticate: (u, p) => p === 'pw' && u in accounts,
    resolveAccount: (login) => accounts[login],
  });
  const a = await connect(server);
  const b = await connect(server);
  try {
    await a.run('a1', 'LOGIN alice pw');
    await b.run('b1', 'LOGIN bob pw');

    // Alice's view: her mailbox and message, none of Bob's.
    const aList = await a.run('a2', 'LIST "" "*"');
    assert.match(aList, /"\/" AliceSecret/, 'alice sees her own mailbox');
    assert.doesNotMatch(aList, /BobSecret/, 'alice must NOT see bob\'s mailbox');
    const aSel = await a.run('a3', 'SELECT INBOX');
    assert.match(aSel, /^\* 1 EXISTS/m, 'alice INBOX has her one message');
    const aFetch = await a.run('a4', 'FETCH 1 (BODY[HEADER.FIELDS (SUBJECT)])');
    assert.match(aFetch, /alice-only mail/);
    assert.doesNotMatch(aFetch, /bob/i);
    // Alice cannot select Bob's mailbox even by guessing its name.
    assert.match(await a.run('a5', 'SELECT BobSecret'), /^a5 NO/m, 'alice cannot select bob\'s mailbox');

    // Bob's view: his two messages and his mailbox, none of Alice's.
    const bList = await b.run('b2', 'LIST "" "*"');
    assert.match(bList, /"\/" BobSecret/, 'bob sees his own mailbox');
    assert.doesNotMatch(bList, /AliceSecret/, 'bob must NOT see alice\'s mailbox');
    const bSel = await b.run('b3', 'SELECT INBOX');
    assert.match(bSel, /^\* 2 EXISTS/m, 'bob INBOX has his two messages');
    assert.match(await b.run('b4', 'SELECT AliceSecret'), /^b4 NO/m, 'bob cannot select alice\'s mailbox');
  } finally {
    a.sock.destroy();
    b.sock.destroy();
    await server.close();
  }
});

test('credentials that verify but resolve to no account are rejected (disabled/unknown)', async () => {
  const { alice } = twoAccounts();
  // `carol` passes the credential check but the resolver has no store for her (disabled).
  const server = await ImapServer.start(alice.catalog, {
    authenticate: (u, p) => p === 'pw' && (u === 'alice' || u === 'carol'),
    resolveAccount: (login) => (login === 'alice' ? alice : undefined),
  });
  const s = await connect(server);
  try {
    assert.match(await s.run('s1', 'LOGIN carol pw'), /^s1 NO \[AUTHENTICATIONFAILED\]/m, 'unroutable account is refused');
    // And a genuinely good account still works on the same server.
    assert.match(await s.run('s2', 'LOGIN alice pw'), /^s2 OK/m);
  } finally {
    s.sock.destroy();
    await server.close();
  }
});

test('IDLE notifications are scoped per user: Bob\'s new mail does not wake Alice', async () => {
  const { alice, bob } = twoAccounts();
  const accounts: Record<string, { catalog: MemoryCatalog; notifier: MailboxNotifier }> = { alice, bob };
  const server = await ImapServer.start(alice.catalog, {
    authenticate: (u, p) => p === 'pw' && u in accounts,
    resolveAccount: (login) => accounts[login],
  });
  const a = await connect(server);
  try {
    await a.run('a1', 'LOGIN alice pw');
    await a.run('a2', 'SELECT INBOX');
    a.send('a3 IDLE\r\n');
    await delay(40);
    const mark = a.len;
    // A delivery to BOB's INBOX + bob's notifier must not reach alice's idle connection.
    bob.catalog.get('INBOX')!.append(Buffer.from('Subject: new bob\r\n\r\nx\r\n', 'latin1'));
    bob.notifier.notify('INBOX');
    await delay(60);
    assert.doesNotMatch(a.since(mark), /EXISTS/, 'alice must not be woken by bob\'s delivery');
    // A delivery to ALICE's INBOX + her notifier must wake her.
    alice.catalog.get('INBOX')!.append(Buffer.from('Subject: new alice\r\n\r\ny\r\n', 'latin1'));
    alice.notifier.notify('INBOX');
    await delay(60);
    assert.match(a.since(mark), /^\* 2 EXISTS/m, 'alice is woken by her own delivery');
    a.send('DONE\r\n');
    await a.run('a3', '');
  } finally {
    a.sock.destroy();
    await server.close();
  }
});

test('two of one user\'s devices share a store: a change on one connection surfaces on the other', async () => {
  const { alice, bob } = twoAccounts();
  const accounts: Record<string, { catalog: MemoryCatalog; notifier: MailboxNotifier }> = { alice, bob };
  // The resolver hands BOTH of Alice's connections the SAME store instance (as MailStores'
  // per-login cache does in production) — the precondition for multi-connection sync.
  const server = await ImapServer.start(alice.catalog, {
    authenticate: (u, p) => p === 'pw' && u in accounts,
    resolveAccount: (login) => accounts[login],
  });
  const phone = await connect(server);
  const desktop = await connect(server);
  try {
    await phone.run('p1', 'LOGIN alice pw');
    await desktop.run('d1', 'LOGIN alice pw');
    await phone.run('p2', 'SELECT INBOX');
    await desktop.run('d2', 'SELECT INBOX');
    // The desktop appends a message; the phone must see it at its next command boundary.
    const msg = 'Subject: from desktop\r\n\r\nhi\r\n';
    desktop.send(`d3 APPEND INBOX {${msg.length}}\r\n`);
    await delay(30);
    desktop.send(msg + '\r\n');
    await delay(40);
    const noop = await phone.run('p3', 'NOOP');
    assert.match(noop, /^\* 2 EXISTS/m, 'the phone sees the desktop\'s new message (shared store)');
  } finally {
    phone.sock.destroy();
    desktop.sock.destroy();
    await server.close();
  }
});

test('negative control: a resolver that mis-maps Bob to Alice\'s catalog leaks — the test catches it', async () => {
  const { alice } = twoAccounts();
  // Deliberately broken: every login is handed Alice's catalog.
  const server = await ImapServer.start(alice.catalog, {
    authenticate: (u, p) => p === 'pw',
    resolveAccount: () => alice,
  });
  const b = await connect(server);
  try {
    await b.run('b1', 'LOGIN bob pw');
    const leaked = await b.run('b2', 'LIST "" "*"');
    // Under the leak, Bob CAN see Alice's mailbox — proving the isolation assertions above
    // are real (they would fail on this wiring).
    assert.match(leaked, /AliceSecret/, 'the mis-wired resolver leaks Alice\'s mailbox to Bob (control)');
  } finally {
    b.sock.destroy();
    await server.close();
  }
});
