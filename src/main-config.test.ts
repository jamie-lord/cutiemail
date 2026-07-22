/**
 * configFromEnv — the boot-time TLS fail-closed guard.
 *
 * The bundled dev certificate's private key is committed, so the daemon must refuse to
 * serve it on a non-loopback interface. Each case pairs the refusal with the control that
 * proves it is not over-eager: loopback dev is fine, a real cert is fine, and an explicit
 * unsafe opt-in is honoured.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { configFromEnv, describeCertExpiry } from './main.ts';
import { TEST_CERT } from './testing/tls-test-cert.ts';

const MAIL_KEYS = Object.keys(process.env).filter((k) => k.startsWith('MAIL_'));

/**
 * Run `fn` with the MAIL_* env reset to exactly `overrides` (all other MAIL_* cleared),
 * restoring the caller's environment after — so each case starts from a known-clean config.
 */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const keys = new Set([...MAIL_KEYS, ...Object.keys(process.env).filter((k) => k.startsWith('MAIL_')), ...Object.keys(overrides)]);
  const saved = new Map<string, string | undefined>();
  for (const k of keys) saved.set(k, process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const k of keys) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('refuses to boot with the dev cert on a non-loopback interface', () => {
  for (const host of ['0.0.0.0', '::', '203.0.113.5']) {
    withEnv({ MAIL_HOST: host }, () => {
      assert.throws(() => configFromEnv(), /refusing to bind .* DEV certificate/, `host ${host} must fail closed`);
    });
  }
});

test('allows the dev cert on loopback (the development default)', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost', undefined]) {
    withEnv({ MAIL_HOST: host }, () => {
      const cfg = configFromEnv();
      assert.equal(cfg.usingDevCert, true, `loopback host ${host ?? '(default)'} keeps the dev cert`);
    });
  }
});

test('MAIL_ALLOW_DEV_CERT=1 is an explicit unsafe opt-in for a public interface', () => {
  withEnv({ MAIL_HOST: '0.0.0.0', MAIL_ALLOW_DEV_CERT: '1' }, () => {
    const cfg = configFromEnv();
    assert.equal(cfg.usingDevCert, true);
  });
});

test('an invalid MAIL_USER or MAIL_ACCOUNTS login is rejected at boot (not turned into a bad filename)', () => {
  for (const bad of ['../evil', 'a/b', 'a:b', '.hidden', 'x'.repeat(65)]) {
    withEnv({ MAIL_USER: bad }, () => assert.throws(() => configFromEnv(), /invalid account login/, `MAIL_USER=${bad}`));
  }
  withEnv({ MAIL_ACCOUNTS: '../evil:pw' }, () => assert.throws(() => configFromEnv(), /invalid account login/));
  // The env primary is seeded ONLY when MAIL_USER is set; MAIL_ACCOUNTS adds to it.
  withEnv({ MAIL_USER: 'alice', MAIL_ACCOUNTS: 'bob:pw1,carol.j:pw2' }, () => {
    assert.deepEqual(configFromEnv().accounts.map((a) => a.user), ['alice', 'bob', 'carol.j']);
  });
  withEnv({ MAIL_ACCOUNTS: 'bob:pw1,carol.j:pw2' }, () => {
    // No MAIL_USER → no implicit 'demo' primary in config (a passwordless unit is possible;
    // the dev demo/demo fallback lives in startServer and only fires on an empty registry).
    assert.deepEqual(configFromEnv().accounts.map((a) => a.user), ['bob', 'carol.j']);
  });
  withEnv({}, () => assert.deepEqual(configFromEnv().accounts, [], 'no env accounts → empty (registry is the source of truth)'));
});

test('a real cert on a public interface is fine (no guard tripped)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cert-test-'));
  try {
    const certPath = join(dir, 'cert.pem');
    const keyPath = join(dir, 'key.pem');
    writeFileSync(certPath, 'cert-bytes');
    writeFileSync(keyPath, 'key-bytes');
    withEnv({ MAIL_HOST: '0.0.0.0', MAIL_TLS_CERT: certPath, MAIL_TLS_KEY: keyPath }, () => {
      const cfg = configFromEnv();
      assert.equal(cfg.usingDevCert, false);
      assert.equal(cfg.tls.cert, 'cert-bytes');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a TLS/DKIM env var pointing at a missing file fails with the variable, the path, and the way out', () => {
  // The raw alternative is an ENOENT stack trace — which under systemd Restart=on-failure
  // becomes a silent crash loop. Classic trigger: enabling the unit before certbot ran.
  const missing = join(tmpdir(), 'nope', 'cert.pem');
  withEnv({ MAIL_HOST: '0.0.0.0', MAIL_TLS_CERT: missing, MAIL_TLS_KEY: missing }, () => {
    assert.throws(() => configFromEnv(), (e: Error) => /cannot start: MAIL_TLS_CERT points at .*cert\.pem.*ENOENT/.test(e.message) && /certbot/.test(e.message));
  });
  withEnv({ MAIL_DKIM_KEY: join(tmpdir(), 'nope', 'dkim.key'), MAIL_DKIM_SELECTOR: 's1' }, () => {
    assert.throws(() => configFromEnv(), (e: Error) => /cannot start: MAIL_DKIM_KEY points at .*dkim\.key.*ENOENT/.test(e.message) && /setup/.test(e.message));
  });
});

test('MAIL_USER without MAIL_PASS refuses to seed a well-known default credential on a public bind', () => {
  // The sibling of the loopback-only demo/demo fallback: MAIL_USER + an unset/empty MAIL_PASS
  // would otherwise seed the documented primary login with the well-known password 'demo' (or
  // an empty password) on public 587/993. A real cert gets us past the dev-cert refusal so the
  // credential guard is what's under test.
  const dir = mkdtempSync(join(tmpdir(), 'seed-cred-test-'));
  try {
    const certPath = join(dir, 'cert.pem');
    const keyPath = join(dir, 'key.pem');
    writeFileSync(certPath, 'cert-bytes');
    writeFileSync(keyPath, 'key-bytes');
    const cert = { MAIL_TLS_CERT: certPath, MAIL_TLS_KEY: keyPath };
    for (const pass of [undefined, ''] as const) {
      withEnv({ MAIL_HOST: '0.0.0.0', MAIL_USER: 'you', MAIL_PASS: pass, ...cert }, () => {
        assert.throws(
          () => configFromEnv(),
          (e: Error) => /refusing to seed account "you" on 0\.0\.0\.0/.test(e.message) && /MAIL_PASS/.test(e.message),
          `MAIL_PASS=${JSON.stringify(pass)} on a public bind must fail closed`,
        );
      });
    }
    // A real MAIL_PASS on the same public bind is fine — the guard is not over-eager.
    withEnv({ MAIL_HOST: '0.0.0.0', MAIL_USER: 'you', MAIL_PASS: 'a-real-passphrase', ...cert }, () => {
      assert.equal(configFromEnv().accounts[0]?.pass, 'a-real-passphrase');
    });
    // Loopback keeps the convenience default (the dev happy path is untouched).
    withEnv({ MAIL_HOST: '127.0.0.1', MAIL_USER: 'you' }, () => {
      assert.equal(configFromEnv().accounts[0]?.pass, 'demo');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exercising the MAIL_ALLOW_DEV_CERT override on a public bind is flagged for the loud warning', () => {
  withEnv({ MAIL_HOST: '0.0.0.0', MAIL_ALLOW_DEV_CERT: '1' }, () => {
    assert.equal(configFromEnv().devCertForcedPublic, true, 'public bind + override → flagged');
  });
  withEnv({}, () => {
    assert.equal(configFromEnv().devCertForcedPublic, false, 'a loopback dev run is not flagged');
  });
  withEnv({ MAIL_HOST: '127.0.0.1', MAIL_ALLOW_DEV_CERT: '1' }, () => {
    assert.equal(configFromEnv().devCertForcedPublic, false, 'the override without a public bind is inert');
  });
});

test('describeCertExpiry warns on an expired or soon-expiring certificate, is quiet otherwise', () => {
  // Derive the reference times from the bundled cert's own validTo, so the test is
  // deterministic regardless of when the cert was generated.
  const expires = Date.parse(new X509Certificate(TEST_CERT).validTo);
  const DAY = 86_400_000;
  const expired = describeCertExpiry(TEST_CERT, expires + 3 * DAY);
  assert.ok(expired !== null && /EXPIRED 3 day/.test(expired), `expired cert warns with the age: ${expired}`);
  const soon = describeCertExpiry(TEST_CERT, expires - 5 * DAY);
  assert.ok(soon !== null && /expires in [45] day/.test(soon), `a cert inside the renewal window warns: ${soon}`);
  assert.equal(describeCertExpiry(TEST_CERT, expires - 60 * DAY), null, 'a healthy cert is quiet');
  assert.equal(describeCertExpiry('not a certificate', Date.now()), null, 'garbage input is quiet (the TLS server itself fails loudly)');
});

test(':memory: control DB keeps the env-seeded primary mailbox in memory too (no stale ./mail.db)', () => {
  // The regression: `?? 'mail.db'` made the path always explicit, bypassing the
  // in-memory default — a "fully ephemeral" CI run with MAIL_USER set reopened
  // whatever mail.db was lying around in the working directory.
  withEnv({ MAIL_CONTROL_DB: ':memory:', MAIL_USER: 'ci' }, () => {
    assert.equal(configFromEnv().accounts[0]?.mailDbPath, undefined, 'no explicit path — startServer defaults it to :memory:');
  });
  withEnv({ MAIL_CONTROL_DB: ':memory:', MAIL_USER: 'ci', MAIL_DB: 'explicit.db' }, () => {
    assert.equal(configFromEnv().accounts[0]?.mailDbPath, 'explicit.db', 'an explicit MAIL_DB still wins');
  });
  withEnv({ MAIL_USER: 'ci' }, () => {
    assert.equal(configFromEnv().accounts[0]?.mailDbPath, 'mail.db', 'the persistent-run default is unchanged (single-account migration path)');
  });
});

test('MAIL_OUTBOUND parses deliver/hold and fails loud on anything else', () => {
  withEnv({}, () => assert.equal(configFromEnv().outboundMode, 'deliver'));
  withEnv({ MAIL_OUTBOUND: 'hold' }, () => assert.equal(configFromEnv().outboundMode, 'hold'));
  // A typo must never silently become a really-relaying server.
  withEnv({ MAIL_OUTBOUND: 'holdd' }, () => assert.throws(() => configFromEnv(), /MAIL_OUTBOUND must be/));
});
