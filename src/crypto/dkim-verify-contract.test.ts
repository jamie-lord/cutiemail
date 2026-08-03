/**
 * RFC 6376 §6.1 to §6.1.3 — the DKIM verification contract, driven end to end.
 *
 * A real RSA keypair and a genuinely valid signature, rebuilt from scratch for each case with one
 * tag set to the value under test. That shape is load-bearing rather than stylistic: the
 * DKIM-Signature header is itself covered by the signature (with `b=` emptied), so EDITING a tag on
 * an already-signed message invalidates the signature — and a case that edits one and then asserts
 * "must not pass" passes for the wrong reason, proving nothing about the check it names. Two of the
 * cases here were written that way first, looked green, and were hiding a real defect.
 *
 * Almost every case here is a refusal, because that is what verification is. The one to read twice
 * is the From requirement: a signature whose "h=" omits From binds nothing about who the message
 * claims to be from, so accepting it lets an attacker lift a valid signature and replace the
 * visible sender — and since DMARC aligns against the "d=" of a PASSING signature, that is an
 * aligned pass on a domain publishing p=reject.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { verifyDkim, type DkimKeyResolver } from '../server/dkim-inbound.ts';
import { parseMessage } from '../message/parse.ts';
import { buildSigningInput, selectSignedFields } from './dkim-verify.ts';
import { computeBodyHash } from './dkim-bodyhash.ts';
import { cryptoRequirement, type CryptoRequirementId } from '../register/crypto/index.ts';

const cites = (id: CryptoRequirementId): void => assert.ok(cryptoRequirement(id).id === id);

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_DER = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const MESSAGE = Buffer.from(
  ['From: Alice <alice@example.test>', 'To: bob@two.example', 'Subject: a signed message', '', 'the body', ''].join('\r\n'),
  'latin1',
);

/** A key record resolver returning `record`, or null to mean "no such record". */
const keyRecord = (record: string | null): DkimKeyResolver => async () => (record === null ? null : Buffer.from(record, 'latin1'));

const GOOD_KEY = `v=DKIM1; k=rsa; p=${PUBLIC_DER}`;

/**
 * Sign MESSAGE with an arbitrary DKIM-Signature tag list.
 *
 * Signing from scratch rather than mutating an already-signed message, and the difference is the
 * whole point of this file. The DKIM-Signature header is itself part of what the signature covers
 * (with `b=` emptied), so editing ANY tag of a signed message invalidates the signature — which
 * means a case that mutates one and then asserts "must not pass" passes for the wrong reason and
 * proves nothing about the check it claims to exercise. Building the signature around the tags
 * under test keeps the signature valid, so the only thing that can refuse the message is the
 * requirement being tested.
 */
function signWith(tags: Record<string, string | null>, rawExtra?: string): Buffer {
  const { headers, body } = parseMessage(MESSAGE);
  const base: Record<string, string | null> = {
    v: '1',
    a: 'rsa-sha256',
    c: 'relaxed/relaxed',
    d: 'example.test',
    s: 'sel',
    h: 'from:to:subject',
    bh: computeBodyHash(body, 'relaxed', 'sha256'),
    ...tags,
  };
  const order = ['v', 'a', 'c', 'd', 's', 'h', 'i', 'bh', 'x', 't', 'l'];
  const present = order.filter((k) => base[k] !== null && base[k] !== undefined);
  // `rawExtra` injects a verbatim component into the tag-list BEFORE `b=`, so it is covered by the
  // signature — the only way to exercise a parser-level structural refusal (e.g. a tag-spec with no
  // "=") without editing already-signed bytes, which would make the crypto do the refusing instead.
  const tagList = present.map((k) => `${k}=${base[k]}`).join('; ');
  const value = `${rawExtra === undefined ? tagList : `${tagList}; ${rawExtra}`}; b=`;

  const hNames = (base.h ?? '').split(':').map((n) => n.trim()).filter((n) => n.length > 0);
  const input = buildSigningInput(selectSignedFields(headers, hNames), value, 'relaxed');
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  const b = signer.sign(privateKey).toString('base64');
  return Buffer.concat([Buffer.from(`DKIM-Signature: ${value}${b}\r\n`, 'latin1'), MESSAGE]);
}

/** The baseline: exactly the tags a conformant signer emits, and nothing broken. */
const signed = (): Buffer => signWith({});

test('the baseline signature verifies, so every mutation below is the thing being tested', async () => {
  cites('R-6376-6.1.3-c');
  const outcome = await verifyDkim(signed(), keyRecord(GOOD_KEY));
  assert.equal(outcome.verdict, 'pass', 'a message signed by our own signer verifies against its key');
  assert.deepEqual(outcome.passedDomains, ['example.test']);
});

test('a signature that does not cover From is refused', async () => {
  cites('R-6376-6.1.1-f');
  // The spoofing primitive. Strip From from h= and leave everything else intact: the signature is
  // then cryptographically valid over what it does cover, and covers nothing that identifies the
  // author.
  const outcome = await verifyDkim(signWith({ h: 'to:subject' }), keyRecord(GOOD_KEY));
  assert.notEqual(outcome.verdict, 'pass', 'a signature not covering From must never pass');
  assert.deepEqual(outcome.passedDomains, [], 'and must contribute no domain for DMARC to align against');
});

test('an unknown signature version is refused', async () => {
  cites('R-6376-6.1.1-b');
  // Found only after the harness was changed to SIGN around the tag under test. Editing v= on an
  // already-signed message invalidates its signature, so the earlier form of this case was green
  // for the wrong reason and hid the fact that v=2 verified.
  for (const version of ['2', '0', '1.0', '01', '']) {
    const outcome = await verifyDkim(signWith({ v: version }), keyRecord(GOOD_KEY));
    assert.equal(outcome.verdict, 'permerror', `v=${version} is not a version we implement`);
    assert.deepEqual(outcome.passedDomains, [], `and attributes no domain: v=${version}`);
  }
  // The negative control: v=1, signed identically, still passes — so the five above are refused
  // for their version and not because the harness broke them.
  assert.equal((await verifyDkim(signWith({ v: '1' }), keyRecord(GOOD_KEY))).verdict, 'pass');
});

test('a signature missing any required tag is refused, one tag at a time', async () => {
  cites('R-6376-6.1.1-c');
  // v, a, b, bh, d, h and s are required by §3.5. Each omission removes a different constraint —
  // no d= leaves nothing to attribute a pass to, no bh= leaves the body unbound — so they are
  // exercised individually rather than through one representative.
  for (const tag of ['v', 'a', 'bh', 'd', 'h', 's']) {
    const outcome = await verifyDkim(signWith({ [tag]: null }), keyRecord(GOOD_KEY));
    assert.notEqual(outcome.verdict, 'pass', `a signature with no "${tag}=" must not pass`);
  }
  // "b=" cannot be signed around — it is where the signature goes — so it is removed afterwards.
  // That is sound here: an absent b= is a syntax error decided before any crypto runs.
  const noB = Buffer.from(signed().toString('latin1').replace(/; b=[^\r\n]*/, ''), 'latin1');
  assert.notEqual((await verifyDkim(noB, keyRecord(GOOD_KEY))).verdict, 'pass', 'a signature with no "b=" must not pass');
});

test('an i= outside the signing domain is refused', async () => {
  cites('R-6376-6.1.1-e');
  // "Same as or a parent domain of". The second case is the trap: a suffix comparison that forgets
  // the label boundary accepts an attacker-controlled domain that merely ends with ours.
  for (const identity of ['@two.example', '@example.test.attacker.test', '@notexample.test']) {
    const outcome = await verifyDkim(signWith({ i: identity }), keyRecord(GOOD_KEY));
    assert.notEqual(outcome.verdict, 'pass', `d=example.test must not sign for i=${identity}`);
  }
  // The negative control that stops the three above passing for the wrong reason: a legitimate
  // subdomain identity, signed the same way, must still verify.
  const sub = await verifyDkim(signWith({ i: '@mail.example.test' }), keyRecord(GOOD_KEY));
  assert.equal(sub.verdict, 'pass', 'a subdomain identity under the signing domain is legitimate');
});

test('a structurally malformed signature is refused rather than salvaged', async () => {
  cites('R-6376-6.1.1-a');
  // "Meticulously" is the RFC's own word, and it is there because a lenient parser is how a verifier
  // ends up disagreeing with the signer about what was signed — and any such disagreement is
  // exploitable. Each of these is SIGNED AROUND the malformed shape (never edited after signing), so
  // the signature is valid over the bytes and the only thing that can refuse the message is the
  // parser's structural validation, not the crypto.
  const cases: ReadonlyArray<readonly [string, Buffer]> = [
    // The tag-spec with no "=" (RFC 6376 §3.2). This case used to EDIT an already-signed header
    // (`; s=sel;` → `; s=sel; brokentag;`), which invalidated the signature — so the crypto refused
    // it and the assertion passed while the parser was in fact silently SKIPPING `brokentag`
    // (salvage). Signing the malformed component in via `rawExtra` proves the parser refuses it.
    ['a tag-spec with no "=" separator', signWith({}, 'brokentag')],
    ['a duplicated required tag', signWith({ d: 'example.test; d=attacker.test' })],
    ['bh= that is not base64', signWith({ bh: '!!!!' })],
    ['an empty h= list', signWith({ h: '' })],
  ];
  for (const [why, message] of cases) {
    const outcome = await verifyDkim(message, keyRecord(GOOD_KEY));
    assert.notEqual(outcome.verdict, 'pass', `a signature with ${why} must not pass`);
    assert.deepEqual(outcome.passedDomains, [], `and must attribute nothing: ${why}`);
  }
  // The negative control that stops the tag-spec case passing for the wrong reason: a WELL-FORMED
  // extra tag-spec, signed the same way, is an unknown tag §3.5 says to ignore — so the message
  // still verifies. The refusal above is therefore the missing "=", not merely the extra component.
  assert.equal((await verifyDkim(signWith({}, 'goodtag=x'), keyRecord(GOOD_KEY))).verdict, 'pass', 'a well-formed unknown tag is ignored, not fatal');
});

test('a signature naming an algorithm that does not exist is refused', async () => {
  cites('R-6376-6.1.1-a');
  // The failure this replaces was a SILENT FALLBACK: "a=" was read by suffix, so anything not
  // ending "sha1" was treated as SHA-256 and verified. `a=rsa-sha999` therefore passed — the
  // signer stated one algorithm and the verifier used another, which is the signer/verifier
  // disagreement the "meticulously validate" requirement exists to prevent, resolved in the one
  // direction that hands out a pass.
  for (const algorithm of ['rsa-sha999', 'rsa-sha512', 'sha256', 'rsa', 'ed25519-sha512', '']) {
    const outcome = await verifyDkim(signWith({ a: algorithm }), keyRecord(GOOD_KEY));
    assert.equal(outcome.verdict, 'permerror', `a=${algorithm} names no algorithm we implement`);
  }
  // rsa-sha1 is the case that must NOT be swept up here. It is a real algorithm that RFC 8301
  // makes a verification failure, and the two answers differ: `fail` says the signature is well
  // formed and cryptographically refused, `permerror` says it is malformed. A closed algorithm set
  // that dropped rsa-sha1 would collapse the distinction and bypass the dedicated SHA-1 gate.
  const sha1 = await verifyDkim(signWith({ a: 'rsa-sha1' }), keyRecord(GOOD_KEY));
  assert.equal(sha1.verdict, 'fail', 'rsa-sha1 is refused as SHA-1, not as a syntax error');
});

test('an absent i= is treated as "@d", which is what makes the domain check well defined', async () => {
  cites('R-6376-6.1.1-d');
  // Most real signatures omit i=, so this is the common path rather than an edge case. Without the
  // default there would be nothing to compare d= against, and a verifier could either skip the
  // domain check entirely or invent an answer.
  const withoutIdentity = signWith({});
  assert.ok(!/;\s*i=/.test(withoutIdentity.toString('latin1').split('\r\n')[0]!), 'the baseline really has no i=');
  const implied = await verifyDkim(withoutIdentity, keyRecord(GOOD_KEY));
  assert.equal(implied.verdict, 'pass', 'it verifies, so the implied @d satisfied the domain check');

  // And stating the default explicitly is equivalent — if it were not, the default is not "@d".
  const explicit = await verifyDkim(signWith({ i: '@example.test' }), keyRecord(GOOD_KEY));
  assert.equal(explicit.verdict, 'pass');
  assert.deepEqual(explicit.passedDomains, implied.passedDomains, 'the same domain is attributed either way');
});

test('a missing key record is a permanent failure, not a temporary one', async () => {
  cites('R-6376-6.1.2-b');
  const outcome = await verifyDkim(signed(), keyRecord(null));
  // PERM, not TEMP: a missing record is a definite answer, while a DNS failure is not. Collapsing
  // the two either retries forever or makes an outage look like a forgery.
  assert.notEqual(outcome.verdict, 'pass');
  assert.notEqual(outcome.verdict, 'temperror', 'an absent record is permanent, and distinguishable from a DNS failure');
});

test('a revoked key — an empty p= — fails the signature check', async () => {
  cites('R-6376-6.1.2-e');
  // The only revocation mechanism DKIM has. A verifier reading an empty p= as "no key material,
  // try something else" defeats it entirely.
  const outcome = await verifyDkim(signed(), keyRecord('v=DKIM1; k=rsa; p='));
  assert.notEqual(outcome.verdict, 'pass', 'a revoked selector must not verify');
});

test('a malformed or unusable key record is refused', async () => {
  cites('R-6376-6.1.2-a');
  cites('R-6376-6.1.2-c');
  cites('R-6376-6.1.2-f');
  for (const [record, why] of [
    ['this is not a key record at all', 'unparseable'],
    ['v=DKIM1; k=rsa; p=!!!not base64!!!', 'p= is not base64'],
    ['v=DKIM1; k=rsa; p=AAAA', 'p= is base64 but not a key'],
    ['v=DKIM1; k=ed25519; p=' + PUBLIC_DER, 'an RSA key declared as ed25519'],
  ] as const) {
    const outcome = await verifyDkim(signed(), keyRecord(record));
    assert.notEqual(outcome.verdict, 'pass', `a key record that is ${why} must not yield a pass`);
  }
});

test('a key record with an unimplemented version is ignored', async () => {
  cites('R-6376-6.1.2-d');
  // Not a defect, contrary to how this case was first recorded: parseDkimKeyRecord already refuses
  // a v= that is not DKIM1, so the key side of the version rule was in place while the signature
  // side (R-6376-6.1.1-b, above) was missing. Kept as the pin, and widened — the record must be
  // ignored whether the version is unknown, or known but not first, which the §3.6.1 grammar also
  // requires and which a tag-order-insensitive parser would drop.
  for (const record of [`v=DKIM99; k=rsa; p=${PUBLIC_DER}`, `v=; k=rsa; p=${PUBLIC_DER}`, `k=rsa; v=DKIM1; p=${PUBLIC_DER}`]) {
    const outcome = await verifyDkim(signed(), keyRecord(record));
    assert.equal(outcome.verdict, 'permerror', `a key record we do not understand authenticates nothing: ${record.slice(0, 24)}`);
  }
  // The negative control: the same key, declared correctly, does verify — so the three above are
  // refused for their version field and not because the key material is unusable.
  assert.equal((await verifyDkim(signed(), keyRecord(GOOD_KEY))).verdict, 'pass');
});

test('a tampered body fails the body hash, and a tampered signed header fails the signature', async () => {
  cites('R-6376-6.1.3-b');
  cites('R-6376-6.1.3-c');
  const original = signed().toString('latin1');

  const bodyChanged = Buffer.from(original.replace('the body', 'a different body'), 'latin1');
  assert.notEqual((await verifyDkim(bodyChanged, keyRecord(GOOD_KEY))).verdict, 'pass', 'the body hash binds the content');

  const headerChanged = Buffer.from(original.replace('Subject: a signed message', 'Subject: a forged subject'), 'latin1');
  assert.notEqual((await verifyDkim(headerChanged, keyRecord(GOOD_KEY))).verdict, 'pass', 'the signature binds the signed headers');
});

test('header names in h= are matched case-insensitively', async () => {
  cites('R-6376-6.1.3-a');
  // Header field names are case-insensitive everywhere else in mail. A verifier comparing them
  // exactly here fails every signature listing "from" against a message writing "From".
  assert.equal(
    (await verifyDkim(signWith({ h: 'FROM:TO:SUBJECT' }), keyRecord(GOOD_KEY))).verdict,
    'pass',
    'h=FROM:TO:SUBJECT still matches From:, To: and Subject:',
  );
});

test('a bad signature alongside no good one is the same as no signature at all', async () => {
  cites('R-6376-6.1-b');
  cites('R-6376-6.1-a');
  // Replacing only the b= value is the one edit that is legitimate on a signed message: b= is
  // excluded from what the signature covers, so this produces a well-formed signature that simply
  // does not verify — exactly the case under test.
  const broken = Buffer.from(signed().toString('latin1').replace(/(; b=)[^\r\n]*/, '$1AAAA'), 'latin1');
  const outcome = await verifyDkim(broken, keyRecord(GOOD_KEY));
  // A broken signature is not evidence in either direction, and must not attribute a domain: a
  // downstream DMARC evaluation aligning against a FAILED signature's d= would be exploitable.
  assert.deepEqual(outcome.passedDomains, [], 'a failed signature contributes no domain');
  assert.notEqual(outcome.verdict, 'pass');
});

test('a message with several signatures passes if any one of them does, whatever the order', async () => {
  cites('R-6376-6.1-a');
  const valid = signed().toString('latin1');
  const sigLine = /^DKIM-Signature:[\s\S]*?\r\n(?=[^ \t])/m.exec(valid)?.[0];
  assert.ok(sigLine !== undefined);
  const bogus = 'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=attacker.test; s=x; h=from:subject; bh=AAAA; b=AAAA\r\n';

  // The order says nothing: prepending a signature an attacker controls must not shadow the real
  // one, and must not be reported as the passing domain.
  for (const message of [bogus + valid, valid.replace(sigLine, sigLine + bogus)]) {
    const outcome = await verifyDkim(Buffer.from(message, 'latin1'), keyRecord(GOOD_KEY));
    assert.equal(outcome.verdict, 'pass', 'the genuine signature is found wherever it sits');
    assert.deepEqual(outcome.passedDomains, ['example.test'], 'and only it is reported as passing');
  }
});
