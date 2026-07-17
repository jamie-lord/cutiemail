/**
 * FETCH BODYSTRUCTURE / BODY over the wire (RFC 9051 §7.5.2). A client uses this to
 * render a message's parts — showing an attachment's name without downloading it, and
 * choosing which alternative to display. Pins that a bare BODY / BODYSTRUCTURE returns
 * the MIME tree while the bracketed BODY[...] section fetch is unaffected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('FETCH BODYSTRUCTURE returns the MIME tree; BODY[...] still fetches content', async () => {
  const cat = new MemoryCatalog();
  cat
    .get('INBOX')!
    .append(
      Buffer.from(
        'Content-Type: multipart/mixed; boundary="B"\r\nSubject: hi\r\n\r\n' +
          '--B\r\nContent-Type: text/plain\r\n\r\nthe body text\r\n' +
          '--B\r\nContent-Type: application/pdf; name="doc.pdf"\r\nContent-Disposition: attachment; filename="doc.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0K\r\n' +
          '--B--\r\n',
        'latin1',
      ),
    );
  const server = await ImapServer.start(cat, { authenticate: () => true });
  const sock = net.connect(server.port, '127.0.0.1');
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('latin1')));
  sock.on('error', () => {});
  await new Promise<void>((r) => sock.once('connect', () => r()));
  sock.write(Buffer.from('a1 LOGIN u p\r\na2 SELECT INBOX\r\na3 UID FETCH 1 (BODYSTRUCTURE)\r\na4 UID FETCH 1 (BODY.PEEK[1])\r\na5 UID FETCH 1 (BODY.PEEK[2])\r\na9 LOGOUT\r\n', 'latin1'));
  for (let i = 0; i < 400 && !acc.includes('a9 OK'); i++) await delay(5);
  sock.destroy();
  await server.close();

  const bs = acc.split('\r\n').find((l) => l.includes('BODYSTRUCTURE')) ?? '';
  assert.match(bs, /"MIXED" \("boundary" "B"\)/, 'the container is multipart/mixed with its boundary');
  assert.match(bs, /"APPLICATION" "PDF" \("name" "doc\.pdf"\)/, 'the attachment name is exposed');
  assert.match(bs, /\("attachment" \("filename" "doc\.pdf"\)\)/, 'the disposition/filename is exposed');

  // Part fetch: BODY[1] is the text part's content, BODY[2] is just the attachment —
  // so a client can download one part without pulling the whole message.
  const literal = (marker: string): string => {
    const re = new RegExp(`BODY\\[${marker}\\] \\{(\\d+)\\}\\r\\n`);
    const m = re.exec(acc);
    if (m === null) return '';
    const start = m.index + m[0].length;
    return acc.slice(start, start + Number(m[1]));
  };
  assert.equal(literal('1'), 'the body text', 'BODY[1] returns the text part content');
  assert.equal(literal('2'), 'JVBERi0K', 'BODY[2] returns only the attachment content');
});
