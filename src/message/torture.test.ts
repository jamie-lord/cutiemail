/**
 * Live-path message torture. A real mail server serves ENVELOPE and BODYSTRUCTURE
 * for whatever bytes arrive from the open internet, inside the IMAP response stream.
 * If a builder emits a raw CR/LF or an unbalanced quote/paren into that stream, it
 * desyncs the client's parser for the rest of the connection — the exact bug class
 * this guards against (a zero-child multipart serialised as a bare string,
 * NUL bytes reaching a quoted string).
 *
 * The parser fuzz (fuzz.test.ts) proves the PARSERS never throw on hostile input.
 * This proves the SERIALIZERS never emit malformed IMAP on hostile-but-realistic
 * input: a curated corpus of gnarly messages real senders actually produce, each run
 * through the live `serializeEnvelope(buildEnvelope(...))` and `bodyStructureResponse`
 * builders, asserting the output is well-formed IMAP.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from './parse.ts';
import { buildEnvelope, serializeEnvelope } from '../imap/envelope.ts';
import { bodyStructureResponse } from './body-structure.ts';

/**
 * Assert a fragment is safe to place in an IMAP response stream: no bare CR/LF or
 * other C0/DEL control octet (which would break framing), and balanced parentheses
 * and double quotes outside of nothing — the structure a client's response parser
 * relies on. (Our builders emit only quoted strings and NIL/atoms, never literals,
 * so a plain quote/paren balance check is exact.)
 */
function assertWellFormedImap(fragment: string, label: string): void {
  for (let i = 0; i < fragment.length; i++) {
    const c = fragment.charCodeAt(i);
    assert.ok(c !== 0x0d && c !== 0x0a, `${label}: bare CR/LF at ${i} would desync the stream: ${JSON.stringify(fragment)}`);
    assert.ok(c >= 0x20 && c !== 0x7f, `${label}: control octet 0x${c.toString(16)} at ${i}: ${JSON.stringify(fragment)}`);
  }
  // Paren / quote balance, treating \" and \\ inside a quoted string as escapes.
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i];
    if (inQuote) {
      if (ch === '\\') i++; // skip the escaped octet
      else if (ch === '"') inQuote = false;
    } else if (ch === '"') inQuote = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      assert.ok(depth >= 0, `${label}: unbalanced ')' : ${JSON.stringify(fragment)}`);
    }
  }
  assert.equal(depth, 0, `${label}: unbalanced parentheses: ${JSON.stringify(fragment)}`);
  assert.ok(!inQuote, `${label}: unterminated quoted string: ${JSON.stringify(fragment)}`);
}

const CRLF = '\r\n';
const boundary = (b: string): string => `--${b}`;

/** Gnarly-but-realistic messages. Each is bytes a real sender or forwarder can emit. */
const CORPUS: Array<{ name: string; raw: Buffer }> = [
  {
    name: 'RFC 2047 encoded-word display name with IMAP metacharacters',
    raw: Buffer.from(`From: =?utf-8?q?"Doe=2C_John"_=28ops=29?= <j@x.test>${CRLF}Subject: =?utf-8?B?4oCccXVvdGVz4oCd?=${CRLF}${CRLF}body`, 'latin1'),
  },
  {
    name: 'quoted display name containing comma, @, parens, quote, backslash',
    raw: Buffer.from(`From: "Doe, John (\\"boss\\") <evil@x>" <real@x.test>${CRLF}To: a@x.test, b@y.test${CRLF}${CRLF}b`, 'latin1'),
  },
  {
    name: '8-bit and control bytes in headers',
    raw: Buffer.from(`From: \xc3\x89ric <e@x.test>${CRLF}Subject: tab\there and \x07bell and \x00nul${CRLF}${CRLF}b`, 'latin1'),
  },
  {
    name: 'missing every header',
    raw: Buffer.from(`${CRLF}just a body, no headers at all`, 'latin1'),
  },
  {
    name: 'duplicate From and Subject',
    raw: Buffer.from(`From: a@x.test${CRLF}From: b@y.test${CRLF}Subject: one${CRLF}Subject: two${CRLF}${CRLF}b`, 'latin1'),
  },
  {
    name: 'address with no host, and bare @',
    raw: Buffer.from(`From: nohost${CRLF}To: @${CRLF}Cc: <>${CRLF}${CRLF}b`, 'latin1'),
  },
  {
    name: 'very long folded Subject',
    raw: Buffer.from(`Subject: ${Array.from({ length: 40 }, (_, i) => `word${i}`).join(`${CRLF} `)}${CRLF}From: a@x.test${CRLF}${CRLF}b`, 'latin1'),
  },
  {
    name: 'multipart with a boundary full of regex metacharacters',
    raw: Buffer.from(
      `From: a@x.test${CRLF}Content-Type: multipart/mixed; boundary="a.b*c+d(e)[f]|g"${CRLF}${CRLF}` +
        `${boundary('a.b*c+d(e)[f]|g')}${CRLF}Content-Type: text/plain${CRLF}${CRLF}part${CRLF}` +
        `${boundary('a.b*c+d(e)[f]|g')}--${CRLF}`,
      'latin1',
    ),
  },
  {
    name: 'multipart declared but with zero matching parts',
    raw: Buffer.from(`From: a@x.test${CRLF}Content-Type: multipart/mixed; boundary="B"${CRLF}${CRLF}no parts here, boundary never appears${CRLF}`, 'latin1'),
  },
  {
    name: 'attachment filename with quotes, semicolons and control chars',
    raw: Buffer.from(
      `From: a@x.test${CRLF}Content-Type: multipart/mixed; boundary="B"${CRLF}${CRLF}` +
        `${boundary('B')}${CRLF}Content-Type: application/octet-stream; name="a\\"b;c\x01d.bin"${CRLF}Content-Disposition: attachment; filename="x\ty.bin"${CRLF}${CRLF}data${CRLF}` +
        `${boundary('B')}--${CRLF}`,
      'latin1',
    ),
  },
  {
    name: 'deeply nested multipart (12 levels)',
    raw: ((): Buffer => {
      let inner = `Content-Type: text/plain${CRLF}${CRLF}deep`;
      for (let i = 0; i < 12; i++) {
        const b = `L${i}`;
        inner = `Content-Type: multipart/mixed; boundary="${b}"${CRLF}${CRLF}${boundary(b)}${CRLF}${inner}${CRLF}${boundary(b)}--${CRLF}`;
      }
      return Buffer.from(`From: a@x.test${CRLF}${inner}`, 'latin1');
    })(),
  },
  {
    name: 'message/rfc822 forwarded attachment (nested envelope)',
    raw: Buffer.from(
      `From: fwd@x.test${CRLF}Content-Type: multipart/mixed; boundary="B"${CRLF}${CRLF}` +
        `${boundary('B')}${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}` +
        `From: "Inner, Name" <inner@y.test>${CRLF}Subject: =?utf-8?q?fwd?=${CRLF}${CRLF}inner body${CRLF}` +
        `${boundary('B')}--${CRLF}`,
      'latin1',
    ),
  },
  {
    name: 'Content-Type with unterminated quoted parameter',
    raw: Buffer.from(`From: a@x.test${CRLF}Content-Type: text/plain; name="unterminated${CRLF}${CRLF}b`, 'latin1'),
  },
  {
    name: 'group address syntax (RFC 5322) in From/To',
    raw: Buffer.from(`From: Group: a@x.test, b@y.test;${CRLF}To: undisclosed-recipients:;${CRLF}${CRLF}b`, 'latin1'),
  },
  {
    name: 'lone CR and lone LF inside header values',
    raw: Buffer.from(`From: a@x.test${CRLF}Subject: has a \r lone cr and \n lone lf${CRLF}${CRLF}b`, 'latin1'),
  },
];

test('ENVELOPE is well-formed IMAP for every torture message', () => {
  for (const { name, raw } of CORPUS) {
    const env = serializeEnvelope(buildEnvelope(parseMessage(raw).headers));
    assertWellFormedImap(env, `ENVELOPE[${name}]`);
    assert.ok(env.startsWith('(') && env.endsWith(')'), `${name}: ENVELOPE is a parenthesised list`);
  }
});

test('BODYSTRUCTURE is well-formed IMAP for every torture message', () => {
  for (const { name, raw } of CORPUS) {
    const bs = bodyStructureResponse(raw);
    assertWellFormedImap(bs, `BODYSTRUCTURE[${name}]`);
    assert.ok(bs.startsWith('(') && bs.endsWith(')'), `${name}: BODYSTRUCTURE is a parenthesised list`);
  }
});

test('the well-formedness checker itself rejects the failure modes (negative control)', () => {
  assert.throws(() => assertWellFormedImap('("a\r\nb")', 'x'), /desync/);
  assert.throws(() => assertWellFormedImap('("a" "b"', 'x'), /unbalanced paren/i);
  assert.throws(() => assertWellFormedImap('("unterminated)', 'x'), /unterminated|unbalanced/i);
  assert.throws(() => assertWellFormedImap('("nul\x00")', 'x'), /control octet/);
  // A genuinely well-formed fragment passes.
  assertWellFormedImap('("Doe, John" NIL "j" "x.test")', 'x');
});
