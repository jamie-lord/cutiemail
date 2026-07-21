/**
 * `setup` — DKIM keygen + annotated DNS record generation (backlog B1).
 *
 * The single most-praised feature of Mox in the evidence base (docs/BACKLOG.md) is
 * that it *tells you the exact DNS records*. This is our version, derived from the
 * same configuration the daemon runs on: generate a DKIM keypair if none exists
 * (never overwriting one that does — the public half may already be published),
 * derive the DKIM TXT value from the private key with the same primitives the
 * verifier uses, and print every record as annotated, copy-pasteable zone lines.
 *
 * Re-runnable at any time: with an existing key the output is deterministic, so a
 * re-run is a regeneration of the records (diffable against what is published),
 * not a mutation of anything.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rawPublicKey } from '../crypto/dkim-ed25519.ts';
import { dnsRecordsFor, renderZone, renderNotes, mtaStsSection, type DnsPlanParams } from './dns-records.ts';
import type { OpsIo } from './cli.ts';

/**
 * The DKIM public-key TXT value for a private key PEM — the exact inverse of what
 * our own inbound verifier parses (dkim-inbound: RSA p= is SPKI DER base64,
 * Ed25519 p= is the raw 32-octet point, RFC 8463).
 */
export function dkimTxtFromPrivateKey(privateKeyPem: string): { readonly keyType: 'rsa' | 'ed25519'; readonly txtValue: string } {
  const priv = createPrivateKey(privateKeyPem);
  const pub = createPublicKey(priv);
  if (priv.asymmetricKeyType === 'ed25519') {
    return { keyType: 'ed25519', txtValue: `v=DKIM1; k=ed25519; p=${rawPublicKey(pub)}` };
  }
  if (priv.asymmetricKeyType === 'rsa') {
    const der = pub.export({ type: 'spki', format: 'der' }).toString('base64');
    return { keyType: 'rsa', txtValue: `v=DKIM1; k=rsa; p=${der}` };
  }
  throw new Error(`unsupported DKIM key type: ${String(priv.asymmetricKeyType)}`);
}

/**
 * Ensure a DKIM private key exists at `path`: load it if present, generate one if
 * not. Never overwrites — `wx` fails on an existing file even under a race, since
 * the public half of an existing key may already be published in DNS.
 */
export function ensureDkimKey(path: string, kind: 'rsa' | 'ed25519'): { readonly pem: string; readonly generated: boolean } {
  if (existsSync(path)) return { pem: readFileSync(path, 'utf8'), generated: false };
  const pair = kind === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  writeFileSync(path, pem, { mode: 0o600, flag: 'wx' });
  return { pem, generated: true };
}

const USAGE = [
  'usage: node src/main.ts setup [--domain <domain>] [--host <mailhost>] [--ip <address>]...',
  '                              [--ed25519] [--dmarc-policy none|quarantine|reject]',
  '',
  'Generates a DKIM key if none exists (MAIL_DKIM_KEY, never overwritten) and prints',
  'the DNS records to publish, derived from the daemon configuration:',
  '  --domain        the mail domain (default: MAIL_DOMAIN)',
  '  --host          the machine FQDN if it differs from the domain (MX/A target)',
  '  --ip            a public address of the box (repeatable; pins SPF to ip4:/ip6:)',
  '  --ed25519       generate an Ed25519 key instead of RSA-2048 (RSA verifies everywhere;',
  '                  Ed25519 (RFC 8463) is smaller but not yet universally verified)',
  '  --dmarc-policy  the DMARC policy to publish (default: quarantine)',
].join('\n');

export function runSetup(args: string[], io: OpsIo, env: Record<string, string | undefined>): number {
  // -- flag parsing ------------------------------------------------------------
  let domain = env.MAIL_DOMAIN;
  let mailHost: string | undefined;
  const ips: string[] = [];
  let ed25519 = false;
  let dmarcPolicy: DnsPlanParams['dmarcPolicy'] = 'quarantine';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = (): string | undefined => args[++i];
    if (a === '--domain') domain = next();
    else if (a === '--host') mailHost = next();
    else if (a === '--ip') {
      const v = next();
      if (v !== undefined) ips.push(v);
    } else if (a === '--ed25519') ed25519 = true;
    else if (a === '--dmarc-policy') {
      const v = next();
      if (v !== 'none' && v !== 'quarantine' && v !== 'reject') {
        io.err(`setup: --dmarc-policy must be none|quarantine|reject, got ${String(v)}`);
        return 2;
      }
      dmarcPolicy = v;
    } else if (a === '--help' || a === '-h') {
      io.out(USAGE);
      return 0;
    } else {
      io.err(`setup: unknown argument ${a}`);
      io.err(USAGE);
      return 2;
    }
  }
  if (domain === undefined || domain === '') {
    io.err('setup: set MAIL_DOMAIN or pass --domain — generating records for a placeholder domain helps nobody.');
    return 2;
  }
  const host = mailHost ?? domain;

  // -- DKIM key ----------------------------------------------------------------
  // Defaults chosen so setup runs before any daemon config exists; when we default
  // the selector/key path, the env lines the daemon needs are printed at the end.
  const selector = env.MAIL_DKIM_SELECTOR ?? 'mail';
  // The selector becomes both a published DNS label AND (by default) the DKIM key filename
  // `dkim-<selector>.key`, so a value like `../../etc/foo` would steer the writeFileSync location.
  // Constrain it to DNS-label characters (dot-separated), which also forbids `/` and `..`.
  if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(selector)) {
    io.err(`setup: invalid DKIM selector ${JSON.stringify(selector)} — use DNS-label characters (letters, digits, hyphen; dot-separated).`);
    return 2;
  }
  const keyPath = env.MAIL_DKIM_KEY ?? `dkim-${selector}.key`;
  let key: { pem: string; generated: boolean };
  try {
    key = ensureDkimKey(keyPath, ed25519 ? 'ed25519' : 'rsa');
  } catch (e) {
    io.err(`setup: cannot read or create the DKIM key at ${keyPath}: ${String(e)}`);
    return 2;
  }
  let dkim: ReturnType<typeof dkimTxtFromPrivateKey>;
  try {
    dkim = dkimTxtFromPrivateKey(key.pem);
  } catch (e) {
    io.err(`setup: the key at ${keyPath} is not usable for DKIM: ${String(e)}`);
    return 2;
  }
  if (!key.generated && ed25519 && dkim.keyType !== 'ed25519') {
    io.err(`setup: note — an existing ${dkim.keyType} key at ${keyPath} takes precedence over --ed25519 (a key is never overwritten).`);
  }

  // -- the plan ------------------------------------------------------------------
  const plan: DnsPlanParams = { domain, mailHost: host, ips, dkim: { selector, txtValue: dkim.txtValue }, dmarcPolicy };
  io.out(`; cutie-mail DNS records for ${domain}`);
  io.out(`; DKIM key: ${resolve(keyPath)} (${dkim.keyType}, ${key.generated ? 'newly generated' : 'existing'})`);
  io.out('');
  io.out(renderZone(dnsRecordsFor(plan)));
  io.out(renderNotes(plan));
  io.out('');
  io.out(mtaStsSection(plan));
  if (env.MAIL_DKIM_KEY === undefined || env.MAIL_DKIM_SELECTOR === undefined) {
    io.out('');
    io.out('Set these in the daemon environment so outbound mail is signed with this key:');
    io.out(`  MAIL_DKIM_KEY=${resolve(keyPath)}`);
    io.out(`  MAIL_DKIM_SELECTOR=${selector}`);
  }
  return 0;
}
