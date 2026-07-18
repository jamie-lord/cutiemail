/**
 * `doctor` — the live preflight / drift check (backlog B2).
 *
 * The evidence (docs/BACKLOG.md): the deepest fear in self-hosted email is drift —
 * "Gmail accepted my emails fine... until one day it didn't" — and the classic
 * first-deploy failure is an outbound port 25 the provider silently blocks. Mox
 * pre-flights these once, at quickstart; `doctor` is re-runnable at any time and
 * checks the deployment against live DNS and the network:
 *
 *   mx        the domain's MX points at this host
 *   address   the host resolves (A/AAAA)
 *   fcrdns    each address reverse-resolves back to the host (Gmail checks this)
 *   spf       the published SPF authorises each address — evaluated by OUR OWN
 *             RFC 7208 evaluator, not a reimplementation
 *   dkim      the published DKIM TXT contains exactly this server's public key
 *   dmarc     a DMARC policy is published and parses
 *   tls       the certificate covers the host, matches the private key, isn't
 *             expired or about to be
 *   dial-25   outbound port 25 actually reaches a real MX (greeting read)
 *   age       RDAP domain registration age (young domains get spam-foldered)
 *
 * Every check reads through an injected dependency seam, so the tests drive each
 * one in BOTH directions: detects the broken state, passes the healthy one.
 * Exit codes: 0 = no failures (warnings allowed), 1 = at least one failure,
 * 2 = usage/config error.
 */

import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve4, resolve6, resolveMx, resolveTxt, reverse } from 'node:dns/promises';
import { checkSpf, type SpfResolvers } from '../auth/spf-check.ts';
import { parseDmarcRecord } from '../auth/dmarc.ts';
import { parseDkimKeyRecord } from '../crypto/dkim-keyrecord.ts';
import { registeredDomain } from '../auth/public-suffix.ts';
import { dkimTxtFromPrivateKey } from './setup.ts';
import type { OpsIo } from './cli.ts';
import { sanitizeForTerminal } from './terminal.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorDeps {
  /** MX RRset for a name; [] if none. */
  readonly mx: (name: string) => Promise<readonly { exchange: string; priority: number }[]>;
  /** TXT records for a name, chunks joined; [] if none; throws on a real DNS error. */
  readonly txt: (name: string) => Promise<readonly string[]>;
  /** A + AAAA addresses for a name; [] if none. */
  readonly addr: (name: string) => Promise<readonly string[]>;
  /** PTR names for an address; [] if none, throws on error. */
  readonly ptr: (ip: string) => Promise<readonly string[]>;
  /** Connect to host:25 outbound and return the first greeting line; throws on failure. */
  readonly dial25: (host: string) => Promise<string>;
  /** RDAP JSON for a registrable domain; throws on failure. */
  readonly rdap: (registrable: string) => Promise<unknown>;
  readonly now: () => number;
}

export interface DoctorParams {
  readonly domain: string;
  readonly mailHost: string;
  readonly dkim?: { readonly selector: string; readonly privateKeyPem: string };
  readonly tls?: { readonly certPem: string; readonly keyPem?: string };
  /** Whose MX to dial for the outbound-25 probe. */
  readonly probeDomain: string;
  readonly skipDial: boolean;
}

const stripDot = (n: string): string => (n.endsWith('.') ? n.slice(0, -1) : n).toLowerCase();

/** Days until `ms` from `now`, floored. */
const daysUntil = (ms: number, now: number): number => Math.floor((ms - now) / 86_400_000);

export async function doctorChecks(p: DoctorParams, deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const push = (name: string, status: CheckStatus, detail: string): void => void results.push({ name, status, detail });

  // -- mx ---------------------------------------------------------------------
  try {
    const mxs = await deps.mx(p.domain);
    const hit = mxs.find((m) => stripDot(m.exchange) === stripDot(p.mailHost));
    if (mxs.length === 0) push('mx', 'fail', `no MX record for ${p.domain} — senders cannot find this server`);
    else if (hit === undefined) push('mx', 'fail', `MX for ${p.domain} points at ${mxs.map((m) => m.exchange).join(', ')}, not ${p.mailHost}`);
    else push('mx', 'ok', `${p.domain} MX ${hit.priority} ${stripDot(hit.exchange)}`);
  } catch (e) {
    push('mx', 'fail', `MX lookup failed: ${String(e)}`);
  }

  // -- address + fcrdns ---------------------------------------------------------
  let ips: readonly string[] = [];
  try {
    ips = await deps.addr(p.mailHost);
    if (ips.length === 0) push('address', 'fail', `${p.mailHost} has no A/AAAA record`);
    else push('address', 'ok', `${p.mailHost} -> ${ips.join(', ')}`);
  } catch (e) {
    push('address', 'fail', `address lookup failed: ${String(e)}`);
  }
  if (ips.length > 0) {
    const bad: string[] = [];
    for (const ip of ips) {
      try {
        const names = await deps.ptr(ip);
        if (!names.some((n) => stripDot(n) === stripDot(p.mailHost))) {
          bad.push(`${ip} -> ${names.length > 0 ? names.join(', ') : '(no PTR)'}`);
        }
      } catch {
        bad.push(`${ip} -> (no PTR)`);
      }
    }
    if (bad.length === 0) push('fcrdns', 'ok', `every address reverse-resolves to ${p.mailHost}`);
    else push('fcrdns', 'fail', `reverse DNS does not confirm this host: ${bad.join('; ')} — set the PTR at your provider`);
  }

  // -- spf (evaluated by the real RFC 7208 evaluator, per address) --------------
  if (ips.length > 0) {
    const spfResolvers: SpfResolvers = {
      txt: deps.txt,
      a: deps.addr,
      mx: async (name) => (await deps.mx(name)).map((m) => m.exchange),
    };
    const verdicts: string[] = [];
    let worst: 'ok' | 'warn' | 'fail' = 'ok';
    for (const ip of ips) {
      let v: string;
      try {
        v = await checkSpf(ip, p.domain, spfResolvers);
      } catch {
        v = 'temperror';
      }
      verdicts.push(`${ip}: ${v}`);
      if (v === 'temperror') worst = worst === 'fail' ? 'fail' : 'warn';
      else if (v !== 'pass') worst = 'fail';
    }
    if (worst === 'ok') push('spf', 'ok', `SPF authorises this host (${verdicts.join('; ')})`);
    else if (worst === 'warn') push('spf', 'warn', `SPF could not be evaluated right now (${verdicts.join('; ')})`);
    else push('spf', 'fail', `published SPF does not authorise this host (${verdicts.join('; ')}) — re-run setup and compare`);
  }

  // -- dkim ---------------------------------------------------------------------
  if (p.dkim === undefined) {
    push('dkim', 'warn', 'DKIM not configured (MAIL_DKIM_KEY/MAIL_DKIM_SELECTOR) — outbound mail relies on SPF alone and will be spam-foldered by big receivers');
  } else {
    const name = `${p.dkim.selector}._domainkey.${p.domain}`;
    try {
      const local = dkimTxtFromPrivateKey(p.dkim.privateKeyPem);
      const records = await deps.txt(name);
      const published = records.find((r) => r.includes('p='));
      if (published === undefined) {
        push('dkim', 'fail', `no DKIM key published at ${name} — run setup and publish the TXT record`);
      } else {
        const parsed = parseDkimKeyRecord(Buffer.from(published, 'latin1'));
        const localP = parseDkimKeyRecord(Buffer.from(local.txtValue, 'latin1')).publicKey;
        if (!parsed.valid) push('dkim', 'fail', `the record at ${name} is not usable (${parsed.anomalies.join(', ') || 'malformed'})`);
        else if (parsed.publicKey !== localP) push('dkim', 'fail', `the key published at ${name} is NOT this server's key — signatures will not verify`);
        else push('dkim', 'ok', `published key at ${name} matches the local private key (${local.keyType})`);
      }
    } catch (e) {
      push('dkim', 'fail', `DKIM check failed: ${String(e)}`);
    }
  }

  // -- dmarc ----------------------------------------------------------------------
  try {
    const records = await deps.txt(`_dmarc.${p.domain}`);
    const rec = records.find((r) => r.trim().toLowerCase().startsWith('v=dmarc1'));
    if (rec === undefined) {
      push('dmarc', 'fail', `no DMARC record at _dmarc.${p.domain} — big receivers now expect one; run setup`);
    } else {
      const parsed = parseDmarcRecord(Buffer.from(rec, 'latin1'));
      if (!parsed.valid) push('dmarc', 'fail', `the DMARC record does not parse: ${rec}`);
      else push('dmarc', 'ok', `p=${parsed.policy ?? '?'} published`);
    }
  } catch (e) {
    push('dmarc', 'fail', `DMARC lookup failed: ${String(e)}`);
  }

  // -- tls --------------------------------------------------------------------------
  if (p.tls === undefined) {
    push('tls', 'warn', 'no MAIL_TLS_CERT/MAIL_TLS_KEY configured — the daemon would fall back to the bundled self-signed dev certificate');
  } else {
    try {
      const cert = new X509Certificate(p.tls.certPem);
      const expiresMs = Date.parse(cert.validTo);
      const days = daysUntil(expiresMs, deps.now());
      const covers = cert.checkHost(p.mailHost) !== undefined;
      const keyMatches = p.tls.keyPem === undefined ? true : cert.checkPrivateKey(createPrivateKey(p.tls.keyPem));
      if (days < 0) push('tls', 'fail', `certificate EXPIRED ${-days} day(s) ago (${cert.validTo})`);
      else if (!covers) push('tls', 'fail', `certificate does not cover ${p.mailHost} (subject: ${cert.subject.replace(/\n/g, ' ')})`);
      else if (!keyMatches) push('tls', 'fail', 'certificate does not match the configured private key — check the cert/key paths');
      else if (days <= 21) push('tls', 'warn', `certificate expires in ${days} day(s) (${cert.validTo}) — renew soon; is the renewal automated?`);
      else push('tls', 'ok', `certificate covers ${p.mailHost}, valid ${days} more days (${cert.validTo})`);
    } catch (e) {
      push('tls', 'fail', `cannot read the certificate: ${String(e)}`);
    }
  }

  // -- outbound port 25 ---------------------------------------------------------------
  if (p.skipDial) {
    push('dial-25', 'skip', 'outbound port-25 probe skipped (--skip-dial)');
  } else {
    try {
      const mxs = await deps.mx(p.probeDomain);
      if (mxs.length === 0) {
        push('dial-25', 'warn', `probe domain ${p.probeDomain} has no MX — cannot test outbound 25`);
      } else {
        const target = stripDot([...mxs].sort((a, b) => a.priority - b.priority)[0]!.exchange);
        const greeting = await deps.dial25(target);
        if (greeting.startsWith('220')) push('dial-25', 'ok', `outbound port 25 works (${target} greeted)`);
        else push('dial-25', 'warn', `${target} answered but not with a 220 greeting: ${greeting.slice(0, 60)}`);
      }
    } catch (e) {
      push('dial-25', 'fail', `cannot reach a real MX on port 25 (${String(e)}) — most VPS providers block outbound 25 until you ask; without it this server cannot SEND mail`);
    }
  }

  // -- domain age (RDAP) — advisory only, never a failure -------------------------------
  const registrable = registeredDomain(p.domain) ?? p.domain;
  try {
    const json = (await deps.rdap(registrable)) as { events?: readonly { eventAction?: string; eventDate?: string }[] };
    const reg = json.events?.find((e) => e.eventAction === 'registration')?.eventDate;
    if (reg === undefined) {
      push('age', 'skip', `RDAP for ${registrable} has no registration event`);
    } else {
      const ageDays = daysUntil(deps.now(), Date.parse(reg));
      if (ageDays < 30) push('age', 'warn', `${registrable} was registered only ${ageDays} day(s) ago — young domains are spam-foldered while they build reputation`);
      else push('age', 'ok', `${registrable} registered ${reg.slice(0, 10)} (${ageDays} days ago)`);
    }
  } catch {
    push('age', 'skip', `RDAP unavailable for ${registrable} — domain age not checked`);
  }

  return results;
}

/** Render + exit-code policy: any fail -> 1, otherwise 0. */
export function reportChecks(results: readonly CheckResult[], io: OpsIo): number {
  const label: Record<CheckStatus, string> = { ok: '  ok ', warn: ' WARN', fail: ' FAIL', skip: ' skip' };
  // r.detail carries remote, spoofable bytes — an MX's SMTP greeting, a DMARC/DKIM TXT record,
  // an MX/PTR hostname — which can embed ANSI/OSC escape sequences to hijack the clipboard or
  // paint a fake verdict on the operator's terminal. Neutralise them, as queue-cli already does
  // for the identical class (audit run-6). r.name is a fixed internal label, left as-is.
  for (const r of results) io.out(`${label[r.status]}  ${r.name.padEnd(8)} ${sanitizeForTerminal(r.detail)}`);
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  io.out('');
  io.out(fails === 0 ? `doctor: healthy (${warns} warning(s))` : `doctor: ${fails} problem(s), ${warns} warning(s)`);
  return fails === 0 ? 0 : 1;
}

const USAGE = [
  'usage: node src/main.ts doctor [--domain <domain>] [--host <mailhost>]',
  '                               [--probe <domain>] [--skip-dial]',
  '',
  'Checks the deployment against live DNS and the network: MX, A/AAAA, FCrDNS,',
  'SPF (evaluated), DKIM key match, DMARC, TLS certificate, outbound port 25,',
  'and domain age. Reads the same MAIL_* environment as the daemon.',
  '  --probe      whose MX to dial for the outbound-25 test (default gmail.com)',
  '  --skip-dial  skip the outbound port-25 probe',
].join('\n');

/** Real-network dependency implementations (tests inject fakes instead). */
export function realDoctorDeps(): DoctorDeps {
  return {
    mx: async (name) => {
      try {
        return await resolveMx(name);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
        throw e;
      }
    },
    txt: async (name) => {
      try {
        return (await resolveTxt(name)).map((chunks) => chunks.join(''));
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
        throw e;
      }
    },
    addr: async (name) => {
      const out: string[] = [];
      await Promise.all([
        resolve4(name).then((r) => out.push(...r)).catch(() => {}),
        resolve6(name).then((r) => out.push(...r)).catch(() => {}),
      ]);
      return out;
    },
    ptr: async (ip) => {
      try {
        return await reverse(ip);
      } catch {
        return [];
      }
    },
    dial25: (host) =>
      new Promise<string>((res, rej) => {
        const sock = connect({ host, port: 25 });
        let buf = Buffer.alloc(0);
        const fail = (why: string): void => {
          sock.destroy();
          rej(new Error(why));
        };
        sock.setTimeout(10_000, () => fail('timeout after 10s'));
        sock.on('error', (e) => fail(e.message));
        sock.on('data', (d) => {
          buf = Buffer.concat([buf, d]);
          const nl = buf.indexOf(0x0a);
          if (nl !== -1) {
            const line = buf.subarray(0, nl).toString('latin1').replace(/\r$/, '');
            sock.end('QUIT\r\n');
            res(line);
          }
        });
      }),
    rdap: async (registrable) => {
      // Encode the domain into the path — it is operator config, but metacharacters
      // (/, ?, @, ..) must not be able to alter the request path or host.
      const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(registrable)}`, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
      if (!res.ok) throw new Error(`RDAP ${res.status}`);
      return res.json();
    },
    now: () => Date.now(),
  };
}

export async function runDoctor(args: string[], io: OpsIo, env: Record<string, string | undefined>, deps: DoctorDeps = realDoctorDeps()): Promise<number> {
  let domain = env.MAIL_DOMAIN;
  let mailHost: string | undefined;
  let probeDomain = 'gmail.com';
  let skipDial = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--domain') domain = args[++i];
    else if (a === '--host') mailHost = args[++i];
    else if (a === '--probe') probeDomain = args[++i] ?? probeDomain;
    else if (a === '--skip-dial') skipDial = true;
    else if (a === '--help' || a === '-h') {
      io.out(USAGE);
      return 0;
    } else {
      io.err(`doctor: unknown argument ${a}`);
      io.err(USAGE);
      return 2;
    }
  }
  if (domain === undefined || domain === '') {
    io.err('doctor: set MAIL_DOMAIN or pass --domain.');
    return 2;
  }
  const dkimKeyPath = env.MAIL_DKIM_KEY;
  const dkimSelector = env.MAIL_DKIM_SELECTOR;
  const certPath = env.MAIL_TLS_CERT;
  const keyPath = env.MAIL_TLS_KEY;
  let params: DoctorParams;
  try {
    params = {
      domain,
      mailHost: mailHost ?? domain,
      ...(dkimKeyPath !== undefined && dkimSelector !== undefined
        ? { dkim: { selector: dkimSelector, privateKeyPem: readFileSync(dkimKeyPath, 'utf8') } }
        : {}),
      ...(certPath !== undefined
        ? { tls: { certPem: readFileSync(certPath, 'utf8'), ...(keyPath !== undefined ? { keyPem: readFileSync(keyPath, 'utf8') } : {}) } }
        : {}),
      probeDomain,
      skipDial,
    };
  } catch (e) {
    io.err(`doctor: cannot read a configured file: ${String(e)}`);
    return 2;
  }
  io.out(`doctor: ${domain} (host ${params.mailHost})`);
  return reportChecks(await doctorChecks(params, deps), io);
}
