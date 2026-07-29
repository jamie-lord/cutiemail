/**
 * What reaches the operator's terminal, and in what state.
 *
 * `sanitizeForTerminal` exists because remote-derived strings can carry ANSI/OSC escape
 * sequences — its own docstring names "a spoofable DNS/DMARC record" as one of the sources. Three
 * sites did not use it:
 *
 *  - The DMARC enforcement log spliced the attacker's From domain in raw, twenty lines above the
 *    per-message log line that IS wrapped. `domainToASCII` strips CR, LF and TAB when building the
 *    query name, so a folded From yields a clean, resolvable name — discovery succeeds, the policy
 *    fires, and the raw bytes stay in the value that gets logged. journald splits on LF, so one
 *    message became several journal records that read as genuine daemon output. journalctl's own
 *    escaping does not help: the newline is consumed as a record separator before any escaping runs.
 *  - Both auth-failure sites used `JSON.stringify` and claimed in a comment that this meant no raw
 *    control bytes reached the log. It escapes C0, quote and backslash — but passes DEL (0x7f) and
 *    the whole C1 range 0x80–0x9f, which is exactly the set the sanitiser strips.
 *  - `MAIL_DEBUG` redacted a single `\S+` token as the password, while the LOGIN handler is
 *    deliberately quote-aware because a passphrase may be a quoted string containing spaces. So a
 *    successful login logged everything after the first word of a working credential, against
 *    README's explicit "(credentials redacted)".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactImapDebugLine } from './imap-server.ts';
import { checkDmarc } from './dmarc-inbound.ts';
import { startServer } from '../main.ts';
import { deliver } from '../client/deliver.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

test('a folded From domain cannot forge extra lines in the DMARC enforcement log', async () => {
  // The attacker publishes p=reject on a domain they control, so enforcement fires and the log
  // line is reached; the payload rides in the From domain, folded with CRLF + TAB.
  const zone = new Map<string, readonly string[]>([['_dmarc.attacker.test', ['v=DMARC1; p=reject']]]);
  const queried: string[] = [];
  const resolveTxt = async (name: string): Promise<readonly string[]> => {
    queried.push(name);
    return zone.get(name) ?? [];
  };
  const payload = 'x\r\n\t2026-01-01t00h00m00z-mailserver.all-clear\r\n\t.attacker.test';
  const out = await checkDmarc({
    rawMessage: Buffer.from(`From: <spoof@${payload}>\r\nSubject: t\r\n\r\nbody\r\n`, 'latin1'),
    dkimPassedDomains: [],
    spfResult: 'fail',
    spfDomain: '',
    resolveTxt,
  });

  // Precondition: the query name really is clean, so discovery really does succeed — this is
  // what makes the log line reachable at all.
  assert.ok(
    queried.every((n) => !/[\r\n\t]/.test(n)),
    'domainToASCII strips CR/LF/TAB, so the lookup succeeds while the raw bytes survive in the value',
  );
  assert.equal(out.verdict, 'fail');
  assert.equal(out.policy, 'reject', 'enforcement fires, so main.ts reaches the log line');

  // Now the production path: deliver such a message through the real daemon and capture what it
  // logs. Asserting on `sanitizeForTerminalLine(...)` here would prove only that the sanitiser
  // works — the defect was that this call site did not use it.
  const events: string[] = [];
  const server = await startServer({
    dbPath: ':memory:',
    host: '127.0.0.1',
    smtpPort: 0,
    submissionPort: 0,
    imapPort: 0,
    domain: 'mail.example.test',
    accounts: [{ user: 'alice', pass: 'pw' }],
    tls: { key: TEST_KEY, cert: TEST_CERT },
    spfResolvers: { txt: resolveTxt, a: async () => [], mx: async () => [] },
    dkimKeyResolver: async () => null,
    dmarcPctSampler: () => 0,
    onEvent: (line) => events.push(line),
  });
  try {
    await deliver(
      { host: '127.0.0.1', port: server.inbound.port, tls: 'none' },
      {
        from: 'spoof@attacker.test',
        recipients: ['alice@mail.example.test'],
        data: Buffer.from(`From: <spoof@${payload}>\r\nSubject: probe\r\n\r\nbody\r\n`, 'latin1'),
        clientName: 'attacker.test',
      },
    );
    await new Promise((r) => setTimeout(r, 200));
    const dmarcLines = events.filter((l) => l.includes('DMARC'));
    assert.ok(dmarcLines.length > 0, 'the enforcement decision was logged');
    for (const line of dmarcLines) {
      assert.doesNotMatch(
        line,
        /[\r\n]/,
        `one event must be one record; a folded From forged extra journal records: ${JSON.stringify(line)}`,
      );
      assert.doesNotMatch(line, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/, 'no control octets either');
    }
  } finally {
    await server.close();
  }
});

test('a failed login cannot put DEL or C1 bytes into the operator log', async () => {
  // The comments at both auth-failure sites claimed JSON-escaping meant no raw control bytes
  // reached the log. It escapes C0, `"` and `\` — but passes DEL (0x7f) and the whole C1 range
  // (0x80-0x9f), the 33 bytes sanitizeForTerminal strips and that some terminals treat as 8-bit
  // escape introducers. This drives the real pre-authentication path rather than asserting a
  // property of JSON.stringify, which no change to our code could ever make true.
  const events: string[] = [];
  const cat = new MemoryCatalog();
  const server = await ImapServer.start(cat, {
    authenticate: async () => false,
    log: (line) => events.push(line),
  });
  try {
    const sock = net.connect(server.port, '127.0.0.1');
    sock.on('error', () => {});
    await new Promise<void>((r) => sock.once('connect', () => r()));
    // A username carrying DEL and C1 bytes, unauthenticated.
    sock.write(Buffer.from('a1 LOGIN "x\x9b[2Ky\x7fz" wrong\r\n', 'latin1'));
    for (let i = 0; i < 200 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    sock.destroy();

    assert.ok(events.length > 0, 'the failed auth was logged');
    for (const line of events) {
      assert.doesNotMatch(
        line,
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/,
        `control octets reached the fail2ban feed: ${JSON.stringify(line)}`,
      );
    }
  } finally {
    await server.close();
  }
});

test('MAIL_DEBUG redacts a quoted passphrase, not just its first word', () => {
  // A passphrase is commonly a quoted string with spaces — the LOGIN handler is quote-aware for
  // exactly that reason, and this redactor was not, so a WORKING credential was logged minus its
  // first word.
  const quoted = redactImapDebugLine('a1 LOGIN "alice" "correct horse battery staple"', false);
  assert.doesNotMatch(quoted, /horse|battery|staple/, 'no part of the passphrase survives');
  assert.match(quoted, /\*\*\*/, 'it is replaced, not dropped');

  // A quoted username with spaces must not shift the redaction onto the wrong token.
  const quotedUser = redactImapDebugLine('a1 LOGIN "alice smith" "correct horse battery"', false);
  assert.doesNotMatch(quotedUser, /horse|battery/, 'the passphrase is still what gets redacted');

  // A trailing space is a SUCCESSFUL login on this server, so an end-anchored pattern that
  // silently stops matching there would leak the whole password.
  const trailing = redactImapDebugLine('a1 LOGIN bob s3cr3t ', false);
  assert.doesNotMatch(trailing, /s3cr3t/, 'a trailing space must not defeat redaction');

  // The unquoted form, and the AUTHENTICATE forms, still redact.
  assert.doesNotMatch(redactImapDebugLine('a1 LOGIN alice s3cr3t', false), /s3cr3t/);
  assert.equal(redactImapDebugLine('anything', true), '<SASL response redacted>');

  // …and ordinary commands are untouched.
  assert.equal(redactImapDebugLine('a1 SELECT INBOX', false), 'a1 SELECT INBOX');
  assert.equal(redactImapDebugLine('a1 NOOP', false), 'a1 NOOP');
});

test('MAIL_DEBUG output carries no raw escape sequences', () => {
  // Reachable pre-authentication on port 25, so the bytes are unauthenticated attacker input.
  const hostile = 'a1 NOOP \x1b]0;PWNED\x07\x1b[2K\x1b[1;32mmail queue OK';
  const out = redactImapDebugLine(hostile, false);
  assert.doesNotMatch(out, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/, 'no control octets reach the terminal');
});
