/**
 * A minimal IMAP client for driving the assembled server over a real socket.
 *
 * The IMAP tests in this tree each grew their own ad-hoc reader, which is fine for one assertion
 * and poor for a conformance corpus: the requirements in the register are frequently about
 * ORDERING and about UNSOLICITED data, and both are lost by a reader that waits for one regular
 * expression and throws the rest away. So this keeps everything, in order, and hands back the
 * untagged responses that arrived before each tagged completion.
 *
 * Deliberately not an IMAP implementation. It frames tagged commands, handles literal
 * continuations, and returns lines. Interpreting them is the test's job — a client that parsed
 * responses into a model would be a second implementation of the thing under test, and the two
 * would agree with each other rather than with the RFC.
 */

import tls from 'node:tls';
import net from 'node:net';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ImapReply {
  readonly tag: string;
  readonly status: 'OK' | 'NO' | 'BAD';
  /** The tagged completion line in full, e.g. `a3 OK [READ-WRITE] SELECT completed`. */
  readonly line: string;
  /** Untagged lines received before the tagged completion, in the order they arrived. */
  readonly untagged: readonly string[];
}

export class ImapClientError extends Error {}

export class ImapClient {
  readonly #sock: tls.TLSSocket | net.Socket;
  #buf = '';
  #lines: string[] = [];
  #tag = 0;
  #greeting = '';

  private constructor(sock: tls.TLSSocket | net.Socket) {
    this.#sock = sock;
    sock.setEncoding('latin1');
    sock.on('data', (d: string) => {
      this.#buf += d;
      for (;;) {
        const at = this.#buf.indexOf('\r\n');
        if (at === -1) break;
        this.#lines.push(this.#buf.slice(0, at));
        this.#buf = this.#buf.slice(at + 2);
      }
    });
    sock.on('error', () => {});
  }

  /** Connect over implicit TLS and consume the greeting. */
  static async connect(port: number, host = '127.0.0.1'): Promise<ImapClient> {
    const sock = tls.connect({ host, port, rejectUnauthorized: false });
    sock.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      sock.once('secureConnect', () => resolve());
      sock.once('error', reject);
    });
    const client = new ImapClient(sock);
    client.#greeting = await client.#nextLine(10_000);
    return client;
  }

  /** The untagged greeting, which carries the server's initial capabilities. */
  get greeting(): string {
    return this.#greeting;
  }

  get closed(): boolean {
    return this.#sock.destroyed;
  }

  /** A fresh tag, in the conventional `a1`, `a2` sequence. */
  nextTag(): string {
    this.#tag += 1;
    return `a${this.#tag}`;
  }

  /** Write raw bytes with no framing and no waiting — for pipelining and malformed-input cases. */
  writeRaw(text: string): void {
    this.#sock.write(text, 'latin1');
  }

  async #nextLine(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = this.#lines.shift();
      if (line !== undefined) return line;
      if (this.#sock.destroyed) throw new ImapClientError('the server closed the connection');
      if (Date.now() > deadline) throw new ImapClientError(`timed out waiting for a line (buffered: ${JSON.stringify(this.#buf.slice(0, 200))})`);
      await delay(2);
    }
  }

  /** Read until the completion for `tag`, keeping every untagged line that arrives first. */
  async readTagged(tag: string, timeoutMs = 15_000): Promise<ImapReply> {
    const untagged: string[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = await this.#nextLine(Math.max(1, deadline - Date.now()));
      const m = new RegExp(`^${tag} (OK|NO|BAD)\\b`).exec(line);
      if (m !== null) return { tag, status: m[1] as ImapReply['status'], line, untagged };
      untagged.push(line);
    }
  }

  /** Send one command and read to its completion. */
  async command(text: string, timeoutMs = 15_000): Promise<ImapReply> {
    const tag = this.nextTag();
    this.writeRaw(`${tag} ${text}\r\n`);
    return this.readTagged(tag, timeoutMs);
  }

  /**
   * Send a command whose last argument is a literal, handling the continuation.
   *
   * The continuation request is part of the protocol under test, so a failure to send one is
   * reported as such rather than as a timeout on the command.
   */
  async commandWithLiteral(prefix: string, payload: string, timeoutMs = 20_000): Promise<ImapReply> {
    const tag = this.nextTag();
    this.writeRaw(`${tag} ${prefix} {${Buffer.byteLength(payload, 'latin1')}}\r\n`);
    const deadline = Date.now() + timeoutMs;
    const untagged: string[] = [];
    for (;;) {
      const line = await this.#nextLine(Math.max(1, deadline - Date.now()));
      if (line.startsWith('+ ')) break;
      const m = new RegExp(`^${tag} (OK|NO|BAD)\\b`).exec(line);
      // A refusal before the continuation is a legitimate answer (an over-limit APPEND), not a fault.
      if (m !== null) return { tag, status: m[1] as ImapReply['status'], line, untagged };
      untagged.push(line);
    }
    this.writeRaw(`${payload}\r\n`);
    const rest = await this.readTagged(tag, Math.max(1, deadline - Date.now()));
    return { ...rest, untagged: [...untagged, ...rest.untagged] };
  }

  /**
   * Untagged lines that have arrived unprompted, e.g. because another session changed the mailbox.
   *
   * Give the server a moment first: an unsolicited response is by definition not something we can
   * wait for deterministically, and asserting on an empty buffer would make the test a race.
   */
  async unsolicited(settleMs = 150): Promise<string[]> {
    await delay(settleMs);
    const out = this.#lines;
    this.#lines = [];
    return out;
  }

  async logout(): Promise<ImapReply> {
    return this.command('LOGOUT');
  }

  close(): void {
    this.#sock.destroy();
  }
}

/** Untagged lines matching a response name, e.g. `EXISTS` or `FETCH`. */
export function untaggedOf(reply: ImapReply, name: string): string[] {
  const re = new RegExp(`^\\* (?:\\d+ )?${name}\\b`, 'i');
  return reply.untagged.filter((l) => re.test(l));
}

/** Does this tagged line carry the given response code, as a prefix of its text? */
export function hasResponseCodePrefix(line: string, code: string): boolean {
  return new RegExp(`^\\S+ (?:OK|NO|BAD) \\[${code}(?:[ \\]])`, 'i').test(line);
}
