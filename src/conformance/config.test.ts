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

test('a full fixture round-trips', () => {
  const c = parseTargetConfig({
    ...minimal,
    version: 'postfix-3.8.1',
    fixture: {
      clientDomain: 'c.example',
      validRecipient: 'ok@mail.example',
      rejectedRecipient: 'no@mail.example',
      declaredSizeLimit: 10485760,
    },
  });
  assert.equal(c.version, 'postfix-3.8.1');
  assert.equal(c.fixture.validRecipient, 'ok@mail.example');
  assert.equal(c.fixture.declaredSizeLimit, 10485760);
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
