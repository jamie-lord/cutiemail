/**
 * configFromEnv — the boot-time TLS fail-closed guard (audit run-1, finding 3).
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
import { configFromEnv } from './main.ts';

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
