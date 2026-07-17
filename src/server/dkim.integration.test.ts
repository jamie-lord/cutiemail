/**
 * DKIM end to end: a message is SIGNED on the way out, delivered through the live
 * SMTP server into SQLite storage, and its DKIM signature still VERIFIES against the
 * delivered bytes. This wires together the DKIM signer, the delivery client, the
 * live receiver, SQLite storage, and the DKIM verifier — proving the deliverability
 * crypto works on the real bytes that travel the wire, not just in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { deliver } from '../client/deliver.ts';
import { SmtpReceiver } from './smtp-receiver.ts';
import { SqliteMailbox } from '../store/sqlite-mailbox.ts';
import { signMessage } from '../crypto/dkim-sign.ts';
import type { SignedField } from '../crypto/dkim-verify.ts';
import { buildSigningInput, verifySignature } from '../crypto/dkim-verify.ts';
import { parseDkimSignature } from '../crypto/dkim-signature.ts';
import { verifyBodyHash } from '../crypto/dkim-bodyhash.ts';
import { parseMessage } from '../message/parse.ts';

test('DKIM: a signed message delivered over SMTP verifies from SQLite storage', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const signedFields: SignedField[] = [
    { name: 'From', value: 'alice@example.com' },
    { name: 'To', value: 'bob@example.net' },
    { name: 'Subject', value: 'signed and delivered' },
  ];
  const body = Buffer.from('This message is DKIM-signed, delivered, and then verified.\r\n', 'latin1');

  const signed = signMessage({ domain: 'example.com', selector: 'sel', headerCanon: 'relaxed', bodyCanon: 'relaxed', signedHeaders: signedFields, body, privateKey });
  assert.ok(signed.ok, 'signing succeeds');

  // Assemble the full RFC 5322 message: signed headers + DKIM-Signature + body.
  const headerBlock = signedFields.map((f) => `${f.name}: ${f.value}`).join('\r\n');
  const message = Buffer.from(`${headerBlock}\r\nDKIM-Signature: ${signed.header}\r\n\r\n`, 'latin1');
  const fullMessage = Buffer.concat([message, body]);

  // Deliver it through the live server into SQLite.
  const db = new DatabaseSync(':memory:');
  const mailbox = SqliteMailbox.open(db);
  const smtp = await SmtpReceiver.start((m) => { mailbox.append(m.data); });
  try {
    const sent = await deliver(
      { host: '127.0.0.1', port: smtp.port, tls: 'none' },
      { from: 'alice@example.com', recipients: ['bob@example.net'], data: fullMessage, clientName: 'client.example.org' },
    );
    assert.ok(sent.ok, `delivery should succeed: ${sent.failure}`);

    // --- Verify the DKIM signature on the STORED bytes. ---
    const stored = mailbox.messages[0]!.raw;
    const parsed = parseMessage(stored);
    const headerValue = (name: string): string =>
      parsed.headers.find((h) => h.name.toString('latin1').toLowerCase() === name.toLowerCase())?.value.toString('latin1').trim() ?? '';

    const sig = parseDkimSignature(Buffer.from(headerValue('DKIM-Signature'), 'latin1'));
    assert.ok(sig.valid, 'the delivered DKIM-Signature is well-formed');

    // Body hash: over the delivered body.
    assert.ok(verifyBodyHash(parsed.body, sig).ok, 'the body hash verifies against the delivered body');

    // Signature: reconstruct the header hash input from the delivered headers.
    const deliveredFields: SignedField[] = sig.signedHeaders.map((n) => ({ name: n, value: headerValue(n) }));
    const input = buildSigningInput(deliveredFields, headerValue('DKIM-Signature'), 'relaxed');
    assert.ok(verifySignature(input, sig.signature ?? '', publicKey, 'RSA-SHA256'), 'the signature verifies against the delivered bytes');
  } finally {
    await smtp.close();
    db.close();
  }
});
