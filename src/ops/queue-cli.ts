/**
 * `queue` + `dead-letter` — the operator's view of outbound mail (backlog B5).
 *
 * The evidence (docs/BACKLOG.md): the silent-drop fear — "how could you know if
 * any emails you send are getting silently dropped?" Dead-letter retention was
 * built so no message is ever lost silently, but retention without
 * inspectability is a promise the operator can't check. This is the thin
 * presentation layer over the existing store API:
 *
 *   queue list                what is waiting to go out, and when it retries
 *   dead-letter list          what delivery has permanently given up on
 *   dead-letter show <id>     metadata + headers (--raw streams the full bytes,
 *                             suitable for `> message.eml`)
 *   dead-letter requeue <id>  put it back in the live queue for another attempt
 *   dead-letter purge <id>    drop the retained copy (explicit, per-message)
 *
 * Requeue/purge reuse the transactional store operations; nothing here invents
 * new queue semantics.
 */

import { existsSync } from 'node:fs';
import { SqliteQueue, type DeadLetterEntry, type QueueEntry } from '../store/sqlite-queue.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import type { OpsIo } from './cli.ts';

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** "in 42s" / "38m ago" — the operator question is always "when / how stale". */
function relative(ms: number, now: number): string {
  const d = ms - now;
  const abs = Math.abs(d);
  const unit = abs >= 3_600_000 ? `${Math.round(abs / 3_600_000)}h` : abs >= 60_000 ? `${Math.round(abs / 60_000)}m` : `${Math.round(abs / 1000)}s`;
  return d >= 0 ? `in ${unit}` : `${unit} ago`;
}

const QUEUE_USAGE = [
  'usage: node src/main.ts queue list [--db <control.db>]',
  '',
  'Pending outbound messages: recipients, attempts so far, and when the next',
  'delivery attempt is due. The control database is MAIL_CONTROL_DB or --db.',
].join('\n');

const DL_USAGE = [
  'usage: node src/main.ts dead-letter <list|show|requeue|purge> [id] [--raw] [--db <control.db>]',
  '',
  'Messages the relay permanently gave up on, retained instead of dropped:',
  '  list          every retained message with its final error',
  '  show <id>     metadata and headers; --raw streams the complete message to',
  '                stdout (redirect to a file to get a .eml)',
  '  requeue <id>  move it back into the live queue for a fresh delivery attempt',
  '  purge <id>    delete the retained copy (the only way one is ever discarded)',
].join('\n');

interface ParsedArgs {
  readonly positional: string[];
  readonly dbPath: string;
  readonly raw: boolean;
}
function parseArgs(args: string[], env: Record<string, string | undefined>): ParsedArgs | string {
  const positional: string[] = [];
  let dbPath = env.MAIL_CONTROL_DB ?? 'control.db';
  let raw = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--db') dbPath = args[++i] ?? dbPath;
    else if (a === '--raw') raw = true;
    else if (a === '--help' || a === '-h') return 'help';
    else if (a.startsWith('--')) return `unknown argument ${a}`;
    else positional.push(a);
  }
  return { positional, dbPath, raw };
}

/** Open the queue store, refusing to CREATE a database at a typo'd path. */
function openQueue(dbPath: string, io: OpsIo): SqliteQueue | undefined {
  if (dbPath !== ':memory:' && !existsSync(dbPath)) {
    io.err(`control database ${dbPath} does not exist (set MAIL_CONTROL_DB or --db).`);
    return undefined;
  }
  return SqliteQueue.open(openMailDb(dbPath));
}

function queueLine(e: QueueEntry, now: number): string {
  return `${e.id}  from=<${e.from}> to=${e.recipients.join(',')} attempts=${e.attempts} next=${iso(e.nextAttempt)} (${relative(e.nextAttempt, now)}) size=${e.data.length}`;
}

function deadLetterLine(e: DeadLetterEntry, now: number): string {
  return `${e.id}  from=<${e.from}> to=${e.recipients.join(',')} attempts=${e.attempts} gave-up=${iso(e.deadLettered)} (${relative(e.deadLettered, now)}) size=${e.data.length}\n        ${e.lastError}`;
}

export function runQueue(args: string[], io: OpsIo, env: Record<string, string | undefined>): number {
  const parsed = parseArgs(args, env);
  if (parsed === 'help') {
    io.out(QUEUE_USAGE);
    return 0;
  }
  if (typeof parsed === 'string') {
    io.err(`queue: ${parsed}`);
    io.err(QUEUE_USAGE);
    return 2;
  }
  if (parsed.positional.length !== 1 || parsed.positional[0] !== 'list') {
    io.err(QUEUE_USAGE);
    return 2;
  }
  const queue = openQueue(parsed.dbPath, io);
  if (queue === undefined) return 2;
  // due(∞) = every pending entry regardless of when its next attempt is.
  const entries = queue.due(Number.MAX_SAFE_INTEGER);
  const now = Date.now();
  for (const e of entries) io.out(queueLine(e, now));
  io.out(entries.length === 0 ? 'queue: empty — nothing waiting to go out' : `queue: ${entries.length} message(s) pending`);
  return 0;
}

export function runDeadLetter(
  args: string[],
  io: OpsIo,
  env: Record<string, string | undefined>,
  writeBytes: (b: Buffer) => void = (b) => void process.stdout.write(b),
): number {
  const parsed = parseArgs(args, env);
  if (parsed === 'help') {
    io.out(DL_USAGE);
    return 0;
  }
  if (typeof parsed === 'string') {
    io.err(`dead-letter: ${parsed}`);
    io.err(DL_USAGE);
    return 2;
  }
  const [verb, id] = parsed.positional;
  if (verb === undefined || (verb !== 'list' && id === undefined)) {
    io.err(DL_USAGE);
    return 2;
  }
  const queue = openQueue(parsed.dbPath, io);
  if (queue === undefined) return 2;
  const now = Date.now();
  switch (verb) {
    case 'list': {
      const entries = queue.listDeadLetters();
      for (const e of entries) io.out(deadLetterLine(e, now));
      io.out(entries.length === 0 ? 'dead-letter: empty — nothing has been given up on' : `dead-letter: ${entries.length} retained message(s)`);
      return 0;
    }
    case 'show': {
      const e = queue.getDeadLetter(id!);
      if (e === undefined) {
        io.err(`dead-letter show: no retained message with id ${id}`);
        return 1;
      }
      if (parsed.raw) {
        writeBytes(e.data);
        return 0;
      }
      io.out(deadLetterLine(e, now));
      io.out('');
      // The header section is the useful part for diagnosis; the full bytes are
      // one --raw away. Bytes-never-strings: split on the wire boundary.
      const sep = e.data.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
      const headers = sep === -1 ? e.data : e.data.subarray(0, sep);
      io.out(headers.toString('latin1'));
      io.out('');
      io.out(`(headers only — full ${e.data.length}-byte message: dead-letter show ${id} --raw)`);
      return 0;
    }
    case 'requeue': {
      const newId = queue.requeueDeadLetter(id!, now);
      if (newId === undefined) {
        io.err(`dead-letter requeue: no retained message with id ${id}`);
        return 1;
      }
      io.out(`dead-letter ${id} requeued as ${newId} — the relay loop picks it up on its next tick (within a minute on the daemon).`);
      return 0;
    }
    case 'purge': {
      if (queue.getDeadLetter(id!) === undefined) {
        io.err(`dead-letter purge: no retained message with id ${id}`);
        return 1;
      }
      queue.purgeDeadLetter(id!);
      io.out(`dead-letter ${id} purged.`);
      return 0;
    }
    default:
      io.err(`dead-letter: unknown verb ${verb}`);
      io.err(DL_USAGE);
      return 2;
  }
}
