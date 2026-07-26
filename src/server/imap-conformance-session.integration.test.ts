/**
 * RFC 9051 wire conformance: the session surface — what the server announces, how it authenticates,
 * how it says goodbye, and the updates it owes a client that is just sitting there.
 *
 * The §5.2 cases are the ones that could not exist before this file. "A server MUST send mailbox
 * size updates automatically" is a statement about what connection A is told when connection B
 * changes something, so no amount of parser testing and no single-connection test can observe it.
 * It is also the requirement that decides whether a mail client feels alive or makes people press
 * refresh.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { imapRequirement, type ImapRequirementId } from '../register/imap/index.ts';
import { withImapServer, IMAP_TEST_USER, IMAP_TEST_PASS } from '../testing/imap-fixture.ts';
import { ImapClient, untaggedOf } from '../testing/imap-client.ts';

const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);

test('CAPABILITY answers with exactly one untagged response naming IMAP4rev2, before the OK', async () => {
  cites('R-9051-6.1.1-a');
  await withImapServer(async (fx) => {
    // A bare connection: no account, no authentication. Three separable obligations.
    const c = await ImapClient.connect(fx.server.imap.port);
    try {
      const reply = await c.command('CAPABILITY');
      assert.equal(reply.status, 'OK', reply.line);
      const caps = untaggedOf(reply, 'CAPABILITY');
      assert.equal(caps.length, 1, `exactly one untagged CAPABILITY: ${reply.untagged.join(' | ')}`);
      assert.match(caps[0]!, /\bIMAP4rev2\b/, `naming IMAP4rev2: ${caps[0]}`);
      // Arriving before the tagged OK is what `untagged` means here, by construction.
    } finally {
      c.close();
    }
  });
});

test('AUTH=PLAIN is advertised on the implicit-TLS port', async () => {
  cites('R-9051-6.1.1-c');
  await withImapServer(async (fx) => {
    const c = await ImapClient.connect(fx.server.imap.port);
    try {
      const reply = await c.command('CAPABILITY');
      // Advertised, not merely accepted: a conforming client picks its mechanism from this list, so
      // an unadvertised AUTH=PLAIN is one that will never be tried.
      assert.match(untaggedOf(reply, 'CAPABILITY')[0]!, /\bAUTH=PLAIN\b/, reply.untagged.join(' | '));
    } finally {
      c.close();
    }
  });
});

test('there is no cleartext IMAP port to offer a plaintext mechanism on', async () => {
  cites('R-9051-6.2.2-c');
  await withImapServer(async (fx) => {
    // The observable form of "MUST implement a configuration in which it does NOT permit any
    // plaintext password mechanisms unless ... TLS has been negotiated on an Implicit TLS port":
    // the only IMAP listener is an implicit-TLS one, so a plaintext client gets no greeting and no
    // opportunity to send a password. This would fail loudly if a cleartext listener were added.
    const greeting = await new Promise<string>((resolve) => {
      const sock = net.connect(fx.server.imap.port, '127.0.0.1');
      let seen = '';
      sock.setEncoding('latin1');
      sock.setTimeout(1500, () => {
        sock.destroy();
        resolve(seen);
      });
      sock.on('data', (d: string) => {
        seen += d;
        if (seen.length > 64) {
          sock.destroy();
          resolve(seen);
        }
      });
      sock.on('error', () => resolve(seen));
      sock.on('close', () => resolve(seen));
    });
    assert.doesNotMatch(greeting, /^\* OK/, `a plaintext client must not get an IMAP greeting, got ${JSON.stringify(greeting.slice(0, 60))}`);
  });
});

test('LOGOUT sends BYE, then the tagged OK, then closes the connection', async () => {
  cites('R-9051-6.1.3-a');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    const reply = await c.logout();
    assert.equal(reply.status, 'OK', reply.line);
    // All three parts, in order. A client that sees the socket drop without the BYE cannot tell a
    // clean logout from a network fault.
    assert.equal(untaggedOf(reply, 'BYE').length, 1, `an untagged BYE before the OK: ${reply.untagged.join(' | ')}`);

    const closed = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 5000;
      const poll = setInterval(() => {
        if (c.closed || Date.now() > deadline) {
          clearInterval(poll);
          resolve(c.closed);
        }
      }, 25);
    });
    assert.equal(closed, true, 'and then the server closes the connection');
  });
});

test('AUTHENTICATE with an unsupported mechanism is NO; with malformed base64 it is BAD', async () => {
  cites('R-9051-6.2.2-a');
  cites('R-9051-6.2.2-b');
  await withImapServer(async (fx) => {
    const c = await ImapClient.connect(fx.server.imap.port);
    try {
      // A mechanism we do not offer is a policy answer: NO. The client should try another.
      const unsupported = await c.command('AUTHENTICATE GSSAPI');
      assert.equal(unsupported.status, 'NO', `an unsupported mechanism draws NO: ${unsupported.line}`);

      // Malformed data is a protocol answer: BAD. The distinction matters — NO sends a client back
      // to the user for a new password, BAD tells it that retrying will not help. Node's base64
      // decoder is why this needs its own gate: it SKIPS characters outside the alphabet and stops
      // at the first '=', so garbage decodes to a short buffer that then fails the credential
      // check and drew NO. The user was told their password was wrong; their client's encoder was.
      const tag = c.nextTag();
      c.writeRaw(`${tag} AUTHENTICATE PLAIN\r\n`);
      // Wait for the continuation, then answer with something outside the base64 alphabet.
      await new Promise((r) => setTimeout(r, 100));
      c.writeRaw('!!!not base64!!!\r\n');
      const malformed = await c.readTagged(tag);
      assert.equal(malformed.status, 'BAD', `malformed base64 draws BAD, not NO: ${malformed.line}`);
    } finally {
      c.close();
    }
  });
});

test('the same base64 rule binds the RFC 4959 initial response', async () => {
  cites('R-9051-6.2.2-a');
  // The structural sibling: `AUTHENTICATE PLAIN <base64>` inline is the same protocol error as a
  // garbage continuation line, and a gate on one path and not the other is this project's
  // most-repeated defect. One connection per probe — three malformed commands on one connection
  // would trip the pre-auth bad-command limit before the third was answered.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['!!!not base64!!!', 'characters outside the alphabet'],
    ['QUJD', 'valid base64, so this one is a credential answer'],
    ['QUJDR', 'a length that is not a multiple of four — a truncated credential, not a wrong one'],
    ['QU=J', 'a non-terminal "=", which §6.2.2 names explicitly'],
  ];
  await withImapServer(async (fx) => {
    for (const [payload, why] of cases) {
      const c = await ImapClient.connect(fx.server.imap.port);
      try {
        const reply = await c.command(`AUTHENTICATE PLAIN ${payload}`);
        // The well-formed one is the negative control: it must NOT be a BAD, or this test would
        // pass against a server that refuses every initial response.
        const expected = payload === 'QUJD' ? 'NO' : 'BAD';
        assert.equal(reply.status, expected, `${payload} (${why}): ${reply.line}`);
      } finally {
        c.close();
      }
    }
  });
});

test('a mailbox size change reaches another session without it asking', async () => {
  cites('R-9051-5.2-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const watcher = await fx.session();
    const writer = await fx.session();
    await watcher.command('SELECT INBOX');
    await watcher.unsolicited();

    // Delivered by the other session, over the protocol — not poked into the store behind the
    // server's back, which would prove nothing about what it notices.
    const appended = await writer.commandWithLiteral(
      'APPEND INBOX',
      'From: a@two.example\r\nSubject: new arrival\r\n\r\nbody\r\n',
    );
    assert.equal(appended.status, 'OK', appended.line);

    // Any command will do; NOOP is the conventional one. The EXISTS must be there.
    const noop = await watcher.command('NOOP');
    const pushed = [...(await watcher.unsolicited(0)), ...noop.untagged];
    assert.ok(
      pushed.some((l) => /^\* 2 EXISTS/.test(l)),
      `the new size reaches the other session: ${pushed.join(' | ')}`,
    );
  });
});

test('a flag change reaches another session without it asking', async () => {
  cites('R-9051-5.2-b');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const watcher = await fx.session();
    const writer = await fx.session();
    await watcher.command('SELECT INBOX');
    await writer.command('SELECT INBOX');
    await watcher.unsolicited();

    assert.equal((await writer.command('STORE 1 +FLAGS (\\Seen)')).status, 'OK');

    const noop = await watcher.command('NOOP');
    const pushed = [...(await watcher.unsolicited(0)), ...noop.untagged];
    // This is what makes a message read on a phone grey out on a laptop.
    assert.ok(
      pushed.some((l) => /FETCH .*\\Seen/.test(l)),
      `the flag change reaches the other session: ${pushed.join(' | ')}`,
    );
  });
});

test('pipelined commands whose order matters are executed in the order given', async () => {
  cites('R-9051-5.5-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();
    await c.command('SELECT INBOX');

    // Both commands in a single write, with no wait between them. The FETCH answer depends on
    // whether the STORE ran first, so this is exactly the "possible ambiguity" §5.5 covers.
    const store = c.nextTag();
    const fetch = c.nextTag();
    c.writeRaw(`${store} STORE 1 +FLAGS (\\Flagged)\r\n${fetch} FETCH 1 (FLAGS)\r\n`);

    const storeReply = await c.readTagged(store);
    assert.equal(storeReply.status, 'OK', storeReply.line);
    const fetchReply = await c.readTagged(fetch);
    assert.equal(fetchReply.status, 'OK', fetchReply.line);
    assert.match(
      untaggedOf(fetchReply, 'FETCH').join('\n'),
      /\\Flagged/,
      'the FETCH sees the STORE that preceded it on the wire',
    );
  });
});

test('an unauthenticated session cannot reach a mailbox', async () => {
  cites('R-9051-6.2.2-b');
  await withImapServer(async (fx) => {
    // One connection per command, deliberately. The server drops a pre-authentication session after
    // three refused commands as an anti-abuse measure, so probing several on one connection would
    // measure that limit rather than the state machine — and would have read as a protocol failure.
    for (const command of ['SELECT INBOX', 'FETCH 1 (FLAGS)', 'STATUS INBOX (MESSAGES)', 'APPEND INBOX {3}']) {
      const c = await ImapClient.connect(fx.server.imap.port);
      try {
        const reply = await c.command(command);
        assert.notEqual(reply.status, 'OK', `${command} must not work before authentication: ${reply.line}`);
      } finally {
        c.close();
      }
    }
  });
});

test('a session refused too many times before authenticating is dropped', async () => {
  cites('R-9051-6.2.2-b');
  await withImapServer(async (fx) => {
    // Not an RFC requirement — RFC 9051 says nothing about how many refusals a server tolerates —
    // but a deliberate guard against an unauthenticated peer probing the command surface, and worth
    // pinning so it is not lost. Recorded here rather than left implicit because the case above
    // has to work around it.
    const c = await ImapClient.connect(fx.server.imap.port);
    try {
      for (let i = 0; i < 3; i++) await c.command('SELECT INBOX').catch(() => undefined);
      const dropped = await new Promise<boolean>((resolve) => {
        const deadline = Date.now() + 5000;
        const poll = setInterval(() => {
          if (c.closed || Date.now() > deadline) {
            clearInterval(poll);
            resolve(c.closed);
          }
        }, 25);
      });
      assert.equal(dropped, true, 'the connection is closed rather than left open to probe');
    } finally {
      c.close();
    }
  });
});

test('valid credentials work on a fresh connection', async () => {
  cites('R-9051-6.2.2-b');
  await withImapServer(async (fx) => {
    const c = await ImapClient.connect(fx.server.imap.port);
    try {
      assert.equal((await c.command(`LOGIN ${IMAP_TEST_USER} ${IMAP_TEST_PASS}`)).status, 'OK');
      assert.equal((await c.command('SELECT INBOX')).status, 'OK', 'and the state machine opens up');
    } finally {
      c.close();
    }
  });
});
