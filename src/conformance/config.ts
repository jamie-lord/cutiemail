/**
 * Run configuration: describe a server under test and the state it has been
 * given, from a plain JSON file. No code, no server-specific plugins.
 *
 * The design mirrors what made Apache MPT portable and Cassandane not: we
 * connect to a declared host:port and never spawn or manage the server. The
 * config is the whole coupling. A new target — Postfix, Exim, Stalwart, Mox, a
 * cloud MX — is a new JSON file, never a code change.
 *
 * Parsing is defensive on purpose: a malformed config should fail loudly before
 * a run, with a message naming the field, rather than producing a run whose
 * results are quietly meaningless.
 */

import { readFileSync } from 'node:fs';
import type { Fixture } from './fixture.ts';
import { validateFixture } from './fixture.ts';
import type { WireOptions } from '../wire/transport.ts';

export interface TargetConfig {
  /** Free-form label for the report, e.g. "postfix-3.8-default". */
  readonly name: string;
  /** The server's own primary domain — needed for postmaster convention etc. */
  readonly serverDomain: string;
  readonly host: string;
  readonly port: number;
  readonly tls: 'none' | 'implicit';
  readonly fixture: Fixture;
  readonly replyTimeoutMs?: number;
  readonly caseTimeoutMs?: number;
  /**
   * Version string, if known. Recorded verbatim into every result and the
   * matrix. The single most important field for staleness: imaptest's published
   * table rotted 14 years because results were not date-and-version stamped.
   */
  readonly version?: string;
}

export class ConfigError extends Error {}

function req<T>(obj: Record<string, unknown>, key: string, kind: string): T {
  const v = obj[key];
  if (v === undefined || v === null) throw new ConfigError(`missing required field: ${key}`);
  if (typeof v !== kind) throw new ConfigError(`field ${key} must be ${kind}, got ${typeof v}`);
  return v as T;
}

function opt<T>(obj: Record<string, unknown>, key: string, kind: string): T | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== kind) throw new ConfigError(`field ${key} must be ${kind}, got ${typeof v}`);
  return v as T;
}

export function parseTargetConfig(raw: unknown): TargetConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError('config must be a JSON object');
  }
  const o = raw as Record<string, unknown>;

  const name = req<string>(o, 'name', 'string');
  const serverDomain = req<string>(o, 'serverDomain', 'string');
  const host = req<string>(o, 'host', 'string');
  const port = req<number>(o, 'port', 'number');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`port must be 1-65535, got ${port}`);
  }
  const tls = opt<string>(o, 'tls', 'string') ?? 'none';
  if (tls !== 'none' && tls !== 'implicit') {
    throw new ConfigError(`tls must be "none" or "implicit", got "${tls}"`);
  }

  const fx = (o['fixture'] ?? {}) as Record<string, unknown>;
  const clientDomain = opt<string>(fx, 'clientDomain', 'string') ?? 'conformance-suite.invalid';

  // Built by assignment rather than a literal because exactOptionalPropertyTypes
  // distinguishes an omitted optional field from one set to undefined, and a
  // fixture with `validRecipient: undefined` present is not the same shape as one
  // without it. `set` only writes keys the operator actually declared.
  const fixture: { -readonly [K in keyof Fixture]?: Fixture[K] } = {
    clientDomain,
    source: 'operator-declared',
  };
  const set = <K extends keyof Fixture>(key: K, value: Fixture[K] | undefined): void => {
    if (value !== undefined) fixture[key] = value;
  };
  set('validRecipient', opt<string>(fx, 'validRecipient', 'string'));
  set('rejectedRecipient', opt<string>(fx, 'rejectedRecipient', 'string'));
  set('nonRelayDomain', opt<string>(fx, 'nonRelayDomain', 'string'));
  set('relayDomain', opt<string>(fx, 'relayDomain', 'string'));
  set('overQuotaRecipient', opt<string>(fx, 'overQuotaRecipient', 'string'));
  set('postmaster', opt<string>(fx, 'postmaster', 'string'));
  set('longLocalPartRecipient', opt<string>(fx, 'longLocalPartRecipient', 'string'));
  set('longDomainRecipient', opt<string>(fx, 'longDomainRecipient', 'string'));
  set('declaredSizeLimit', opt<number>(fx, 'declaredSizeLimit', 'number'));

  const fixtureValue = fixture as Fixture;
  const problems = validateFixture(fixtureValue);
  if (problems.length > 0) {
    throw new ConfigError(`fixture is invalid:\n  - ${problems.join('\n  - ')}`);
  }

  const target: { -readonly [K in keyof TargetConfig]?: TargetConfig[K] } = {
    name,
    serverDomain,
    host,
    port,
    tls,
    fixture: fixtureValue,
  };
  const setT = <K extends keyof TargetConfig>(key: K, value: TargetConfig[K] | undefined): void => {
    if (value !== undefined) target[key] = value;
  };
  // Timeouts must be positive finite integers if present. A 0, negative, or NaN
  // value passes the typeof check but would silently make every case time out to
  // inconclusive — the "quietly meaningless run" this parser exists to prevent.
  const posInt = (key: 'replyTimeoutMs' | 'caseTimeoutMs'): number | undefined => {
    const v = opt<number>(o, key, 'number');
    if (v !== undefined && (!Number.isInteger(v) || v < 1)) {
      throw new ConfigError(`${key} must be a positive integer (ms), got ${v}`);
    }
    return v;
  };
  setT('replyTimeoutMs', posInt('replyTimeoutMs'));
  setT('caseTimeoutMs', posInt('caseTimeoutMs'));
  setT('version', opt<string>(o, 'version', 'string'));

  return target as TargetConfig;
}

export function loadTargetConfig(path: string): TargetConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseTargetConfig(parsed);
}

/** Derive the Wire connect options from a target. */
export function connectOptions(target: TargetConfig): WireOptions {
  return {
    host: target.host,
    port: target.port,
    tls: target.tls,
    ...(target.tls === 'implicit'
      ? { tlsOptions: { servername: target.serverDomain, rejectUnauthorized: false } }
      : {}),
  };
}
