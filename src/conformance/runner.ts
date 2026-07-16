/**
 * The runner: drive one test case against one server, produce one Result.
 *
 * This is the join point. It owns the things a test case must NOT: opening the
 * connection, checking the case's declared needs against the run's fixture and
 * EHLO capabilities, invoking the body, and — crucially — computing the Outcome
 * centrally from the returned Judgement and the requirement's Level. A test body
 * never grades itself.
 *
 * The needs-gating is what makes the fixture model honest in practice: a case
 * that needs a `validRecipient` the run doesn't have yields `inconclusive` with
 * that named as the reason, before the body runs at all. No false failure, no
 * silent skip.
 */

import { Wire } from '../wire/transport.ts';
import type { WireOptions } from '../wire/transport.ts';
import { replyFramer, frameReplyAtEof } from '../wire/reply.ts';
import type { Reply } from '../wire/reply.ts';
import { judge } from './outcome.ts';
import type { Result, Judgement, Evidence } from './outcome.ts';
import type { Conn, ReplyOutcome, TestCase } from './test-case.ts';
import { missingCapabilities } from './fixture.ts';
import type { Fixture } from './fixture.ts';
import type { SinkView } from './sink.ts';
import { requirement } from '../register/rfc5321.ts';
import type { RequirementId } from '../register/rfc5321.ts';

export interface RunConfig {
  readonly connect: WireOptions;
  readonly fixture: Fixture;
  /** Default reply timeout. RFC 5321 §4.5.3.2 wants generous minimums; tests may override. */
  readonly replyTimeoutMs?: number;
  /** Overall wall-clock guard per test, so one hung case cannot stall a run. */
  readonly caseTimeoutMs?: number;
  /**
   * A receiving sink the server under test relays to. Present only for runs that
   * can observe downstream delivery (the mutant relay harness, or a real server
   * configured to relay to us). Sink-based cases (needs.sink) are inconclusive
   * without it.
   */
  readonly sink?: SinkView;
}

const DEFAULT_REPLY_TIMEOUT = 30_000;
const DEFAULT_CASE_TIMEOUT = 120_000;

/** Concrete Conn over a live Wire. The anomaly list accumulates across reads. */
class LiveConn implements Conn {
  readonly wire: Wire;
  readonly fixture: Fixture;
  readonly sink?: SinkView;
  #replyTimeout: number;
  #anomalies: string[] = [];
  #lastReply: Reply | null = null;

  constructor(wire: Wire, fixture: Fixture, replyTimeout: number, sink?: SinkView) {
    this.wire = wire;
    this.fixture = fixture;
    this.#replyTimeout = replyTimeout;
    if (sink !== undefined) this.sink = sink;
  }

  send(bytes: Buffer): Promise<void> {
    return this.wire.send(bytes);
  }

  async readReply(timeoutMs?: number): Promise<ReplyOutcome> {
    // Pass frameReplyAtEof so the transport can surface a bare-CR-terminated
    // final reply on close — and consume it, so the next read reports the real
    // close rather than re-delivering the same reply.
    const r = await this.wire.read(replyFramer, timeoutMs ?? this.#replyTimeout, frameReplyAtEof);
    switch (r.kind) {
      case 'framed':
        this.#lastReply = r.value;
        for (const a of r.value.anomalies) this.#anomalies.push(`${a.kind}@line${a.line}`);
        return { kind: 'reply', reply: r.value };
      case 'timeout':
        return { kind: 'timeout', waitedMs: r.waitedMs, partial: r.partial };
      case 'closed':
        return { kind: 'closed', partial: r.partial };
      case 'reset':
        return { kind: 'reset', partial: r.partial };
    }
  }

  async expectQuiet(ms: number): Promise<{ quiet: boolean; bytes: Buffer }> {
    const r = await this.wire.expectQuiet(ms);
    return { quiet: r.quiet, bytes: r.bytes };
  }

  startTls(): Promise<void> {
    return this.wire.startTls();
  }

  get anomalies(): readonly string[] {
    return this.#anomalies;
  }
  get lastReply(): Reply | null {
    return this.#lastReply;
  }
}

/** Build an inconclusive Result without opening a connection. */
function inconclusive(
  tc: TestCase,
  level: Result['level'],
  reason: string,
): Result {
  return {
    requirementId: tc.requirement,
    testId: tc.id,
    level,
    outcome: 'inconclusive',
    judgement: { kind: 'inconclusive', reason },
    expected: tc.intent,
    evidence: { transcript: [], reply: null, anomalies: [] },
    elapsedMs: 0,
  };
}

/** Race a promise against a wall-clock guard. */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, ms);
    timer.unref();
    void p.then((v) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    });
  });
}

export async function runCase(tc: TestCase, config: RunConfig): Promise<Result> {
  const def = requirement(tc.requirement);
  const level = def.level;
  const replyTimeout = config.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT;
  const caseTimeout = config.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT;

  // Gate on declared needs BEFORE opening a connection — a missing precondition
  // is inconclusive, not a failure, and we should not spend a connection to say so.
  const needs = tc.needs;
  if (needs?.fixture !== undefined) {
    const missing = missingCapabilities(config.fixture, needs.fixture);
    if (missing.length > 0) {
      return inconclusive(tc, level, `run lacks required fixture: ${missing.join(', ')}`);
    }
  }

  // TLS gating: a case that needs TLS but whose target offers neither implicit
  // TLS nor (once we implement it) a usable STARTTLS upgrade is inconclusive, not
  // a failure. Only implicit TLS is checkable before connecting; STARTTLS
  // availability is an EHLO-gated concern the case should also declare via
  // needs.ehlo:['STARTTLS'].
  if (needs?.tls === true && config.connect.tls !== 'implicit') {
    return inconclusive(
      tc,
      level,
      'case requires TLS but the target is not configured for implicit TLS ' +
        '(declare needs.ehlo:["STARTTLS"] for a STARTTLS-upgrade path)',
    );
  }

  // Sink gating: a case that inspects downstream delivery needs the run to have a
  // sink the server relays to. Without one, it is inconclusive, not a failure.
  if (needs?.sink === true && config.sink === undefined) {
    return inconclusive(tc, level, 'case requires a receiving sink, but this run has none configured');
  }

  const started = process.hrtime.bigint();
  let wire: Wire;
  try {
    wire = await Wire.connect(config.connect);
  } catch (err) {
    return inconclusive(tc, level, `could not connect: ${(err as Error).message}`);
  }

  const conn = new LiveConn(wire, config.fixture, replyTimeout, config.sink);

  // EHLO-capability gating requires opening the session first. A case that
  // declares an ehlo need but whose server does not advertise it is inconclusive
  // (the extension is out of scope for this server), never non-conformant.
  try {
    if (needs?.ehlo !== undefined && needs.ehlo.length > 0) {
      const gate = await gateOnEhlo(conn, config.fixture.clientDomain, needs.ehlo);
      if (gate !== null) {
        await wire.close();
        return { ...inconclusive(tc, level, gate), evidence: evidenceFrom(conn) };
      }
      // Re-open: the gate consumed the greeting+EHLO, and most bodies expect to
      // drive the session themselves from a clean connection. Simpler and less
      // surprising than handing a half-used session to the body.
      await wire.close();
      wire = await Wire.connect(config.connect);
    }
  } catch (err) {
    await wire.close();
    return inconclusive(tc, level, `EHLO gating failed: ${(err as Error).message}`);
  }

  const liveConn = new LiveConn(wire, config.fixture, replyTimeout, config.sink);

  const judgement = await withDeadline<Judgement>(
    tc.run(liveConn).catch((err): Judgement => ({
      kind: 'inconclusive',
      reason: `test body threw: ${(err as Error).message}`,
    })),
    caseTimeout,
    () => ({ kind: 'inconclusive', reason: `case exceeded ${caseTimeout}ms` }),
  );

  await wire.close();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  // The one place Outcome is decided. A test body cannot reach this.
  let outcome;
  try {
    outcome = judge(judgement, level);
  } catch (err) {
    // An InvalidExpectationError here is an authoring bug (e.g. a MAY reported
    // violated). Surface it as inconclusive with the error, not as a finding —
    // our bug must not masquerade as the server's.
    return {
      requirementId: tc.requirement,
      testId: tc.id,
      level,
      outcome: 'inconclusive',
      judgement: { kind: 'inconclusive', reason: `expectation error: ${(err as Error).message}` },
      expected: tc.intent,
      evidence: evidenceFrom(liveConn),
      elapsedMs,
    };
  }

  return {
    requirementId: tc.requirement,
    testId: tc.id,
    level,
    outcome,
    judgement,
    expected: tc.intent,
    evidence: evidenceFrom(liveConn),
    elapsedMs,
  };
}

/** Returns a reason string if the server fails the EHLO gate, else null. */
async function gateOnEhlo(
  conn: LiveConn,
  clientDomain: string,
  required: readonly string[],
): Promise<string | null> {
  const greeting = await conn.readReply();
  if (greeting.kind !== 'reply') return `no greeting (${greeting.kind})`;
  await conn.send(Buffer.from(`EHLO ${clientDomain}\r\n`, 'latin1'));
  const ehlo = await conn.readReply();
  if (ehlo.kind !== 'reply') return `no EHLO reply (${ehlo.kind})`;
  const { ehloKeywords } = await import('../wire/reply.ts');
  const advertised = ehloKeywords(ehlo.reply);
  const missing = required.filter((k) => !advertised.has(k.toUpperCase()));
  return missing.length > 0 ? `server does not advertise: ${missing.join(', ')}` : null;
}

function evidenceFrom(conn: LiveConn): Evidence {
  return {
    transcript: conn.wire.transcript,
    reply: conn.lastReply,
    anomalies: conn.anomalies,
  };
}

/** Run many cases in sequence against one server. Sequential by design: a shared
 *  server's state (and rate limits) make parallel cases against one target a
 *  source of flakes, not speed. Parallelism belongs across SERVERS, not cases. */
export async function runSuite(cases: readonly TestCase[], config: RunConfig): Promise<Result[]> {
  const results: Result[] = [];
  for (const tc of cases) {
    results.push(await runCase(tc, config));
  }
  return results;
}

export type { RequirementId };
