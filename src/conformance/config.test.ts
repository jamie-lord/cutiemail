import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTargetConfig, connectOptions, ConfigError } from './config.ts';

const minimal = { name: 't', serverDomain: 'mail.example', host: '10.0.0.1', port: 25 };

test('a minimal config parses with sensible defaults', () => {
  const c = parseTargetConfig(minimal);
  assert.equal(c.tls, 'none');
  assert.equal(c.fixture.clientDomain, 'conformance-suite.invalid');
  assert.equal(c.fixture.source, 'operator-declared');
});

test('a full fixture round-trips — EVERY declarable field, or the parser silently drops it', () => {
  // This must name every optional Fixture field: a field on the interface but not
  // in config.ts's parser is silently dropped, so an operator who declares it gets
  // it ignored and the gated tests stay inconclusive with no error. That is exactly
  // how longLocalPartRecipient/longDomainRecipient were lost until a real
  // calibration surfaced it. If you add a Fixture field, add it here and in config.ts.
  const declared = {
    clientDomain: 'c.example',
    validRecipient: 'ok@mail.example',
    rejectedRecipient: 'no@mail.example',
    nonRelayDomain: 'not-served.example.org',
    relayDomain: 'relayed.example',
    overQuotaRecipient: 'full@mail.example',
    postmaster: 'postmaster@mail.example',
    longLocalPartRecipient: `${'a'.repeat(64)}@mail.example`,
    longDomainRecipient: 'user@a.long.example',
    declaredSizeLimit: 10485760,
  };
  const c = parseTargetConfig({ ...minimal, version: 'postfix-3.8.1', fixture: declared });
  assert.equal(c.version, 'postfix-3.8.1');
  for (const [k, v] of Object.entries(declared)) {
    assert.equal((c.fixture as unknown as Record<string, unknown>)[k], v, `fixture.${k} was dropped by the parser`);
  }
});

test('missing required fields are named', () => {
  assert.throws(() => parseTargetConfig({ serverDomain: 'x', host: 'h', port: 25 }), /missing required field: name/);
  assert.throws(() => parseTargetConfig({ name: 'x', host: 'h', port: 25 }), /serverDomain/);
  assert.throws(() => parseTargetConfig({ name: 'x', serverDomain: 'd', port: 25 }), /host/);
});

test('a bad port is rejected', () => {
  assert.throws(() => parseTargetConfig({ ...minimal, port: 0 }), /port must be 1-65535/);
  assert.throws(() => parseTargetConfig({ ...minimal, port: 70000 }), /port/);
  assert.throws(() => parseTargetConfig({ ...minimal, port: 'twenty-five' }), /port must be number/);
});

test('an invalid tls mode is rejected', () => {
  assert.throws(() => parseTargetConfig({ ...minimal, tls: 'starttls' }), /tls must be/);
});

test('a non-positive or non-integer timeout is rejected, not silently disabling every case', () => {
  assert.throws(() => parseTargetConfig({ ...minimal, caseTimeoutMs: 0 }), /caseTimeoutMs must be a positive integer/);
  assert.throws(() => parseTargetConfig({ ...minimal, replyTimeoutMs: -5 }), /replyTimeoutMs must be a positive integer/);
  assert.throws(() => parseTargetConfig({ ...minimal, caseTimeoutMs: 1.5 }), /caseTimeoutMs must be a positive integer/);
  // a valid one passes through
  assert.equal(parseTargetConfig({ ...minimal, caseTimeoutMs: 5000 }).caseTimeoutMs, 5000);
});

test('a contradictory fixture is rejected at parse time', () => {
  assert.throws(
    () => parseTargetConfig({ ...minimal, fixture: { validRecipient: 'a@b', rejectedRecipient: 'a@b' } }),
    ConfigError,
  );
});

test('non-object input is rejected', () => {
  assert.throws(() => parseTargetConfig(null), /must be a JSON object/);
  assert.throws(() => parseTargetConfig('nope'), /must be a JSON object/);
});

test('connectOptions reflects the tls mode', () => {
  assert.equal(connectOptions(parseTargetConfig(minimal)).tls, 'none');
  const implicit = connectOptions(parseTargetConfig({ ...minimal, port: 465, tls: 'implicit' }));
  assert.equal(implicit.tls, 'implicit');
  assert.equal(implicit.tlsOptions?.servername, 'mail.example');
});
