/**
 * The IMAP4rev2 command-parsing corpus (RFC 9051 §2.2.1), with negative controls.
 * Each case proves the parser accepts a well-formed command AND enforces one
 * command-line rule, with the matching defect DETECTED. Cases cite compile-checked
 * ImapRequirementIds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, hasCommandAnomaly } from './command.ts';
import { imapRequirement } from '../register/imap/index.ts';
import type { ImapRequirementId } from '../register/imap/index.ts';

const C = (s: string): Buffer => Buffer.from(s, 'latin1');
const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);

test('sanity: a well-formed command parses into tag/command/args', () => {
  const cmd = parseCommand(C('a1 LOGIN alice secret\r\n'));
  assert.ok(cmd.valid);
  assert.equal(cmd.tag, 'a1');
  assert.equal(cmd.command, 'LOGIN');
  assert.deepEqual([...cmd.args], ['alice', 'secret']);
});

test('R-9051-2.2.1-a: strict spacing is enforced (acceptSloppySpacing caught)', () => {
  cites('R-9051-2.2.1-a');
  assert.ok(parseCommand(C('a1 NOOP')).valid, 'single spaces are fine');
  assert.ok(!parseCommand(C('a1  NOOP')).valid, 'a doubled space is a syntax error');
  assert.ok(!parseCommand(C(' a1 NOOP')).valid, 'a leading space is a syntax error');
  assert.ok(!parseCommand(C('a1 NOOP ')).valid, 'a trailing space is a syntax error');
  assert.ok(!parseCommand(C('a1')).valid, 'a command with no command word is incomplete');
  // Negative control: tolerating sloppy spacing.
  assert.ok(parseCommand(C('a1  NOOP'), { acceptSloppySpacing: true }).valid, 'acceptSloppySpacing must be detectable');
});

test('a "*" or "+" tag is rejected (those are reserved for responses)', () => {
  cites('R-9051-2.2.1-a');
  assert.ok(hasCommandAnomaly(parseCommand(C('* NOOP')), 'invalid-tag'));
  assert.ok(hasCommandAnomaly(parseCommand(C('+ NOOP')), 'invalid-tag'));
});

test('R-9051-2.2.1-b: a reused tag is accepted by the server (rejectTagReuse caught)', () => {
  cites('R-9051-2.2.1-b');
  const seen = new Set<string>();
  assert.ok(parseCommand(C('a1 NOOP'), {}, seen).valid, 'first use of a1');
  assert.ok(parseCommand(C('a1 NOOP'), {}, seen).valid, 'a server MUST accept the reused tag');
  // Negative control: rejecting reuse fails the second command.
  const seen2 = new Set<string>();
  parseCommand(C('a1 NOOP'), { rejectTagReuse: true }, seen2);
  assert.ok(!parseCommand(C('a1 NOOP'), { rejectTagReuse: true }, seen2).valid, 'rejectTagReuse must be detectable');
});
