/**
 * Inbound DKIM verification (RFC 6376 §6) — the receive-side mirror of the signer.
 * Round-trips a message signed by our own signer through the verifier (so the test
 * needs no live DNS: the key resolver returns the matching public key), and checks the
 * verdicts that matter: a valid signature passes, a tampered body or a wrong key fails,
 * a missing key is a permerror, and an unsigned message is "none".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signMessage } from '../crypto/dkim-sign.ts';
import { verifyDkim, MAX_DKIM_SIGNATURES } from './dkim-inbound.ts';
import { computeBodyHash, canonicalizedBodyLength } from '../crypto/dkim-bodyhash.ts';
import type { SignedField } from '../crypto/dkim-verify.ts';

function signedMessage(): { message: Buffer; publicKeyDer: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const headers: SignedField[] = [
    { name: 'From', value: 'alice@example.com' },
    { name: 'Subject', value: 'signed message' },
    { name: 'Date', value: 'Wed, 15 Jul 2026 09:30:00 +0000' },
  ];
  const body = Buffer.from('This is the signed body.\r\n', 'latin1');
  const signed = signMessage({ domain: 'example.com', selector: 'sel', headerCanon: 'relaxed', bodyCanon: 'relaxed', signedHeaders: headers, body, privateKey });
  assert.ok(signed.ok, 'signing succeeds');
  const message = Buffer.from(
    `DKIM-Signature: ${(signed as { header: string }).header}\r\n` + headers.map((h) => `${h.name}: ${h.value}`).join('\r\n') + '\r\n\r\n' + body.toString('latin1'),
    'latin1',
  );
  return { message, publicKeyDer: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

const keyRecord = (der: string): Buffer => Buffer.from(`v=DKIM1; k=rsa; p=${der}`, 'latin1');

// A shared RSA keypair for the algorithm-downgrade test (below), so both the sha1 and the
// sha256 signature are made with the SAME key the resolver returns.
const signKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

test('a valid DKIM signature verifies as pass', async () => {
  const { message, publicKeyDer } = signedMessage();
  const out = await verifyDkim(message, async () => keyRecord(publicKeyDer));
  assert.equal(out.verdict, 'pass');
  assert.equal(out.domain, 'example.com');
});

test('a tampered body fails the body hash', async () => {
  const { message, publicKeyDer } = signedMessage();
  const tampered = Buffer.from(message.toString('latin1').replace('signed body', 'TAMPERED'), 'latin1');
  assert.equal((await verifyDkim(tampered, async () => keyRecord(publicKeyDer))).verdict, 'fail');
});

test('a signature verified against the wrong key fails', async () => {
  const { message } = signedMessage();
  const { publicKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrong = keyRecord(other.export({ type: 'spki', format: 'der' }).toString('base64'));
  assert.equal((await verifyDkim(message, async () => wrong)).verdict, 'fail');
});

test('a missing key record is a permerror; a DNS error is a temperror', async () => {
  const { message } = signedMessage();
  assert.equal((await verifyDkim(message, async () => null)).verdict, 'permerror');
  assert.equal(
    (
      await verifyDkim(message, async () => {
        throw new Error('SERVFAIL');
      })
    ).verdict,
    'temperror',
  );
});

test('RFC 8301: a valid rsa-sha1 DKIM signature is rejected (SHA-1 is broken), sha256 passes', async () => {
  const { createSign } = await import('node:crypto');
  const { buildSigningInput } = await import('../crypto/dkim-verify.ts');
  // Build a genuinely VALID signature over the message, differing only in the hash algorithm,
  // so the test proves the algorithm is what's rejected — not a malformed signature.
  const build = (algo: 'sha1' | 'sha256'): Buffer => {
    const { privateKey } = signKeys;
    const body = Buffer.from('Hello world\r\n', 'latin1');
    const bh = computeBodyHash(body, 'relaxed', algo);
    const sigValue = `v=1; a=rsa-${algo}; c=relaxed/relaxed; d=example.com; s=sel; h=from; bh=${bh}; b=`;
    const input = buildSigningInput([{ name: 'From', value: 'a@example.com' }], sigValue, 'relaxed');
    const s = createSign(algo === 'sha1' ? 'RSA-SHA1' : 'RSA-SHA256');
    s.update(input);
    s.end();
    const b = s.sign(privateKey).toString('base64');
    return Buffer.from(`DKIM-Signature: ${sigValue}${b}\r\nFrom: a@example.com\r\nSubject: t\r\n\r\nHello world\r\n`, 'latin1');
  };
  const der = signKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  // rsa-sha1 must fail even though the signature is cryptographically valid for the key.
  assert.equal((await verifyDkim(build('sha1'), async () => keyRecord(der))).verdict, 'fail', 'rsa-sha1 rejected');
  // Negative control: the identical construction with rsa-sha256 passes (the rejection is
  // specific to sha1, and the test harness genuinely produces a verifiable signature).
  assert.equal((await verifyDkim(build('sha256'), async () => keyRecord(der))).verdict, 'pass', 'sha256 still verifies');
});

test('DKIM simple header canon is verbatim: no false-pass on whitespace-tampered headers, no false-fail on legit spacing', async () => {
  const { createSign } = await import('node:crypto');
  const { buildSigningInput } = await import('../crypto/dkim-verify.ts');
  const der = signKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const body = Buffer.from('Hi\r\n', 'latin1');
  const bh = computeBodyHash(body, 'simple', 'sha256');

  // Sign c=simple/simple over From + Subject given the EXACT signed-field octets (raw).
  const signSimple = (fromRaw: string, subjectRaw: string): string => {
    const sigBase = `v=1; a=rsa-sha256; c=simple/simple; d=example.com; s=sel; h=from:subject; bh=${bh}; b=`;
    const fields = [
      { name: 'From', value: '', raw: Buffer.from(fromRaw, 'latin1') },
      { name: 'Subject', value: '', raw: Buffer.from(subjectRaw, 'latin1') },
    ];
    const input = buildSigningInput(fields, sigBase, 'simple');
    const s = createSign('RSA-SHA256');
    s.update(input);
    s.end();
    return sigBase + s.sign(signKeys.privateKey).toString('base64');
  };
  const assemble = (sig: string, fromWire: string, subjectWire: string): Buffer =>
    Buffer.from(`DKIM-Signature: ${sig}\r\n${fromWire}\r\n${subjectWire}\r\n\r\n${body.toString('latin1')}`, 'latin1');
  const FROM = 'From: a@example.com';

  // (1) Legit: the odd-spaced Subject the signer signed is exactly what is on the wire → PASS.
  const oddSubject = 'Subject:   Hello World  ';
  const legit = assemble(signSimple(FROM, oddSubject), FROM, oddSubject);
  assert.equal((await verifyDkim(legit, async () => keyRecord(der))).verdict, 'pass', 'legit odd-spaced simple-canon header verifies');

  // (2) Forgery: signer signed the canonical single-space Subject; attacker widens the whitespace
  //     on the wire. Verbatim hashing must FAIL (the old trimmed rebuild collapsed it back → pass).
  const tampered = assemble(signSimple(FROM, 'Subject: Hello World'), FROM, 'Subject:      Hello World      ');
  assert.equal((await verifyDkim(tampered, async () => keyRecord(der))).verdict, 'fail', 'whitespace-tampered signed header must not verify');
});

test('an unsigned message is "none"', async () => {
  const out = await verifyDkim(Buffer.from('Subject: hi\r\n\r\nno signature\r\n', 'latin1'), async () => null);
  assert.equal(out.verdict, 'none');
});

test('an Ed25519 (RFC 8463) signature verifies too', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { signEd25519, rawPublicKey } = await import('../crypto/dkim-ed25519.ts');
  const { computeBodyHash } = await import('../crypto/dkim-bodyhash.ts');
  const { buildSigningInput } = await import('../crypto/dkim-verify.ts');

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signedHeaders = [
    { name: 'From', value: 'alice@example.com' },
    { name: 'Subject', value: 'ed25519' },
  ];
  const body = Buffer.from('ed body\r\n', 'latin1');
  const bh = computeBodyHash(body, 'relaxed', 'sha256');
  const h = signedHeaders.map((f) => f.name.toLowerCase()).join(':');
  const sigValue = `v=1; a=ed25519-sha256; c=relaxed/relaxed; d=example.com; s=ed; h=${h}; bh=${bh}; b=`;
  const b = signEd25519(buildSigningInput(signedHeaders, sigValue, 'relaxed'), privateKey);
  const message = Buffer.from(
    `DKIM-Signature: ${sigValue}${b}\r\n` + signedHeaders.map((f) => `${f.name}: ${f.value}`).join('\r\n') + '\r\n\r\n' + body.toString('latin1'),
    'latin1',
  );
  const resolve = async (): Promise<Buffer> => Buffer.from(`v=DKIM1; k=ed25519; p=${rawPublicKey(publicKey)}`, 'latin1');
  assert.equal((await verifyDkim(message, resolve)).verdict, 'pass');
  const tampered = Buffer.from(message.toString('latin1').replace('ed body', 'TAMPERED'), 'latin1');
  assert.equal((await verifyDkim(tampered, resolve)).verdict, 'fail');
});

test('with multiple signatures, the message passes if ANY signature verifies (RFC 6376 §6.1)', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const good = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const headers: SignedField[] = [
    { name: 'From', value: 'alice@example.com' },
    { name: 'Subject', value: 'multi' },
  ];
  const body = Buffer.from('multi body\r\n', 'latin1');
  const sigOther = signMessage({ domain: 'other.test', selector: 's', headerCanon: 'relaxed', bodyCanon: 'relaxed', signedHeaders: headers, body, privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey });
  const sigGood = signMessage({ domain: 'example.com', selector: 's', headerCanon: 'relaxed', bodyCanon: 'relaxed', signedHeaders: headers, body, privateKey: good.privateKey });
  assert.ok(sigOther.ok && sigGood.ok);
  // Two signatures stacked; the first (other.test) will be checked against a wrong key.
  const message = Buffer.from(
    `DKIM-Signature: ${(sigOther as { header: string }).header}\r\nDKIM-Signature: ${(sigGood as { header: string }).header}\r\n` +
      headers.map((h) => `${h.name}: ${h.value}`).join('\r\n') +
      '\r\n\r\n' +
      body.toString('latin1'),
    'latin1',
  );
  const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const right = good.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const out = await verifyDkim(message, async (d) => Buffer.from(`v=DKIM1; k=rsa; p=${d === 'example.com' ? right : wrong}`, 'latin1'));
  assert.equal(out.verdict, 'pass', 'the valid example.com signature wins');
  assert.equal(out.domain, 'example.com', 'the passing domain is reported');
  assert.deepEqual([...out.passedDomains], ['example.com'], 'passedDomains lists the aligned domain for DMARC');
});

test('DoS defense: at most MAX_DKIM_SIGNATURES signatures are verified per message', async () => {
  // An unauthenticated sender can pack a message with thousands of DKIM-Signature
  // headers; each triggers a full-body hash before any DNS lookup, freezing the single
  // event-loop thread for minutes. The cap bounds that. Every signature here is VALID
  // (same key, same body), so each one PROCESSED reaches the DNS resolver — counting the
  // resolver calls proves at most MAX are processed even though MAX+5 are present.
  const k = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const headers: SignedField[] = [{ name: 'From', value: 'alice@example.com' }, { name: 'Subject', value: 'flood' }];
  const body = Buffer.from('flood body\r\n', 'latin1');
  const signed = signMessage({ domain: 'example.com', selector: 's', headerCanon: 'relaxed', bodyCanon: 'relaxed', signedHeaders: headers, body, privateKey: k.privateKey });
  assert.ok(signed.ok);
  const sigLine = `DKIM-Signature: ${(signed as { header: string }).header}`;
  const headerBlock = headers.map((h) => `${h.name}: ${h.value}`).join('\r\n') + '\r\n\r\n' + body.toString('latin1');
  const message = Buffer.from(Array(MAX_DKIM_SIGNATURES + 5).fill(sigLine).join('\r\n') + '\r\n' + headerBlock, 'latin1');
  let calls = 0;
  const out = await verifyDkim(message, async () => {
    calls++;
    return keyRecord(der);
  });
  assert.ok(calls <= MAX_DKIM_SIGNATURES, `resolver called ${calls} times; cap is ${MAX_DKIM_SIGNATURES}`);
  assert.equal(out.verdict, 'pass', 'a valid signature within the cap still passes');
});

test('a valid signature buried past the cap is not reached (negative control for the cap)', async () => {
  const k = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const headers: SignedField[] = [{ name: 'From', value: 'alice@example.com' }, { name: 'Subject', value: 'buried' }];
  const body = Buffer.from('buried body\r\n', 'latin1');
  const signed = signMessage({ domain: 'example.com', selector: 's', headerCanon: 'relaxed', bodyCanon: 'relaxed', signedHeaders: headers, body, privateKey: k.privateKey });
  assert.ok(signed.ok);
  const validLine = `DKIM-Signature: ${(signed as { header: string }).header}`;
  // A minimal well-formed but bogus signature (wrong bh) — reaches the body-hash step and fails there.
  const bogusLine = 'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; b=AAAA; bh=AAAA; d=bogus.test; s=s; h=from';
  const headerBlock = headers.map((h) => `${h.name}: ${h.value}`).join('\r\n') + '\r\n\r\n' + body.toString('latin1');
  const resolve = async (): Promise<Buffer> => keyRecord(der);
  // MAX bogus signatures, then the valid one at position MAX+1 — the cap stops before it.
  const buried = Buffer.from(Array(MAX_DKIM_SIGNATURES).fill(bogusLine).join('\r\n') + '\r\n' + validLine + '\r\n' + headerBlock, 'latin1');
  assert.notEqual((await verifyDkim(buried, resolve)).verdict, 'pass', 'a signature past the cap must not rescue the verdict');
  // Control: the SAME valid signature one slot earlier (within the cap) passes.
  const withinCap = Buffer.from(Array(MAX_DKIM_SIGNATURES - 1).fill(bogusLine).join('\r\n') + '\r\n' + validLine + '\r\n' + headerBlock, 'latin1');
  assert.equal((await verifyDkim(withinCap, resolve)).verdict, 'pass', 'the same signature within the cap is verified');
});

test('an l= exceeding the body length is rejected before the DNS key fetch (RFC 6376 §3.5)', async () => {
  const der = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const body = Buffer.from('short body\r\n', 'latin1');
  const bodyLen = canonicalizedBodyLength(body, 'relaxed');
  const headerBlock = 'From: a@example.com\r\nSubject: s\r\n\r\n' + body.toString('latin1');
  const mkMessage = (l: number, bh: string): Buffer =>
    Buffer.from(`DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=s; h=from:subject; l=${l}; bh=${bh}; b=AAAA\r\n${headerBlock}`, 'latin1');

  // Overlong l=: the guard fails it before any DNS lookup (resolver never called).
  let overlongCalls = 0;
  const overlong = await verifyDkim(mkMessage(999999, computeBodyHash(body, 'relaxed', 'sha256')), async () => {
    overlongCalls++;
    return keyRecord(der);
  });
  assert.equal(overlong.verdict, 'fail');
  assert.equal(overlongCalls, 0, 'an overlong l= must be rejected before the DNS key fetch');

  // Control: a valid l= (== body length) with a matching bh passes the body-hash step and
  // DOES reach the resolver — proving the guard fires on the length, not indiscriminately.
  let validCalls = 0;
  await verifyDkim(mkMessage(bodyLen, computeBodyHash(body, 'relaxed', 'sha256', bodyLen)), async () => {
    validCalls++;
    return keyRecord(der);
  });
  assert.ok(validCalls >= 1, 'a valid l= must not be blocked by the overlong-l= guard');
});

test('a signature that does not cover the From header is rejected (RFC 6376 §5.4)', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const k = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const body = Buffer.from('body\r\n', 'latin1');
  // Sign only Subject — leaving From unsigned and forgeable.
  const signed = signMessage({ domain: 'example.com', selector: 's', headerCanon: 'relaxed', bodyCanon: 'relaxed', signedHeaders: [{ name: 'Subject', value: 'legit' }], body, privateKey: k.privateKey });
  assert.ok(signed.ok);
  const message = Buffer.from(`DKIM-Signature: ${(signed as { header: string }).header}\r\nFrom: forged@evil.test\r\nSubject: legit\r\n\r\n${body.toString('latin1')}`, 'latin1');
  const out = await verifyDkim(message, async () => Buffer.from(`v=DKIM1; k=rsa; p=${der}`, 'latin1'));
  assert.equal(out.verdict, 'permerror', 'an unsigned From makes the signature meaningless — not a pass');
});
