/**
 * `setup` (backlog B1) — keygen safety + the round-trip proof.
 *
 * The load-bearing claim of `setup` is that its printed DKIM TXT value is exactly
 * what our own inbound verifier needs: the record must parse with
 * parseDkimKeyRecord, and a signature made with the private key must verify with
 * the key extracted from the record — for RSA and Ed25519. NEGATIVE CONTROL: the
 * same signature must FAIL against a different key's record, so the round-trip
 * can't pass vacuously.
 *
 * Keygen safety: a key is generated only when missing, written 0600, and NEVER
 * overwritten (the public half may already be published in DNS — overwriting
 * would silently break all outbound signing). The never-overwrite test is the
 * negative control for ensureDkimKey's generation path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, createSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDkimKey, dkimTxtFromPrivateKey, runSetup } from './setup.ts';
import { runOps } from './cli.ts';
import { parseDkimKeyRecord } from '../crypto/dkim-keyrecord.ts';
import { verifySignature } from '../crypto/dkim-verify.ts';
import { importEd25519PublicKey, signEd25519, verifyEd25519 } from '../crypto/dkim-ed25519.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'setup-test-'));
}

interface Captured {
  readonly out: string[];
  readonly err: string[];
  readonly io: { out(l: string): void; err(l: string): void };
}
function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l) => void out.push(l), err: (l) => void err.push(l) } };
}

test('ensureDkimKey generates a 0600 RSA key when missing, and loads (never regenerates) an existing one', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'dkim.key');
    const first = ensureDkimKey(path, 'rsa');
    assert.equal(first.generated, true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(createPrivateKey(first.pem).asymmetricKeyType, 'rsa');
    // Negative control for the generation path: a second run must return the SAME
    // key bytes and report it as existing — regeneration would orphan published DNS.
    const second = ensureDkimKey(path, 'rsa');
    assert.equal(second.generated, false);
    assert.equal(second.pem, first.pem);
    // Even asking for a different kind never touches an existing file.
    const third = ensureDkimKey(path, 'ed25519');
    assert.equal(third.generated, false);
    assert.equal(readFileSync(path, 'utf8'), first.pem);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RSA round-trip: the generated TXT parses and verifies a real signature; a different key fails it', () => {
  const dir = tmp();
  try {
    const a = ensureDkimKey(join(dir, 'a.key'), 'rsa');
    const b = ensureDkimKey(join(dir, 'b.key'), 'rsa');
    const dkim = dkimTxtFromPrivateKey(a.pem);
    assert.equal(dkim.keyType, 'rsa');

    // Parse the emitted record with the SAME parser inbound verification uses.
    const record = parseDkimKeyRecord(Buffer.from(dkim.txtValue, 'latin1'));
    assert.equal(record.valid, true);
    assert.equal(record.keyType, 'rsa');

    // Sign with the private key; verify with the key rebuilt FROM THE RECORD the
    // way dkim-inbound rebuilds it (SPKI DER from p=).
    const input = Buffer.from('dkim signing input: header hash bytes', 'latin1');
    const signer = createSign('RSA-SHA256');
    signer.update(input);
    signer.end();
    const sig = signer.sign(createPrivateKey(a.pem)).toString('base64');
    const fromRecord = createPublicKey({ key: Buffer.from(record.publicKey!, 'base64'), format: 'der', type: 'spki' });
    assert.equal(verifySignature(input, sig, fromRecord, 'RSA-SHA256'), true);

    // NEGATIVE CONTROL: key B's record must NOT verify key A's signature.
    const recordB = parseDkimKeyRecord(Buffer.from(dkimTxtFromPrivateKey(b.pem).txtValue, 'latin1'));
    const wrongKey = createPublicKey({ key: Buffer.from(recordB.publicKey!, 'base64'), format: 'der', type: 'spki' });
    assert.equal(verifySignature(input, sig, wrongKey, 'RSA-SHA256'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Ed25519 round-trip: k=ed25519, raw 32-octet p=, verifies via the RFC 8463 path; wrong key fails', () => {
  const dir = tmp();
  try {
    const a = ensureDkimKey(join(dir, 'a.key'), 'ed25519');
    const b = ensureDkimKey(join(dir, 'b.key'), 'ed25519');
    const dkim = dkimTxtFromPrivateKey(a.pem);
    assert.equal(dkim.keyType, 'ed25519');

    const record = parseDkimKeyRecord(Buffer.from(dkim.txtValue, 'latin1'));
    assert.equal(record.valid, true);
    assert.equal(record.keyType, 'ed25519');
    const point = Buffer.from(record.publicKey!, 'base64');
    assert.equal(point.length, 32); // RFC 8463: p= is the raw public point, not SPKI

    const input = Buffer.from('ed25519-sha256 signing input', 'latin1');
    const sig = signEd25519(input, createPrivateKey(a.pem));
    assert.equal(verifyEd25519(input, sig, importEd25519PublicKey(point)), true);

    // NEGATIVE CONTROL: key B's point rejects key A's signature.
    const pointB = Buffer.from(parseDkimKeyRecord(Buffer.from(dkimTxtFromPrivateKey(b.pem).txtValue, 'latin1')).publicKey!, 'base64');
    assert.equal(verifyEd25519(input, sig, importEd25519PublicKey(pointB)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSetup prints the full annotated plan and the env lines when defaults were used', () => {
  const dir = tmp();
  try {
    const keyPath = join(dir, 'dkim.key');
    const cap = capture();
    const code = runSetup(
      ['--ip', '192.0.2.7', '--host', 'mx.example.net'],
      cap.io,
      { MAIL_DOMAIN: 'example.net', MAIL_DKIM_KEY: keyPath }, // selector defaulted
    );
    assert.equal(code, 0);
    const text = cap.out.join('\n');
    assert.match(text, /^example\.net\.\tIN\tMX\t10 mx\.example\.net\.$/m);
    assert.match(text, /"v=spf1 ip4:192\.0\.2\.7 -all"/);
    assert.match(text, /^mail\._domainkey\.example\.net\.\tIN\tTXT\t/m); // default selector "mail"
    assert.match(text, /"v=DMARC1; p=quarantine"/);
    assert.match(text, /reverse DNS \(PTR\): set 192\.0\.2\.7 -> mx\.example\.net/);
    assert.match(text, /newly generated/);
    assert.match(text, new RegExp(`MAIL_DKIM_SELECTOR=mail$`, 'm')); // env guidance printed
    assert.deepEqual(cap.err, []);

    // Re-run: deterministic regeneration from the EXISTING key — the DKIM line is
    // identical (this is what makes the output diffable against published DNS).
    const cap2 = capture();
    assert.equal(runSetup(['--ip', '192.0.2.7', '--host', 'mx.example.net'], cap2.io, { MAIL_DOMAIN: 'example.net', MAIL_DKIM_KEY: keyPath }), 0);
    const dkimLine = (lines: string[]): string => lines.find((l) => l.startsWith('mail._domainkey.'))!;
    assert.equal(dkimLine(cap2.out), dkimLine(cap.out));
    assert.match(cap2.out.join('\n'), /existing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSetup refuses to run without a real domain (exit 2, nothing generated)', () => {
  const cap = capture();
  assert.equal(runSetup([], cap.io, {}), 2);
  assert.match(cap.err.join('\n'), /MAIL_DOMAIN/);
  assert.deepEqual(cap.out, []);
});

test('runSetup rejects a DKIM selector that would traverse the key-file path (run-6)', () => {
  const cap = capture();
  // The selector defaults into the key filename `dkim-<selector>.key`; a traversal value must
  // be refused (exit 2) before any file is written, not steer the writeFileSync location.
  assert.equal(runSetup([], cap.io, { MAIL_DOMAIN: 'example.net', MAIL_DKIM_SELECTOR: '../../etc/evil' }), 2);
  assert.equal(runSetup([], cap.io, { MAIL_DOMAIN: 'example.net', MAIL_DKIM_SELECTOR: 'a/b' }), 2);
  assert.match(cap.err.join('\n'), /selector/i);
  // A normal dotted selector is still accepted (no false rejection) — needs a writable key path.
  const dir = mkdtempSync(join(tmpdir(), 'setup-sel-'));
  try {
    assert.equal(runSetup([], capture().io, { MAIL_DOMAIN: 'example.net', MAIL_DKIM_SELECTOR: 'mail.jul2026', MAIL_DKIM_KEY: join(dir, 'k.key') }), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSetup rejects a bad --dmarc-policy and an unknown flag with exit 2', () => {
  const a = capture();
  assert.equal(runSetup(['--dmarc-policy', 'delete-everything'], a.io, { MAIL_DOMAIN: 'example.net' }), 2);
  const b = capture();
  assert.equal(runSetup(['--frobnicate'], b.io, { MAIL_DOMAIN: 'example.net' }), 2);
});

test('an existing but unusable key file is a config error, not a crash or an overwrite', () => {
  const dir = tmp();
  try {
    const keyPath = join(dir, 'dkim.key');
    writeFileSync(keyPath, 'this is not a PEM key');
    const cap = capture();
    const code = runSetup([], cap.io, { MAIL_DOMAIN: 'example.net', MAIL_DKIM_KEY: keyPath });
    assert.equal(code, 2);
    assert.equal(readFileSync(keyPath, 'utf8'), 'this is not a PEM key'); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runOps routes setup, help, and rejects unknown commands', async () => {
  const help = capture();
  assert.equal(await runOps(['help'], help.io, {}), 0);
  assert.match(help.out.join('\n'), /setup/);
  const unknown = capture();
  assert.equal(await runOps(['launch-missiles'], unknown.io, {}), 2);
  assert.match(unknown.err.join('\n'), /unknown command/);
  const setup = capture();
  assert.equal(await runOps(['setup'], setup.io, {}), 2); // no domain → setup's own config error
});
