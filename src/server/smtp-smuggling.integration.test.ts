/**
 * SMTP smuggling defence (SEC Consult, 2023 — the "\n.\n" / bare-newline class).
 *
 * Our end-of-data is strictly <CRLF>.<CRLF>, so a bare-LF "\n.\n" inside the body is
 * NOT treated as end-of-data here — it is stored as content and would be relayed
 * onward. A lenient downstream MTA that DOES honour "\n.\n" would then read the bytes
 * after it as injected SMTP commands (a spoofed MAIL FROM / RCPT). RFC 5321 §2.3.8
 * allows CR and LF only as a paired <CRLF>; so we reject any bare CR/LF in DATA, which
 * is what modern Postfix/Exim/Sendmail do by default. This pins that we refuse the
 * vector AND still accept well-formed CRLF mail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { SmtpReceiver } from './smtp-receiver.ts';
import type { DeliveredMessage } from './smtp-receiver.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function deliverRaw(dataPayload: string): Promise<{ reply: string; delivered: DeliveredMessage[] }> {
  const delivered: DeliveredMessage[] = [];
  const rec = await SmtpReceiver.start((m) => { delivered.push(m); }, {});
  let replies = '';
  try {
    const s = net.connect(rec.port, '127.0.0.1');
    s.on('data', (d) => (replies += d.toString('latin1')));
    s.on('error', () => {});
    await new Promise<void>((r) => s.once('connect', () => r()));
    await delay(15);
    for (const c of ['EHLO client\r\n', 'MAIL FROM:<a@example.com>\r\n', 'RCPT TO:<b@example.net>\r\n', 'DATA\r\n']) {
      s.write(c);
      await delay(15);
    }
    s.write(Buffer.from(dataPayload, 'latin1'));
    await delay(60);
    s.destroy();
  } finally {
    await rec.close();
  }
  return { reply: replies.trim().split('\r\n').pop() ?? '', delivered };
}

test('a bare-LF smuggling payload is rejected and never delivered', async () => {
  // "legit\n.\nMAIL FROM:..." — the "\n.\n" is the smuggling seam.
  const { reply, delivered } = await deliverRaw('Subject: outer\r\n\r\nlegit line\n.\nMAIL FROM:<attacker@evil.test>\r\n.\r\n');
  assert.match(reply, /^550 /, 'the message is rejected with a permanent 5yz');
  assert.match(reply, /bare CR or LF/i, 'the reason names the bare-newline cause');
  assert.equal(delivered.length, 0, 'nothing is stored — we cannot become a smuggling relay');
});

test('a bare CR in DATA is rejected', async () => {
  const { reply, delivered } = await deliverRaw('Subject: x\r\n\r\nbad\rcarriage return\r\n.\r\n');
  assert.match(reply, /^550 /, 'bare CR is rejected too, not just bare LF');
  assert.equal(delivered.length, 0);
});

test('a well-formed CRLF message is still accepted (the defence is not over-broad)', async () => {
  const { reply, delivered } = await deliverRaw('Subject: fine\r\n\r\nevery line ends in CRLF\r\nso this is clean\r\n.\r\n');
  assert.match(reply, /^250 /, 'clean CRLF mail is accepted');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.data.toString('latin1'), 'Subject: fine\r\n\r\nevery line ends in CRLF\r\nso this is clean\r\n');
});
