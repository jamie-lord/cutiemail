/**
 * Robustness fuzz for the CONDSTORE wire surface (RFC 7162). The mod-sequence
 * modifiers — (CHANGEDSINCE n) on FETCH, (UNCHANGEDSINCE n) on STORE — parse
 * client-supplied text, and the STORE body is re-parsed positionally to cope with the
 * modifier sitting between the seq-set and +FLAGS. That parsing must never crash the
 * server or wedge the connection, whatever malformed thing a client sends: a missing
 * number, a non-numeric argument, an absurd value, an unbalanced paren, a modifier in
 * the wrong place. The contract is not "reject everything correctly" (the server is
 * intentionally lenient) but "never throw, always answer, stay usable".
 *
 * Deterministic: a seeded mulberry32 PRNG (no Math.random) drives the mutations so a
 * failure reproduces exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapServer } from './imap-server.ts';
import { MemoryCatalog } from '../store/memory-catalog.ts';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Session {
  #acc = Buffer.alloc(0);
  readonly sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => (this.#acc = Buffer.concat([this.#acc, Buffer.from(d)])));
    sock.on('error', () => {});
  }
  send(s: string): void {
    this.sock.write(Buffer.from(s, 'latin1'));
  }
  async run(tag: string, cmd: string): Promise<string> {
    const from = this.#acc.length;
    this.send(`${tag} ${cmd}\r\n`);
    for (let i = 0; i < 400; i++) {
      const s = this.#acc.toString('latin1');
      const idx = s.indexOf(`${tag} `, from);
      if (idx >= 0 && /\r\n/.test(s.slice(idx))) return s.slice(from);
      await delay(4);
    }
    throw new Error(`timeout on ${tag} ${cmd}`);
  }
  async waitFor(needle: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (this.#acc.toString('latin1').includes(needle)) return;
      await delay(4);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
  }
}

/** A tiny deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOD_FRAGMENTS = [
  '(CHANGEDSINCE 1)', '(CHANGEDSINCE)', '(CHANGEDSINCE abc)', '(CHANGEDSINCE -5)', '(CHANGEDSINCE 99999999999999999999)',
  '(UNCHANGEDSINCE 0)', '(UNCHANGEDSINCE)', '(UNCHANGEDSINCE x)', '(UNCHANGEDSINCE 2', 'UNCHANGEDSINCE 2)',
  '(MODSEQ)', 'MODSEQ', '()', '((', '))', '(  )', '(CHANGEDSINCE  \t 3 )',
];
const SETS = ['1', '1:*', '1,2', '*', '0', '99', '', '1:', ':1', '1:2:3'];
const OPS = ['+FLAGS', '-FLAGS', 'FLAGS', '+FLAGS.SILENT', 'FLAGS.SILENT', '', '+FLAGS ()', '+FLAGS (\\Seen)', 'BOGUS'];
const FLAGSETS = ['(\\Seen)', '(\\Flagged \\Draft)', '($label1)', '()', '(\\Seen', '\\Seen)', '(\\\\)', ''];

test('malformed CONDSTORE STORE/FETCH never crash the server and leave the connection usable', async () => {
  const catalog = new MemoryCatalog();
  const inbox = catalog.get('INBOX')!;
  for (let i = 0; i < 4; i++) inbox.append(Buffer.from(`Subject: m${i}\r\n\r\nx\r\n`, 'latin1'));
  const server = await ImapServer.start(catalog, { authenticate: () => true });
  const s = new Session(net.connect(server.port, '127.0.0.1'));
  try {
    await s.waitFor('* OK');
    await s.run('a1', 'LOGIN test pw');
    await s.run('a2', 'SELECT INBOX (CONDSTORE)');

    const rng = prng(0xc0d5);
    for (let i = 0; i < 400; i++) {
      const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
      const tag = `f${i}`;
      const kind = rng();
      let cmd: string;
      if (kind < 0.5) {
        // A fuzzed conditional STORE: set, optional modifier, op, flags — in varying order.
        const parts = [pick(SETS)];
        if (rng() < 0.7) parts.push(pick(MOD_FRAGMENTS));
        parts.push(pick(OPS));
        if (rng() < 0.8) parts.push(pick(FLAGSETS));
        cmd = `STORE ${parts.filter((p) => p.length > 0).join(' ')}`;
      } else {
        // A fuzzed FETCH with a CHANGEDSINCE-ish modifier.
        cmd = `FETCH ${pick(SETS)} (FLAGS MODSEQ) ${pick(MOD_FRAGMENTS)}`;
      }
      const resp = await s.run(tag, cmd);
      // Whatever we sent, the server must answer THIS tag with a status line — never
      // hang, never desync onto a different tag, never drop the connection.
      assert.match(resp, new RegExp(`${tag} (OK|NO|BAD)`), `answered its own tag for: ${cmd}`);
    }

    // After all that abuse the connection is still fully functional.
    const noop = await s.run('z1', 'NOOP');
    assert.match(noop, /z1 OK/, 'the connection survives the fuzz run');
    const fetch = await s.run('z2', 'FETCH 1 (FLAGS)');
    assert.match(fetch, /z2 OK/, 'and still serves a normal FETCH');
  } finally {
    s.sock.destroy();
    await server.close();
  }
});
