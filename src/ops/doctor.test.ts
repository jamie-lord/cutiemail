/**
 * `doctor` (backlog B2) — every check driven in BOTH directions through fake
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
import { doctorChecks, reportChecks, runDoctor, envSecretsCheck, type DoctorDeps, type DoctorParams } from './doctor.ts';
import { dkimTxtFromPrivateKey } from './setup.ts';
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

test('a healthy deployment: every check ok (no false alarms)', async () => {
  const results = await doctorChecks(params, healthyDeps());
  for (const name of ['mx', 'address', 'fcrdns', 'spf', 'dkim', 'dmarc', 'tls', 'dial-25', 'age']) {
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

test('exit-code policy: warnings exit 0, any failure exits 1', () => {
  const silent = { out: (): void => {}, err: (): void => {} };
  assert.equal(reportChecks([{ name: 'a', status: 'ok', detail: '' }, { name: 'b', status: 'warn', detail: '' }], silent), 0);
  assert.equal(reportChecks([{ name: 'a', status: 'ok', detail: '' }, { name: 'b', status: 'fail', detail: '' }], silent), 1);
});

test('reportChecks neutralises terminal escape sequences in remote-derived detail (run-6)', () => {
  const out: string[] = [];
  const io = { out: (l: string): void => void out.push(l), err: (): void => {} };
  // An MX SMTP greeting / DMARC TXT record / PTR name is remote and spoofable — an OSC 52
  // clipboard write + a CSI screen-clear + a lone-CR overwrite in a detail must not reach the
  // operator's terminal raw (the same class queue-cli already neutralises).
  // Includes a raw newline: a one-line detail must not split into an extra line that could be
  // byte-identical to a genuine "ok" verdict (run-7 completes the run-6 fix — LF was passed).
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
  // And end-to-end through the arg path against the healthy fake world: exit 0.
  assert.equal(await runDoctor(['--domain', DOMAIN, '--probe', 'probe.example'], io, {}, healthyDeps()), 0);
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
