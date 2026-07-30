/**
 * `doctor` — the live preflight / drift check.
 *
 * The deepest fear in self-hosted email is drift —
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
 *   spf-exclusive  ...and REFUSES an address that is not ours (a record that
 *             authorises everyone passes the check above)
 *   dkim      the published DKIM TXT contains exactly this server's public key
 *   dmarc     a DMARC policy is published, parses, and actually enforces
 *   dmarc-org when the mail domain is a subdomain, the registered domain — which
 *             is what receivers consult for our subdomains — publishes one too
 *   tls       the certificate covers the host, matches the private key, isn't
 *             expired or about to be
 *   dial-25   outbound port 25 actually reaches a real MX (greeting read)
 *   age       RDAP domain registration age (young domains get spam-foldered)
 *   sqlite    the bundled SQLite is at or above the known-corruption floor (ADR 0028)
 *
 * Every check reads through an injected dependency seam, so the tests drive each
 * one in BOTH directions: detects the broken state, passes the healthy one.
 * Exit codes: 0 = no failures (warnings allowed), 1 = at least one failure,
 * 2 = usage/config error.
 */

import { X509Certificate, createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve4, resolve6, resolveMx, resolveTxt, reverse } from 'node:dns/promises';
import { DatabaseSync } from 'node:sqlite';
import { checkSpf, type SpfResolvers } from '../auth/spf-check.ts';
import { parseDmarcRecord } from '../auth/dmarc.ts';
import { selectDmarcRecord } from '../server/dmarc-inbound.ts';
import { parseDkimKeyRecord } from '../crypto/dkim-keyrecord.ts';
import { registeredDomain } from '../auth/public-suffix.ts';
import { AccountRegistry } from '../store/account-registry.ts';
import { openMailDb, sqliteVersionAtLeast, MIN_SQLITE_VERSION } from '../store/open-mail-db.ts';
import { dkimTxtFromPrivateKey } from './setup.ts';
import type { OpsIo } from './cli.ts';
import { sanitizeForTerminalLine } from './terminal.ts';

/** Mirrors MAX_REPLY_BYTES in wire/reply.ts: a greeting is one line, not a stream. */
const MAX_GREETING_BYTES = 64 * 1024;

/**
 * The address the SPF exclusivity check evaluates from: TEST-NET-1 (RFC 5737 §3),
 * reserved for documentation and never routed, so no deployment can legitimately
 * authorise it. A published record that does NOT hard-fail this address does not
 * hard-fail an attacker either.
 */
const SPF_OUTSIDER_IP = '192.0.2.1';

/** Read a response body incrementally, abandoning it past `maxBytes`. Null if over. */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (reader === undefined || reader === null) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
  /** The running SQLite library version (e.g. "3.51.3"), for the known-corruption floor check. */
  readonly sqliteVersion: () => string;
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
    if (mxs.length === 0) push('mx', 'fail', `no MX record for ${p.domain}: senders cannot find this server`);
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
    else push('fcrdns', 'fail', `reverse DNS does not confirm this host: ${bad.join('; ')}: set the PTR at your provider`);
  }

  // -- spf (evaluated by the real RFC 7208 evaluator, per address) --------------
  const spfResolvers: SpfResolvers = {
    txt: deps.txt,
    a: deps.addr,
    mx: async (name) => (await deps.mx(name)).map((m) => m.exchange),
  };
  if (ips.length > 0) {
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
    else push('spf', 'fail', `published SPF does not authorise this host (${verdicts.join('; ')}): re-run setup and compare`);
  }

  // -- spf-exclusive ------------------------------------------------------------
  // The check above answers "does SPF authorise ME". That is only half the record's
  // job, and the half that cannot detect the failure that matters: a record ending
  // `+all` (or carrying an `include:` for a service the operator stopped using years
  // ago) authorises this host perfectly well AND authorises the entire internet. SPF
  // exists to EXCLUDE, so evaluate it from an address that is definitely not ours and
  // require a hard fail. 192.0.2.1 is TEST-NET-1 (RFC 5737 §3), reserved for
  // documentation and never routed, so it can never legitimately be a sender.
  try {
    const outsider = await checkSpf(SPF_OUTSIDER_IP, p.domain, spfResolvers);
    if (outsider === 'fail') {
      push('spf-exclusive', 'ok', `SPF rejects senders other than this host (${SPF_OUTSIDER_IP}: fail)`);
    } else if (outsider === 'pass') {
      push(
        'spf-exclusive',
        'fail',
        `published SPF authorises ${SPF_OUTSIDER_IP} — an address that is not yours and never can be: anyone on the internet passes SPF for ${p.domain}. Look for "+all", a bare "all", or an over-broad "include:"; setup publishes "-all".`,
      );
    } else if (outsider === 'softfail' || outsider === 'neutral') {
      push(
        'spf-exclusive',
        'warn',
        `published SPF only ${outsider}s other senders (${SPF_OUTSIDER_IP}), so forged mail is not refused outright: "-all" is what setup publishes and what receivers act on`,
      );
    } else {
      push('spf-exclusive', 'warn', `could not decide whether SPF excludes other senders (${SPF_OUTSIDER_IP}: ${outsider})`);
    }
  } catch (e) {
    push('spf-exclusive', 'warn', `SPF exclusivity check failed: ${String(e)}`);
  }

  // -- dkim ---------------------------------------------------------------------
  if (p.dkim === undefined) {
    push('dkim', 'warn', 'DKIM not configured (MAIL_DKIM_KEY/MAIL_DKIM_SELECTOR): outbound mail relies on SPF alone and will be spam-foldered by big receivers');
  } else {
    const name = `${p.dkim.selector}._domainkey.${p.domain}`;
    try {
      const local = dkimTxtFromPrivateKey(p.dkim.privateKeyPem);
      const records = await deps.txt(name);
      const published = records.find((r) => r.includes('p='));
      if (published === undefined) {
        push('dkim', 'fail', `no DKIM key published at ${name}: run setup and publish the TXT record`);
      } else {
        const parsed = parseDkimKeyRecord(Buffer.from(published, 'latin1'));
        const localP = parseDkimKeyRecord(Buffer.from(local.txtValue, 'latin1')).publicKey;
        if (!parsed.valid) push('dkim', 'fail', `the record at ${name} is not usable (${parsed.anomalies.join(', ') || 'malformed'})`);
        else if (parsed.publicKey !== localP) push('dkim', 'fail', `the key published at ${name} is NOT this server's key: signatures will not verify`);
        else push('dkim', 'ok', `published key at ${name} matches the local private key (${local.keyType})`);
      }
    } catch (e) {
      push('dkim', 'fail', `DKIM check failed: ${String(e)}`);
    }
  }

  // -- dmarc ----------------------------------------------------------------------
  try {
    const records = await deps.txt(`_dmarc.${p.domain}`);
    // The DAEMON's selector, not a second spelling of it: a check that answers "ok" for a zone
    // where policy discovery yields nothing is worse than no check, and this is the only place an
    // operator would ever find out.
    const { record: rec, multiple } = selectDmarcRecord(records);
    if (multiple) {
      push('dmarc', 'fail', `several DMARC records at _dmarc.${p.domain}: RFC 7489 §6.6.3 discards the whole set, so NO policy is applied — by this server or by Gmail. Publish exactly one.`);
    } else if (rec === null) {
      push('dmarc', 'fail', `no DMARC record at _dmarc.${p.domain}: big receivers now expect one; run setup`);
    } else {
      const parsed = parseDmarcRecord(Buffer.from(rec, 'latin1'));
      if (!parsed.valid) {
        push('dmarc', 'fail', `the DMARC record does not parse: ${rec}`);
      } else if (parsed.policy === 'none') {
        // Publishing a record and asking receivers to do nothing about failures is the
        // most common DMARC state on the internet and the one that protects nobody: it
        // buys reports, not enforcement. `setup` emits p=quarantine, so a deployment
        // sitting at p=none is either mid-rollout or drift that nothing else would catch.
        push(
          'dmarc',
          'warn',
          'p=none published: receivers are asked to MONITOR only, so mail forging this domain is still delivered. Once SPF and DKIM check out above, publish p=quarantine (what setup emits) or p=reject.',
        );
      } else {
        push('dmarc', 'ok', `p=${parsed.policy ?? '?'} published`);
      }
    }
  } catch (e) {
    push('dmarc', 'fail', `DMARC lookup failed: ${String(e)}`);
  }

  // -- dmarc-org ------------------------------------------------------------------
  // When the mail domain sits BELOW its registered domain — which the deployment guide
  // recommends (`you@mail.example.com`) — the record checked above does not govern the
  // mail domain's own subdomains. A receiver evaluating `anything.mail.example.com`
  // finds no record there and, under RFC 7489 §6.6.3, jumps straight to the
  // organizational domain (`example.com`), skipping `mail.example.com` entirely. So the
  // record `setup` generated protects exactly one name, and both `@example.com` and
  // `@*.mail.example.com` are unprotected unless the apex publishes a record too.
  // (RFC 9989 §4.10's tree walk visits the intermediate names and would find ours —
  // but the receivers deciding today are the ones that matter. See ADR 0027.)
  const orgDomain = registeredDomain(p.domain);
  if (orgDomain !== null && orgDomain !== stripDot(p.domain)) {
    try {
      const { record: orgRec, multiple: orgMultiple } = selectDmarcRecord(await deps.txt(`_dmarc.${orgDomain}`));
      if (orgMultiple) {
        push('dmarc-org', 'fail', `several DMARC records at _dmarc.${orgDomain}: the set is discarded, so subdomains of ${p.domain} get NO policy`);
      } else if (orgRec === null) {
        push(
          'dmarc-org',
          'warn',
          `no DMARC record at _dmarc.${orgDomain}. ${p.domain} is a subdomain, so receivers consult ${orgDomain}'s record — not this one — for anything under ${p.domain}, and for ${orgDomain} itself. Publish "v=DMARC1; p=reject; sp=reject" there if you own it and it sends no mail.`,
        );
      } else {
        const parsedOrg = parseDmarcRecord(Buffer.from(orgRec, 'latin1'));
        const governing = parsedOrg.subdomainPolicy ?? parsedOrg.policy;
        if (!parsedOrg.valid) push('dmarc-org', 'warn', `the DMARC record at _dmarc.${orgDomain} does not parse, so subdomains of ${p.domain} get no policy`);
        else if (governing === 'none') push('dmarc-org', 'warn', `_dmarc.${orgDomain} governs subdomains of ${p.domain} and asks receivers to monitor only (${parsedOrg.subdomainPolicy !== null ? 'sp' : 'p'}=none)`);
        else push('dmarc-org', 'ok', `_dmarc.${orgDomain} covers subdomains of ${p.domain} (${parsedOrg.subdomainPolicy !== null ? 'sp' : 'p'}=${governing})`);
      }
    } catch (e) {
      push('dmarc-org', 'warn', `could not check _dmarc.${orgDomain}: ${String(e)}`);
    }
  }

  // -- tls --------------------------------------------------------------------------
  if (p.tls === undefined) {
    push('tls', 'warn', 'no MAIL_TLS_CERT/MAIL_TLS_KEY configured: the daemon would fall back to the bundled self-signed dev certificate');
  } else {
    try {
      const cert = new X509Certificate(p.tls.certPem);
      const expiresMs = Date.parse(cert.validTo);
      const days = daysUntil(expiresMs, deps.now());
      const covers = cert.checkHost(p.mailHost) !== undefined;
      const keyMatches = p.tls.keyPem === undefined ? true : cert.checkPrivateKey(createPrivateKey(p.tls.keyPem));
      if (days < 0) push('tls', 'fail', `certificate EXPIRED ${-days} day(s) ago (${cert.validTo})`);
      else if (!covers) push('tls', 'fail', `certificate does not cover ${p.mailHost} (subject: ${cert.subject.replace(/\n/g, ' ')})`);
      else if (!keyMatches) push('tls', 'fail', 'certificate does not match the configured private key: check the cert/key paths');
      else if (days <= 21) push('tls', 'warn', `certificate expires in ${days} day(s) (${cert.validTo}): renew soon; is the renewal automated?`);
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
        push('dial-25', 'warn', `probe domain ${p.probeDomain} has no MX: cannot test outbound 25`);
      } else {
        const target = stripDot([...mxs].sort((a, b) => a.priority - b.priority)[0]!.exchange);
        const greeting = await deps.dial25(target);
        if (greeting.startsWith('220')) push('dial-25', 'ok', `outbound port 25 works (${target} greeted)`);
        else push('dial-25', 'warn', `${target} answered but not with a 220 greeting: ${greeting.slice(0, 60)}`);
      }
    } catch (e) {
      push('dial-25', 'fail', `cannot reach a real MX on port 25 (${String(e)}): most VPS providers block outbound 25 until you ask; without it this server cannot SEND mail`);
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
      if (ageDays < 30) push('age', 'warn', `${registrable} was registered only ${ageDays} day(s) ago: young domains are spam-foldered while they build reputation`);
      else push('age', 'ok', `${registrable} registered ${reg.slice(0, 10)} (${ageDays} days ago)`);
    }
  } catch {
    push('age', 'skip', `RDAP unavailable for ${registrable}: domain age not checked`);
  }

  // -- sqlite runtime version — advisory ------------------------------------------------
  // The storage engine is whatever node:sqlite bundled, not a dependency this project pins, so a
  // deployment can unknowingly be on a build carrying a data-at-rest bug. MIN_SQLITE_VERSION is the
  // floor (the WAL-reset corruption fix; ADR 0028). Every mail database runs WAL with more than one
  // connection open on the file, which is the regime that bug threatens. WARN, never fail: the
  // operator may not yet be able to install a Node whose bundled SQLite clears the floor.
  try {
    const v = deps.sqliteVersion();
    if (sqliteVersionAtLeast(v, MIN_SQLITE_VERSION)) {
      push('sqlite', 'ok', `SQLite ${v} (>= ${MIN_SQLITE_VERSION}, clear of the WAL-reset corruption fix)`);
    } else {
      push(
        'sqlite',
        'warn',
        `SQLite ${v} is below ${MIN_SQLITE_VERSION}, which fixes a WAL database-corruption bug (sqlite.org/changes.html). This server runs WAL with multiple connections per file — the case that bug threatens. Upgrade to a Node whose bundled node:sqlite is ${MIN_SQLITE_VERSION} or newer.`,
      );
    }
  } catch (e) {
    push('sqlite', 'skip', `could not read the SQLite version: ${String(e)}`);
  }

  return results;
}

/** Render + exit-code policy: any fail -> 1, otherwise 0. */
export function reportChecks(results: readonly CheckResult[], io: OpsIo): number {
  const label: Record<CheckStatus, string> = { ok: '  ok ', warn: ' WARN', fail: ' FAIL', skip: ' skip' };
  // r.detail carries remote, spoofable bytes — an MX's SMTP greeting, a DMARC/DKIM TXT record,
  // an MX/PTR hostname — which can embed ANSI/OSC escape sequences OR a raw newline to hijack the
  // clipboard or inject a forged "ok" verdict line. Each check is exactly one line, so use the
  // single-line sanitiser (also collapses CR/LF/TAB). r.name is a fixed internal label.
  for (const r of results) io.out(`${label[r.status]}  ${r.name.padEnd(8)} ${sanitizeForTerminalLine(r.detail)}`);
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  io.out('');
  io.out(fails === 0 ? `doctor: healthy (${warns} warning(s))` : `doctor: ${fails} problem(s), ${warns} warning(s)`);
  return fails === 0 ? 0 : 1;
}

const USAGE = [
  'usage: node src/main.ts doctor [--domain <domain>] [--host <mailhost>]',
  '                               [--probe <domain>] [--skip-dial]',
  '       node src/main.ts doctor --store [--db <control.db>]',
  '',
  'Checks the deployment against live DNS and the network: MX, A/AAAA, FCrDNS,',
  'SPF (evaluated), DKIM key match, DMARC, TLS certificate, outbound port 25,',
  'and domain age. Reads the same MAIL_* environment as the daemon.',
  '  --probe      whose MX to dial for the outbound-25 test (default gmail.com)',
  '  --skip-dial  skip the outbound port-25 probe',
  '  --store      instead, PRAGMA quick_check every database (control + each mailbox),',
  '               read-only, safe while the daemon runs; no DNS/network is touched',
  '  --db         the control database for --store (default MAIL_CONTROL_DB or control.db)',
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
          clearTimeout(deadline);
          sock.destroy();
          rej(new Error(why));
        };
        // sock.setTimeout below is an INACTIVITY timer: it is reset by every chunk, so a peer
        // that streams bytes containing no LF never trips it and this greeting read never ends.
        // Bound the wall clock as well as the bytes.
        const deadline = setTimeout(() => fail('probe exceeded its 30s deadline'), 30_000);
        deadline.unref();
        sock.setTimeout(10_000, () => fail('timeout after 10s'));
        sock.on('error', (e) => fail(e.message));
        sock.on('data', (d) => {
          // A greeting is one line. Without a cap this grew unbounded — and the per-chunk
          // concat made it quadratic, so a hostile MX drove multi-gigabyte RSS in seconds. The
          // reply framer in wire/reply.ts caps at 64 KiB for the same reason; this hand-rolled
          // reader never adopted it.
          if (buf.length + d.length > MAX_GREETING_BYTES) {
            fail(`greeting exceeded ${MAX_GREETING_BYTES} bytes without a line ending`);
            return;
          }
          buf = Buffer.concat([buf, d]);
          const nl = buf.indexOf(0x0a);
          if (nl !== -1) {
            clearTimeout(deadline);
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
      // Bound the body before parsing it. res.json() would buffer whatever the endpoint sends,
      // and the AbortSignal is not a reliable stop for a read already in progress — the same
      // shape that let a hostile MTA-STS policy host drive multi-gigabyte allocation. rdap.org is
      // a trusted third party, so this is defence in depth, not a live exposure.
      const text = await readCapped(res, 1024 * 1024);
      if (text === null) throw new Error('RDAP response too large');
      return JSON.parse(text);
    },
    now: () => Date.now(),
    sqliteVersion: () => {
      // A throwaway in-memory handle: sqlite_version() is a property of the linked library, so it
      // reads the very build the daemon's real databases run on, without touching them.
      const db = new DatabaseSync(':memory:');
      try {
        return (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
      } finally {
        db.close();
      }
    },
  };
}

export async function runDoctor(args: string[], io: OpsIo, env: Record<string, string | undefined>, deps: DoctorDeps = realDoctorDeps()): Promise<number> {
  let domain = env.MAIL_DOMAIN;
  let mailHost: string | undefined;
  let probeDomain = 'gmail.com';
  let skipDial = false;
  let storeMode = false;
  let controlDbPath = env.MAIL_CONTROL_DB ?? 'control.db';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--domain') domain = args[++i];
    else if (a === '--host') mailHost = args[++i];
    else if (a === '--probe') probeDomain = args[++i] ?? probeDomain;
    else if (a === '--skip-dial') skipDial = true;
    else if (a === '--store') storeMode = true;
    else if (a === '--db') controlDbPath = args[++i] ?? controlDbPath;
    else if (a === '--help' || a === '-h') {
      io.out(USAGE);
      return 0;
    } else {
      io.err(`doctor: unknown argument ${a}`);
      io.err(USAGE);
      return 2;
    }
  }
  // --store is a distinct mode: local database integrity only, no DNS/network and no
  // MAIL_DOMAIN requirement. This keeps the network doctor DNS-only by design (its whole
  // dependency seam is network) while still giving the operator an on-demand integrity check.
  if (storeMode) {
    io.out(`doctor --store: ${controlDbPath}`);
    return reportChecks(storeChecks(controlDbPath), io);
  }
  if (domain === undefined || domain === '') {
    io.err('doctor: set MAIL_DOMAIN or pass --domain.');
    return 2;
  }
  if (domain === 'mail.example.com') {
    // The daemon's placeholder default: it has no real DNS, so every check below would fail
    // in a way that looks like a broken deployment rather than an unset variable. Say which.
    io.err('doctor: MAIL_DOMAIN is still the placeholder default "mail.example.com", which has no real DNS: set MAIL_DOMAIN (or pass --domain <your-domain>) to check your actual deployment.');
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
  const results = await doctorChecks(params, deps);
  results.push(...envSecretsCheck(env));
  return reportChecks(results, io);
}

/**
 * Warn when a plaintext password is present in the environment doctor can see
 * (MAIL_PASS or MAIL_ACCOUNTS). These are create-only bootstrap seeds (ADR 0012): once
 * the account exists they are redundant and only a liability — a password sitting in the
 * unit file and /proc/<pid>/environ. `init`/`account` write SCRAM to the registry, so a
 * production unit needs no password at all. Scope: this sees the environment of the
 * process running doctor; run it in the daemon's environment (or check the unit) to catch
 * a deployed unit. The daemon itself also logs this advisory at startup.
 */
export function envSecretsCheck(env: Record<string, string | undefined>): CheckResult[] {
  const present: string[] = [];
  if ((env.MAIL_PASS ?? '') !== '') present.push('MAIL_PASS');
  if ((env.MAIL_ACCOUNTS ?? '') !== '') present.push('MAIL_ACCOUNTS');
  if (present.length === 0) return [];
  return [{
    name: 'secrets',
    status: 'warn',
    detail: `${present.join(' and ')} set in the environment: a plaintext password in the unit file / process environment. Once the account exists it is redundant: rotate with \`account set-password\` and drop it from the unit (the registry is the source of truth).`,
  }];
}

/**
 * `doctor --store` — local database integrity, on demand.
 *
 * doctor's network checks answer "will the outside world accept my mail"; this answers
 * "are my databases still sound on disk". Until now `PRAGMA quick_check`/`integrity_check`
 * ran only inside `verify` (a backup/restore chore) and the crash suite, so corruption of a
 * LIVE database first surfaced mid-query — a FETCH that throws, a login that fails opaquely.
 * This lets an operator check the live store deliberately, without stopping the daemon (WAL:
 * a read-only opener never blocks the daemon's writers).
 *
 * quick_check is integrity_check's cheaper sibling (it skips the index-order pass), enough to
 * catch structural corruption. Read-only: every database is opened `readOnly` and never
 * written, so checking cannot itself change anything (the same hard line `verify` holds).
 */
export function quickCheckDatabase(name: string, path: string): CheckResult {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    return { name, status: 'fail', detail: `cannot open ${path}: ${String(e)}` };
  }
  try {
    let rows: Array<Record<string, unknown>>;
    try {
      // The open is lazy: a file that is not a database throws on the first statement.
      rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    } catch (e) {
      return { name, status: 'fail', detail: `${path} is not a readable database: ${String(e)}` };
    }
    // quick_check returns a single 'ok' row when healthy; otherwise one row per problem. Read
    // the first column by position so the exact column name ('quick_check') is not load-bearing.
    const values = rows.map((r) => String(Object.values(r)[0]));
    if (values.length === 1 && values[0] === 'ok') {
      return { name, status: 'ok', detail: `${path} passes quick_check` };
    }
    return { name, status: 'fail', detail: `${path} FAILED quick_check: ${values.join('; ')}` };
  } finally {
    db.close();
  }
}

/**
 * Integrity-check the whole live store: the control database plus every account's mailbox
 * database. The control DB is enumerated for its account list (which names each
 * mail-<login>.db); a mailbox an account never wrote is `skip` (created lazily), exactly as
 * `backup` treats a missing mail file. Enumeration opens the control DB read-write (as
 * `account`/`backup` do); each integrity check reopens read-only.
 */
export function storeChecks(controlDbPath: string): CheckResult[] {
  if (!existsSync(controlDbPath)) {
    return [{ name: 'store', status: 'fail', detail: `control database ${controlDbPath} does not exist (set MAIL_CONTROL_DB or pass --db)` }];
  }
  let accounts: ReadonlyArray<{ login: string; mailDbPath: string }>;
  const controlDb = openMailDb(controlDbPath);
  try {
    accounts = AccountRegistry.open(controlDb).list().map((a) => ({ login: a.login, mailDbPath: a.mailDbPath }));
  } finally {
    controlDb.close();
  }
  const results: CheckResult[] = [quickCheckDatabase('store:control', controlDbPath)];
  const seen = new Set<string>();
  for (const a of accounts) {
    if (a.mailDbPath === ':memory:' || seen.has(a.mailDbPath)) continue;
    seen.add(a.mailDbPath);
    if (!existsSync(a.mailDbPath)) {
      results.push({ name: `store:${a.login}`, status: 'skip', detail: `${a.mailDbPath} not created yet (no mail): skipped` });
      continue;
    }
    results.push(quickCheckDatabase(`store:${a.login}`, a.mailDbPath));
  }
  return results;
}
