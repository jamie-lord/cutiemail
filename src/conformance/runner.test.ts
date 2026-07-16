/**
 * Runner integration: the whole stack, end to end, against a scripted server.
 *
 * This proves the join works — transport, reply reader, test-case body, fixture
 * gating, and central outcome computation — before any real corpus exists. It
 * also pins the behaviours that keep the suite honest: a declined SHOULD is not
 * a finding, a missing fixture is inconclusive not a failure, and a test body
 * that throws does not crash the run.
 *
 * It uses real register requirement IDs, so it doubles as a check that the
 * runner's requirement() lookup and Level-driven grading are wired correctly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCase } from './runner.ts';
import { testCase } from './test-case.ts';
import type { Conn } from './test-case.ts';
import type { Judgement } from './outcome.ts';
import { baselineFixture } from './fixture.ts';
import { withServer } from '../testing/scripted-server.ts';
import { crlf } from '../wire/bytes.ts';

const fixture = baselineFixture('client.test');

/** R-5321-2.4-f is a MUST (server): "The receiver will take no action until
 *  this sequence is received." Real ID, so the runner's grading path is exercised. */
const MUST_REQ = 'R-5321-2.4-f' as const;
/** R-5321-2.4-n is a SHOULD (server): "8BITMIME SHOULD be supported". */
const SHOULD_REQ = 'R-5321-2.4-n' as const;

test('a satisfied MUST is reported conformant, with evidence', async () => {
  await withServer(
    async (s) => {
      s.send(crlf`220 mail.test ESMTP`);
      await s.awaitContaining(Buffer.from('EHLO'));
      s.send(crlf`250 mail.test`);
    },
    async (port) => {
      const tc = testCase({
        id: 'greeting-then-ehlo-ok',
        requirement: MUST_REQ,
        intent: 'server greets and answers EHLO',
        rationale: 'smoke test of the happy path',
        run: async (conn: Conn): Promise<Judgement> => {
          const greeting = await conn.readReply(2000);
          if (greeting.kind !== 'reply' || greeting.reply.code !== 220) {
            return { kind: 'violated', detail: `expected 220, got ${greeting.kind}` };
          }
          await conn.send(crlf`EHLO client.test`);
          const ehlo = await conn.readReply(2000);
          return ehlo.kind === 'reply' && ehlo.reply.code === 250
            ? { kind: 'satisfied' }
            : { kind: 'violated', detail: 'no 250 to EHLO' };
        },
      });
      const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture });
      assert.equal(result.outcome, 'conformant');
      assert.equal(result.level, 'MUST');
      assert.ok(result.evidence.transcript.length > 0, 'evidence transcript must be populated');
      assert.equal(result.evidence.reply?.code, 250);
    },
  );
});

test('a violated MUST is reported non-conformant', async () => {
  await withServer(
    async (s) => {
      s.send(crlf`220 mail.test ESMTP`);
      await s.awaitContaining(Buffer.from('EHLO'));
      s.send(crlf`500 go away`); // wrong: refuses a valid EHLO
    },
    async (port) => {
      const tc = testCase({
        id: 'ehlo-refused',
        requirement: MUST_REQ,
        intent: 'server answers EHLO with 250',
        rationale: 'a server rejecting a syntactically valid EHLO from itself',
        run: async (conn): Promise<Judgement> => {
          await conn.readReply(2000);
          await conn.send(crlf`EHLO client.test`);
          const ehlo = await conn.readReply(2000);
          return ehlo.kind === 'reply' && ehlo.reply.code === 250
            ? { kind: 'satisfied' }
            : { kind: 'violated', detail: `EHLO got ${ehlo.kind === 'reply' ? ehlo.reply.code : ehlo.kind}` };
        },
      });
      const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture });
      assert.equal(result.outcome, 'non-conformant');
      assert.match(result.judgement.kind === 'violated' ? result.judgement.detail : '', /500/);
    },
  );
});

test('a declined SHOULD is permitted-latitude, never a finding', async () => {
  // The property that stops the suite lying. Same judged 'violated', different
  // Level, opposite outcome.
  await withServer(
    async (s) => {
      s.send(crlf`220 mail.test ESMTP`);
      await s.awaitContaining(Buffer.from('EHLO'));
      s.send(crlf`250 mail.test`); // no 8BITMIME advertised
    },
    async (port) => {
      const tc = testCase({
        id: 'no-8bitmime',
        requirement: SHOULD_REQ,
        intent: 'server advertises 8BITMIME',
        rationale: '§2.4: 8BITMIME SHOULD be supported',
        run: async (conn): Promise<Judgement> => {
          await conn.readReply(2000);
          await conn.send(crlf`EHLO client.test`);
          const ehlo = await conn.readReply(2000);
          const { ehloKeywords } = await import('../wire/reply.ts');
          const has = ehlo.kind === 'reply' && ehloKeywords(ehlo.reply).has('8BITMIME');
          return has ? { kind: 'satisfied' } : { kind: 'violated', detail: '8BITMIME not advertised' };
        },
      });
      const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture });
      assert.equal(result.outcome, 'permitted-latitude');
      assert.equal(result.level, 'SHOULD');
    },
  );
});

test('a missing fixture yields inconclusive without opening a connection', async () => {
  let connected = false;
  await withServer(
    async () => {
      connected = true;
    },
    async (port) => {
      const tc = testCase({
        id: 'needs-recipient',
        requirement: MUST_REQ,
        intent: 'needs a valid recipient the run does not have',
        rationale: 'exercises needs-gating',
        needs: { fixture: ['validRecipient'] },
        run: async (): Promise<Judgement> => ({ kind: 'satisfied' }),
      });
      const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture });
      assert.equal(result.outcome, 'inconclusive');
      assert.match(
        result.judgement.kind === 'inconclusive' ? result.judgement.reason : '',
        /validRecipient/,
      );
      assert.equal(connected, false, 'must not spend a connection to report a missing precondition');
    },
  );
});

test('a test body that throws becomes inconclusive, not a crash or a finding', async () => {
  await withServer(
    async (s) => {
      s.send(crlf`220 mail.test`);
    },
    async (port) => {
      const tc = testCase({
        id: 'throwing-body',
        requirement: MUST_REQ,
        intent: 'body throws',
        rationale: 'harness robustness',
        run: async (): Promise<Judgement> => {
          throw new Error('boom');
        },
      });
      const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture });
      assert.equal(result.outcome, 'inconclusive');
      assert.match(result.judgement.kind === 'inconclusive' ? result.judgement.reason : '', /boom/);
    },
  );
});

test('a connection failure is inconclusive, not non-conformant', async () => {
  // A server that is down has not violated anything. Port 1 is reliably closed.
  const tc = testCase({
    id: 'server-down',
    requirement: MUST_REQ,
    intent: 'anything',
    rationale: 'connect failure handling',
    run: async (): Promise<Judgement> => ({ kind: 'satisfied' }),
  });
  const result = await runCase(tc, {
    connect: { host: '127.0.0.1', port: 1, connectTimeoutMs: 500 },
    fixture,
  });
  assert.equal(result.outcome, 'inconclusive');
  // The clock starts before the connect attempt, so a post-`started` inconclusive
  // must report the real elapsed time, not the helper's hardcoded 0.
  assert.ok(result.elapsedMs > 0, `connect-failure elapsedMs should be > 0, got ${result.elapsedMs}`);
});

test('an EHLO-gated case is inconclusive when the extension is unadvertised', async () => {
  await withServer(
    async (s) => {
      s.send(crlf`220 mail.test`);
      await s.awaitContaining(Buffer.from('EHLO'));
      s.send(crlf`250 mail.test`); // no STARTTLS
    },
    async (port) => {
      const tc = testCase({
        id: 'needs-starttls',
        requirement: MUST_REQ,
        intent: 'needs STARTTLS advertised',
        rationale: 'EHLO gating',
        needs: { ehlo: ['STARTTLS'] },
        run: async (): Promise<Judgement> => ({ kind: 'satisfied' }),
      });
      const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture });
      assert.equal(result.outcome, 'inconclusive');
      assert.match(
        result.judgement.kind === 'inconclusive' ? result.judgement.reason : '',
        /STARTTLS/,
      );
      // The EHLO gate opens a session (greeting + EHLO round trips) after the
      // clock starts, so its inconclusive result must carry real elapsed time.
      assert.ok(result.elapsedMs > 0, `EHLO-gate elapsedMs should be > 0, got ${result.elapsedMs}`);
    },
  );
});

test('an authoring bug (MAY reported violated) surfaces as inconclusive, not a finding', async () => {
  // Uses a real MAY requirement. The runner must catch the InvalidExpectationError
  // from judge() and report our bug as inconclusive — never as the server's fault.
  const MAY_REQ = 'R-5321-2.4-h' as const; // "servers MAY clear the high-order bit or reject"
  await withServer(
    async (s) => {
      s.send(crlf`220 mail.test`);
    },
    async (port) => {
      const tc = testCase({
        id: 'misgraded-may',
        requirement: MAY_REQ,
        intent: 'incorrectly treats a MAY as violable',
        rationale: 'authoring-error handling',
        run: async (): Promise<Judgement> => ({ kind: 'violated', detail: 'did not clear high bit' }),
      });
      const result = await runCase(tc, { connect: { host: '127.0.0.1', port }, fixture });
      assert.equal(result.outcome, 'inconclusive');
      assert.match(
        result.judgement.kind === 'inconclusive' ? result.judgement.reason : '',
        /expectation error/,
      );
    },
  );
});
