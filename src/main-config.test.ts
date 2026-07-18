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

const TLS_KEYS = ['MAIL_TLS_CERT', 'MAIL_TLS_KEY', 'MAIL_HOST', 'MAIL_ALLOW_DEV_CERT'];

/** Run `fn` with the given env overrides applied, restoring the prior values after. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const k of TLS_KEYS) saved.set(k, process.env[k]);
  try {
    for (const k of TLS_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const k of TLS_KEYS) {
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
