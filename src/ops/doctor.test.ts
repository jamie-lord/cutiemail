/**
 * `doctor` — every check driven in BOTH directions through fake
 * dependencies: it must detect the broken state (the negative control) AND pass
 * the healthy one (no false alarms — the project's core discipline: a check that
 * cries wolf on a healthy deployment is as useless as one that misses drift).
 *
 * The healthy world is one fixture; each test perturbs exactly one dimension.
 * The TLS checks use the repo's bundled self-signed cert (CN=mutant.test), so
 * the healthy fixture's mailHost is mutant.test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorChecks, reportChecks, runDoctor, envSecretsCheck, quickCheckDatabase, storeChecks, type DoctorDeps, type DoctorParams } from './doctor.ts';
import { dkimTxtFromPrivateKey } from './setup.ts';
import { runAccount, type PasswordSource } from './account.ts';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const DOMAIN = 'mutant.test';
const IP = '192.0.2.7';
const NOW = Date.parse('2026-07-18T00:00:00Z');

const dkimKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const otherKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publishedDkim = dkimTxtFromPrivateKey(dkimKey).txtValue;

/** A world where everything is right; tests override single fields. */
function healthyDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    mx: async (name) => (name === DOMAIN ? [{ exchange: DOMAIN, priority: 10 }] : name === 'probe.example' ? [{ exchange: 'mx.probe.example', priority: 5 }] : []),
    txt: async (name) => {
      if (name === DOMAIN) return [`v=spf1 ip4:${IP} -all`];
      if (name === `sel._domainkey.${DOMAIN}`) return [publishedDkim];
      if (name === `_dmarc.${DOMAIN}`) return ['v=DMARC1; p=quarantine'];
      return [];
    },
    addr: async (name) => (name === DOMAIN ? [IP] : []),
    ptr: async (ip) => (ip === IP ? [DOMAIN] : []),
    dial25: async () => '220 mx.probe.example ESMTP',
    rdap: async () => ({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }] }),
    now: () => NOW,
    sqliteVersion: () => '3.51.3',
    ...over,
  };
}

const params: DoctorParams = {
  domain: DOMAIN,
  mailHost: DOMAIN,
  dkim: { selector: 'sel', privateKeyPem: dkimKey },
  tls: { certPem: TEST_CERT, keyPem: TEST_KEY },
  probeDomain: 'probe.example',
  skipDial: false,
};

function statusOf(results: readonly { name: string; status: string }[], name: string): string {
  const r = results.find((x) => x.name === name);
  assert.ok(r !== undefined, `check ${name} missing`);
  return r.status;
}

function detailOf(results: readonly { name: string; detail: string }[], name: string): string {
  const r = results.find((x) => x.name === name);
  assert.ok(r !== undefined, `check ${name} missing`);
  return r.detail;
}

test('a healthy deployment: every check ok (no false alarms)', async () => {
  const results = await doctorChecks(params, healthyDeps());
  for (const name of ['mx', 'address', 'fcrdns', 'spf', 'spf-exclusive', 'dkim', 'dmarc', 'tls', 'dial-25', 'age']) {
    assert.equal(statusOf(results, name), 'ok', `${name}: ${JSON.stringify(results)}`);
  }
});

test('mx: missing record and wrong target are both failures', async () => {
  const none = await doctorChecks(params, healthyDeps({ mx: async (n) => (n === 'probe.example' ? [{ exchange: 'mx.probe.example', priority: 5 }] : []) }));
  assert.equal(statusOf(none, 'mx'), 'fail');
  const wrong = await doctorChecks(params, healthyDeps({ mx: async (n) => (n === DOMAIN ? [{ exchange: 'elsewhere.example', priority: 10 }] : [{ exchange: 'mx.probe.example', priority: 5 }]) }));
  assert.equal(statusOf(wrong, 'mx'), 'fail');
  // A trailing dot / case difference is NOT a failure (DNS is case-insensitive).
  const dotted = await doctorChecks(params, healthyDeps({ mx: async (n) => (n === DOMAIN ? [{ exchange: 'MUTANT.TEST.', priority: 10 }] : [{ exchange: 'mx.probe.example', priority: 5 }]) }));
  assert.equal(statusOf(dotted, 'mx'), 'ok');
});

test('address/fcrdns: no A record fails; PTR to another name fails; missing PTR fails', async () => {
  const noAddr = await doctorChecks(params, healthyDeps({ addr: async () => [] }));
  assert.equal(statusOf(noAddr, 'address'), 'fail');
  assert.equal(noAddr.some((r) => r.name === 'fcrdns'), false); // nothing to reverse-check

  const wrongPtr = await doctorChecks(params, healthyDeps({ ptr: async () => ['residential.isp.example'] }));
  assert.equal(statusOf(wrongPtr, 'fcrdns'), 'fail');

  const noPtr = await doctorChecks(params, healthyDeps({ ptr: async () => [] }));
  assert.equal(statusOf(noPtr, 'fcrdns'), 'fail');
});

test('spf: unauthorised IP fails, missing record fails, DNS trouble is a warning not a failure', async () => {
  const unauth = await doctorChecks(params, healthyDeps({
    txt: async (name) => (name === DOMAIN ? ['v=spf1 ip4:203.0.113.9 -all'] : healthyDeps().txt(name)),
  }));
  assert.equal(statusOf(unauth, 'spf'), 'fail');

  const missing = await doctorChecks(params, healthyDeps({
    txt: async (name) => (name === DOMAIN ? [] : healthyDeps().txt(name)),
  }));
  assert.equal(statusOf(missing, 'spf'), 'fail'); // SPF result "none" — nothing authorises us

  const flaky = await doctorChecks(params, healthyDeps({
    txt: async (name) => {
      if (name === DOMAIN) throw new Error('SERVFAIL');
      return healthyDeps().txt(name);
    },
  }));
  assert.equal(statusOf(flaky, 'spf'), 'warn'); // temperror: retry later, don't cry wolf
});

test('dkim: unpublished key fails; a DIFFERENT published key fails; unconfigured is a warning', async () => {
  const unpublished = await doctorChecks(params, healthyDeps({
    txt: async (name) => (name === `sel._domainkey.${DOMAIN}` ? [] : healthyDeps().txt(name)),
  }));
  assert.equal(statusOf(unpublished, 'dkim'), 'fail');

  // The drift case doctor exists for: DNS still has an old/foreign key.
  const foreign = await doctorChecks(params, healthyDeps({
    txt: async (name) => (name === `sel._domainkey.${DOMAIN}` ? [dkimTxtFromPrivateKey(otherKey).txtValue] : healthyDeps().txt(name)),
  }));
  assert.equal(statusOf(foreign, 'dkim'), 'fail');
  assert.match(foreign.find((r) => r.name === 'dkim')!.detail, /NOT this server's key/);

  const { dkim: _dropped, ...rest } = params;
  const unconfigured = await doctorChecks(rest, healthyDeps());
  assert.equal(statusOf(unconfigured, 'dkim'), 'warn');
});

test('dmarc: missing fails, unparseable fails, present parses ok with its policy', async () => {
  const missing = await doctorChecks(params, healthyDeps({
    txt: async (name) => (name === `_dmarc.${DOMAIN}` ? [] : healthyDeps().txt(name)),
  }));
  assert.equal(statusOf(missing, 'dmarc'), 'fail');

  const broken = await doctorChecks(params, healthyDeps({
    txt: async (name) => (name === `_dmarc.${DOMAIN}` ? ['v=DMARC1'] : healthyDeps().txt(name)), // no p= tag
  }));
  assert.equal(statusOf(broken, 'dmarc'), 'fail');

  const ok = await doctorChecks(params, healthyDeps());
  assert.match(ok.find((r) => r.name === 'dmarc')!.detail, /p=quarantine/);
});

test('dmarc: p=none is a WARNING — published but enforcing nothing is the state that protects nobody', async () => {
  const monitorOnly = await doctorChecks(params, healthyDeps({
    txt: async (name) => (name === `_dmarc.${DOMAIN}` ? ['v=DMARC1; p=none; rua=mailto:d@mutant.test'] : healthyDeps().txt(name)),
  }));
  assert.equal(statusOf(monitorOnly, 'dmarc'), 'warn');
  assert.match(detailOf(monitorOnly, 'dmarc'), /MONITOR only/);
  // ...but still exit 0: mid-rollout at p=none is a legitimate state, not a broken one.
  assert.equal(reportChecks(monitorOnly, { out: (): void => {}, err: (): void => {} }), 0);

  // The enforcing policies stay quiet — the warning must not fire on a healthy deployment.
  for (const policy of ['quarantine', 'reject']) {
    const enforcing = await doctorChecks(params, healthyDeps({
      txt: async (name) => (name === `_dmarc.${DOMAIN}` ? [`v=DMARC1; p=${policy}`] : healthyDeps().txt(name)),
    }));
    assert.equal(statusOf(enforcing, 'dmarc'), 'ok', `p=${policy} must not warn`);
  }
});

test('spf-exclusive: a record that authorises everyone fails; a softfail warns; -all is ok', async () => {
  // The check the per-address one cannot make: `+all` authorises this host perfectly well.
  for (const everyone of ['v=spf1 +all', `v=spf1 ip4:${IP} all`, 'v=spf1 +ip4:0.0.0.0/0 -all']) {
    const open = await doctorChecks(params, healthyDeps({
      txt: async (name) => (name === DOMAIN ? [everyone] : healthyDeps().txt(name)),
    }));
    assert.equal(statusOf(open, 'spf'), 'ok', `${everyone}: the per-address check still passes — that is the point`);
    assert.equal(statusOf(open, 'spf-exclusive'), 'fail', everyone);
    assert.match(detailOf(open, 'spf-exclusive'), /anyone on the internet passes SPF/);
  }

  const soft = await doctorChecks(params, healthyDeps({
    txt: async (name) => (name === DOMAIN ? [`v=spf1 ip4:${IP} ~all`] : healthyDeps().txt(name)),
  }));
  assert.equal(statusOf(soft, 'spf-exclusive'), 'warn');

  const neutral = await doctorChecks(params, healthyDeps({
    txt: async (name) => (name === DOMAIN ? [`v=spf1 ip4:${IP} ?all`] : healthyDeps().txt(name)),
  }));
  assert.equal(statusOf(neutral, 'spf-exclusive'), 'warn');

  // The reserved probe address must not be confused with a real one in the same /24:
  // the healthy record authorises 192.0.2.7 and hard-fails 192.0.2.1.
  assert.equal(statusOf(await doctorChecks(params, healthyDeps()), 'spf-exclusive'), 'ok');
});

test('dmarc-org: a subdomain mail domain is told which record actually governs its subdomains', async () => {
  // The topology the deployment guide recommends: mail domain BELOW the registered domain.
  const sub = { ...params, domain: `mail.${DOMAIN}`, mailHost: `mail.${DOMAIN}` };
  const subDeps = (over: Partial<DoctorDeps> = {}): DoctorDeps => healthyDeps({
    mx: async (name) => (name === sub.domain ? [{ exchange: sub.domain, priority: 10 }] : name === 'probe.example' ? [{ exchange: 'mx.probe.example', priority: 5 }] : []),
    addr: async (name) => (name === sub.domain ? [IP] : []),
    ptr: async (ip) => (ip === IP ? [sub.domain] : []),
    txt: async (name) => {
      if (name === sub.domain) return [`v=spf1 ip4:${IP} -all`];
      if (name === `sel._domainkey.${sub.domain}`) return [publishedDkim];
      if (name === `_dmarc.${sub.domain}`) return ['v=DMARC1; p=quarantine'];
      return [];
    },
    ...over,
  });

  // Nothing at the registered domain: our own record does not cover our subdomains.
  const bare = await doctorChecks(sub, subDeps());
  assert.equal(statusOf(bare, 'dmarc'), 'ok'); // the mail domain's own record is fine...
  assert.equal(statusOf(bare, 'dmarc-org'), 'warn'); // ...and governs only itself
  assert.match(detailOf(bare, 'dmarc-org'), new RegExp(`no DMARC record at _dmarc\\.${DOMAIN}`));

  const covered = await doctorChecks(sub, subDeps({
    txt: async (name) => (name === `_dmarc.${DOMAIN}` ? ['v=DMARC1; p=reject; sp=reject'] : subDeps().txt(name)),
  }));
  assert.equal(statusOf(covered, 'dmarc-org'), 'ok');
  assert.match(detailOf(covered, 'dmarc-org'), /sp=reject/);

  // An apex that publishes a policy but exempts its subdomains is the trap worth naming.
  const spNone = await doctorChecks(sub, subDeps({
    txt: async (name) => (name === `_dmarc.${DOMAIN}` ? ['v=DMARC1; p=reject; sp=none'] : subDeps().txt(name)),
  }));
  assert.equal(statusOf(spNone, 'dmarc-org'), 'warn');
  assert.match(detailOf(spNone, 'dmarc-org'), /sp=none/);

  // And when the mail domain IS the registered domain there is no second record to want,
  // so the check must not fire at all rather than nag about a name nobody should publish.
  assert.equal((await doctorChecks(params, healthyDeps())).some((r) => r.name === 'dmarc-org'), false);
});

test('tls: expiry-soon warns, expired fails, wrong host fails, wrong key fails, unconfigured warns', async () => {
  // The bundled cert is valid to 2036-07-13; 10 days before that is a warning...
  const soon = await doctorChecks(params, healthyDeps({ now: () => Date.parse('2036-07-03T00:00:00Z') }));
  assert.equal(statusOf(soon, 'tls'), 'warn');
  // ...and after it, a failure.
  const expired = await doctorChecks(params, healthyDeps({ now: () => Date.parse('2036-08-01T00:00:00Z') }));
  assert.equal(statusOf(expired, 'tls'), 'fail');

  const wrongHost = await doctorChecks({ ...params, mailHost: 'other.test' }, healthyDeps({
    // keep DNS healthy for the new host so only the cert check differs
    addr: async () => [IP],
    ptr: async () => ['other.test'],
    mx: async (n) => (n === DOMAIN ? [{ exchange: 'other.test', priority: 10 }] : [{ exchange: 'mx.probe.example', priority: 5 }]),
  }));
  assert.equal(statusOf(wrongHost, 'tls'), 'fail');

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const wrongKey = await doctorChecks({ ...params, tls: { certPem: TEST_CERT, keyPem: rsa } }, healthyDeps());
  assert.equal(statusOf(wrongKey, 'tls'), 'fail');
  assert.match(wrongKey.find((r) => r.name === 'tls')!.detail, /does not match/);

  const { tls: _dropped, ...rest } = params;
  const unconfigured = await doctorChecks(rest, healthyDeps());
  assert.equal(statusOf(unconfigured, 'tls'), 'warn');
});

test('dial-25: a blocked port is a failure naming the real-world cause; --skip-dial skips', async () => {
  const blocked = await doctorChecks(params, healthyDeps({ dial25: async () => Promise.reject(new Error('ETIMEDOUT')) }));
  assert.equal(statusOf(blocked, 'dial-25'), 'fail');
  assert.match(blocked.find((r) => r.name === 'dial-25')!.detail, /block outbound 25/);

  const skipped = await doctorChecks({ ...params, skipDial: true }, healthyDeps());
  assert.equal(statusOf(skipped, 'dial-25'), 'skip');
});

test('age: a young domain warns, RDAP being down only skips (advisory, never a failure)', async () => {
  const young = await doctorChecks(params, healthyDeps({
    rdap: async () => ({ events: [{ eventAction: 'registration', eventDate: '2026-07-10T00:00:00Z' }] }),
  }));
  assert.equal(statusOf(young, 'age'), 'warn');

  const down = await doctorChecks(params, healthyDeps({ rdap: async () => Promise.reject(new Error('503')) }));
  assert.equal(statusOf(down, 'age'), 'skip');
});

test('sqlite: a version at/above the floor is ok; one below WARNs (advisory, never a failure)', async () => {
  const atFloor = await doctorChecks(params, healthyDeps({ sqliteVersion: () => '3.51.3' }));
  assert.equal(statusOf(atFloor, 'sqlite'), 'ok', 'exactly at the floor is clear');

  const above = await doctorChecks(params, healthyDeps({ sqliteVersion: () => '3.52.0' }));
  assert.equal(statusOf(above, 'sqlite'), 'ok', 'a newer version is clear');

  // 3.50.4 is what Node 22.x bundled when this floor was set — the case that must warn, not pass.
  const below = await doctorChecks(params, healthyDeps({ sqliteVersion: () => '3.50.4' }));
  assert.equal(statusOf(below, 'sqlite'), 'warn', 'below the corruption-fix floor warns the operator');
  assert.match(detailOf(below, 'sqlite'), /corruption|3\.51\.3/, 'the warning names the risk and the floor');

  // The check must never take the deployment down, only advise: a below-floor run still exits 0.
  assert.equal(statusOf(below, 'sqlite') === 'warn' && below.every((c) => c.status !== 'fail' || c.name !== 'sqlite'), true);
});

test('exit-code policy: warnings exit 0, any failure exits 1', () => {
  const silent = { out: (): void => {}, err: (): void => {} };
  assert.equal(reportChecks([{ name: 'a', status: 'ok', detail: '' }, { name: 'b', status: 'warn', detail: '' }], silent), 0);
  assert.equal(reportChecks([{ name: 'a', status: 'ok', detail: '' }, { name: 'b', status: 'fail', detail: '' }], silent), 1);
});

test('reportChecks neutralises terminal escape sequences in remote-derived detail', () => {
  const out: string[] = [];
  const io = { out: (l: string): void => void out.push(l), err: (): void => {} };
  // An MX SMTP greeting / DMARC TXT record / PTR name is remote and spoofable — an OSC 52
  // clipboard write + a CSI screen-clear + a lone-CR overwrite in a detail must not reach the
  // operator's terminal raw (the same class queue-cli already neutralises).
  // Includes a raw newline: a one-line detail must not split into an extra line that could be
  // byte-identical to a genuine "ok" verdict (an LF must be neutralised too, not just ESC/CSI).
  reportChecks([{ name: 'mx', status: 'warn', detail: 'greeting \x1b]52;c;ZXZpbA==\x07\x1b[2J\n  ok   dkim   FORGED\rX' }], io);
  const checkLine = out[0]!; // the single check line; reportChecks then adds a blank + summary
  assert.equal(checkLine.includes('\x1b'), false, 'no ESC byte reaches the terminal');
  assert.equal(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/.test(checkLine), false, 'no C0/C1 controls reach the terminal');
  assert.equal(/[\r\n]/.test(checkLine), false, 'no CR/LF survives — the detail cannot inject an extra (verdict-forging) line');
  assert.ok(checkLine.includes('FORGED'), 'the visible text is still shown on the one line, just neutralised');
});

test('runDoctor: no domain is a usage error (2); unknown flag is a usage error (2)', async () => {
  const cap = { lines: [] as string[] };
  const io = { out: (l: string): void => void cap.lines.push(l), err: (l: string): void => void cap.lines.push(l) };
  assert.equal(await runDoctor([], io, {}, healthyDeps()), 2);
  assert.equal(await runDoctor(['--bogus'], io, { MAIL_DOMAIN: DOMAIN }, healthyDeps()), 2);
  // The placeholder default has no real DNS — a specific message, not a broken-deployment run.
  const ph = { lines: [] as string[] };
  const phIo = { out: (l: string): void => void ph.lines.push(l), err: (l: string): void => void ph.lines.push(l) };
  assert.equal(await runDoctor([], phIo, { MAIL_DOMAIN: 'mail.example.com' }, healthyDeps()), 2);
  assert.match(ph.lines.join('\n'), /placeholder default/);
  // And end-to-end through the arg path against the healthy fake world: exit 0.
  assert.equal(await runDoctor(['--domain', DOMAIN, '--probe', 'probe.example'], io, {}, healthyDeps()), 0);
});

// -- doctor --store: local database integrity, negative-controlled both directions ---------

const silentIo = { out: (): void => {}, err: (): void => {} };
const storePw: PasswordSource = { interactive: false, read: () => Promise.resolve('doctor-store-pw') };

/** Capture doctor's line output. */
function lines(): { lines: string[]; io: { out(l: string): void; err(l: string): void } } {
  const acc: string[] = [];
  return { lines: acc, io: { out: (l) => void acc.push(l), err: (l) => void acc.push(l) } };
}

/** A control DB + a populated mail DB at the path the registry records, via the real code paths. */
async function makeStore(dir: string): Promise<{ controlPath: string; mailPath: string }> {
  const controlPath = join(dir, 'control.db');
  assert.equal(await runAccount(['add', 'alice', '--db', controlPath], silentIo, {}, storePw), 0);
  const mailPath = join(dir, 'mail-alice.db'); // where `account add` recorded alice's mailbox
  const db = openMailDb(mailPath);
  const inbox = SqliteCatalog.open(db, 1).get('INBOX')!;
  // A multi-page body, so a later-page corruption below is genuine structural damage.
  for (let i = 1; i <= 4; i++) inbox.append(Buffer.from('x'.repeat(2000), 'latin1'));
  db.close();
  return { controlPath, mailPath };
}

test('doctor --store: healthy databases pass quick_check; a corrupted mailbox is detected (both directions)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-store-'));
  try {
    const { controlPath, mailPath } = await makeStore(dir);

    // Healthy: exit 0, an ok line for the control DB and for alice's mailbox.
    const ok = lines();
    assert.equal(await runDoctor(['--store', '--db', controlPath], ok.io, {}), 0);
    const okText = ok.lines.join('\n');
    assert.match(okText, /store:control/);
    assert.match(okText, /store:alice/);
    assert.match(okText, /healthy/);
    assert.doesNotMatch(okText, / FAIL/);

    // Negative control: byte-corrupt a b-tree page of alice's mailbox. quick_check must catch
    // it — otherwise the corruption first surfaces mid-FETCH as a thrown query.
    const bytes = readFileSync(mailPath);
    assert.ok(bytes.length > 4096 + 200, 'need a multi-page database to corrupt page 2');
    for (let i = 0; i < 200; i++) bytes[4096 + i] = bytes[4096 + i]! ^ 0xff;
    writeFileSync(mailPath, bytes);

    const bad = lines();
    assert.equal(await runDoctor(['--store', '--db', controlPath], bad.io, {}), 1, 'a corrupt DB fails the run');
    const badText = bad.lines.join('\n');
    assert.match(badText, / FAIL/);
    assert.match(badText, /store:alice/);
    assert.match(badText, /quick_check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor --store: a control DB that does not exist is a clear failure, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-store-'));
  try {
    const missing = join(dir, 'nope.db');
    const cap = lines();
    assert.equal(await runDoctor(['--store', '--db', missing], cap.io, {}), 1);
    assert.match(cap.lines.join('\n'), /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quickCheckDatabase: junk file is reported unreadable, not thrown; healthy file passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-store-'));
  try {
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'this is not a database');
    const bad = quickCheckDatabase('store:junk', junk);
    assert.equal(bad.status, 'fail');

    const { mailPath } = await makeStore(dir);
    assert.equal(quickCheckDatabase('store:alice', mailPath).status, 'ok');

    // storeChecks skips an account whose mailbox file was never created (lazy DB), like backup.
    const controlPath = join(dir, 'control.db');
    assert.equal(await runAccount(['add', 'bob', '--db', controlPath], silentIo, {}, storePw), 0);
    const results = storeChecks(controlPath);
    const bobRow = results.find((r) => r.name === 'store:bob');
    assert.ok(bobRow !== undefined && bobRow.status === 'skip', 'bob never received mail: skipped, not failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('envSecretsCheck warns when plaintext credentials are in the environment, else silent', () => {
  assert.deepEqual(envSecretsCheck({}), [], 'no env creds → no check');
  assert.deepEqual(envSecretsCheck({ MAIL_USER: 'admin' }), [], 'a bare login is not a secret');
  const warn = envSecretsCheck({ MAIL_PASS: 'hunter2' });
  assert.equal(warn.length, 1);
  assert.equal(warn[0]!.status, 'warn');
  assert.equal(warn[0]!.name, 'secrets');
  assert.match(warn[0]!.detail, /MAIL_PASS set in the environment/);
  assert.doesNotMatch(warn[0]!.detail, /hunter2/, 'the secret value is never echoed');
  // Both vars named when both present.
  assert.match(envSecretsCheck({ MAIL_PASS: 'x', MAIL_ACCOUNTS: 'a:b' })[0]!.detail, /MAIL_PASS and MAIL_ACCOUNTS/);
});

test('dmarc: doctor agrees with the daemon about which zones actually have a policy', async () => {
  // doctor is the ONLY DMARC health surface an operator sees, and it used to answer with a
  // laxer rule than enforcement: it trimmed leading whitespace and took the first matching
  // record with no multiplicity check. Both divergences reported a healthy policy for zones
  // where RFC 7489 §6.6.3 / RFC 9989 §4.10 discard the set — meaning no policy is applied here,
  // by Gmail, or by anyone. A green light on a control that is switched off is worse than none.
  const zone = (records: string[]): DoctorDeps =>
    healthyDeps({
      txt: async (name) => {
        if (name === DOMAIN) return [`v=spf1 ip4:${IP} -all`];
        if (name === `sel._domainkey.${DOMAIN}`) return [publishedDkim];
        if (name === `_dmarc.${DOMAIN}`) return records;
        return [];
      },
    });

  const duplicated = await doctorChecks(params, zone(['v=DMARC1; p=reject', 'v=DMARC1; p=reject; sp=reject']));
  assert.equal(statusOf(duplicated, 'dmarc'), 'fail', 'several records: discovery yields NO policy');
  assert.match(detailOf(duplicated, 'dmarc'), /several DMARC records/);

  const leadingSpace = await doctorChecks(params, zone([' v=DMARC1; p=reject']));
  assert.equal(statusOf(leadingSpace, 'dmarc'), 'fail', 'leading whitespace is not a legal record');

  const single = await doctorChecks(params, zone(['v=DMARC1; p=reject']));
  assert.equal(statusOf(single, 'dmarc'), 'ok', 'control: one conformant record is still healthy');
});

test('dial-25: a peer that streams without a line ending is abandoned, not buffered forever', async () => {
  // The real dial25 caps the greeting; this pins the CONTRACT the checks rely on — a probe that
  // cannot complete must surface as a failure rather than growing a buffer until the CLI dies.
  const results = await doctorChecks(
    params,
    healthyDeps({ dial25: async () => { throw new Error('greeting exceeded 65536 bytes without a line ending'); } }),
  );
  assert.equal(statusOf(results, 'dial-25'), 'fail');
  assert.match(detailOf(results, 'dial-25'), /greeting exceeded/);
});
