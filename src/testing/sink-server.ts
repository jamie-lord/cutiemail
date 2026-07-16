/**
 * The receiving sink: a minimal SMTP receiver that CAPTURES delivered messages
 * so the suite can inspect what a server under test actually stored/forwarded.
 *
 * This is the seam decision 0005 named as the revisit trigger. Almost all of the
 * transparency / delivery-integrity surface of RFC 5321 — dot-un-stuffing
 * (§4.5.2), case preservation of the local-part (§2.4-c/-d), Received/trace
 * insertion (§4.4), non-modification of the body (§2.4-i) — is invisible from the
 * CLIENT side of a connection: it lives in the DELIVERED message, downstream of
 * the transaction. The only way to test it is to be the next hop: run a receiver,
 * have the system under test relay to it, and read the bytes that arrive.
 *
 * The sink is deliberately conformant and boring. It is NOT a mutant — its job is
 * to receive faithfully (correct dot-un-stuffing, exact byte capture) so that any
 * corruption in a captured message is attributable to the server under test, not
 * to the sink. Built on raw sockets and Buffers, like the mutant server, so the
 * capture is byte-exact and no library normalises away the very thing under test.
 */

import net from 'node:net';
import { CR, LF, DOT } from '../wire/bytes.ts';

export interface SinkMessage {
  /** The reverse-path from MAIL FROM, exactly as received (angle brackets stripped). */
  readonly from: string;
  /** The forward-paths from RCPT TO, in order, exactly as received. */
  readonly recipients: readonly string[];
  /**
   * The message content after DATA, dot-UN-stuffed and with the terminating
   * <CRLF>.<CRLF> removed — i.e. the bytes a conformant receiver would store.
   */
  readonly data: Buffer;
}

const write = (sock: net.Socket, s: string): void => {
  sock.write(Buffer.from(s + '\r\n', 'latin1'));
};

/** Extract the address inside the LAST <...> of a MAIL/RCPT argument. */
function addrOf(line: string): string {
  const m = /<([^>]*)>/.exec(line);
  return m?.[1] ?? '';
}

/**
 * Un-stuff a captured DATA payload (§4.5.2): a line beginning with a dot has that
 * leading dot removed. `payload` is the bytes BEFORE the terminating
 * <CRLF>.<CRLF>. Operates on CRLF-delimited lines — the exact inverse of
 * bytes.ts `dotStuff`.
 */
export function unstuff(payload: Buffer): Buffer {
  const out: Buffer[] = [];
  let start = 0;
  let atLineStart = true;
  for (let i = 0; i < payload.length; i++) {
    if (atLineStart && payload[i] === DOT) {
      // Emit the line up to (not including) this leading dot, then skip the dot.
      out.push(payload.subarray(start, i));
      start = i + 1;
      atLineStart = false;
      continue;
    }
    if (payload[i] === CR && payload[i + 1] === LF) {
      atLineStart = true;
      i++;
      continue;
    }
    atLineStart = false;
  }
  out.push(payload.subarray(start));
  return Buffer.concat(out);
}

/** Find <CRLF>.<CRLF> (end of data). Returns the index just past it, or null. */
function findEndOfData(buf: Buffer): number | null {
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === DOT && buf[i + 3] === CR && buf[i + 4] === LF) {
      return i + 5;
    }
  }
  // A leading "." CRLF at the very start (empty message body).
  if (buf.length >= 3 && buf[0] === DOT && buf[1] === CR && buf[2] === LF) return 3;
  return null;
}

export class SinkServer {
  readonly port: number;
  #server: net.Server;
  readonly #received: SinkMessage[] = [];
  readonly #domain: string;

  private constructor(server: net.Server, port: number, domain: string) {
    this.#server = server;
    this.port = port;
    this.#domain = domain;
  }

  /** Every message delivered to the sink so far, in arrival order. */
  get received(): readonly SinkMessage[] {
    return this.#received;
  }

  /** The most recently delivered message, or undefined if none. */
  get last(): SinkMessage | undefined {
    return this.#received[this.#received.length - 1];
  }

  static async start(domain = 'sink.test'): Promise<SinkServer> {
    const server = net.createServer();
    const sink = await new Promise<SinkServer>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve(new SinkServer(server, port, domain));
      });
    });
    server.on('connection', (sock) => sink.#handle(sock));
    return sink;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #handle(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
    let from = '';
    let recipients: string[] = [];
    let inData = false;

    sock.on('error', () => {});
    write(sock, `220 ${this.#domain} ESMTP sink`);

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);

      for (;;) {
        if (inData) {
          const eod = findEndOfData(buf);
          if (eod === null) break;
          // The stored body is everything BEFORE the terminating <CRLF>.<CRLF>. That
          // sequence is 5 octets (CR LF . CR LF), and its leading <CRLF> is the line
          // terminator of the last body line, not body content — so the body ends at
          // eod-5. The alternative form found by findEndOfData is a bare ".<CRLF>" at
          // the very start (eod===3), which is an empty message.
          const payload = eod >= 5 ? buf.subarray(0, eod - 5) : Buffer.alloc(0);
          this.#received.push({ from, recipients: [...recipients], data: unstuff(payload) });
          from = '';
          recipients = [];
          inData = false;
          buf = buf.subarray(eod);
          write(sock, '250 2.0.0 message accepted for delivery');
          continue;
        }

        const nl = buf.indexOf(Buffer.from([CR, LF]));
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString('latin1');
        buf = buf.subarray(nl + 2);
        const verb = line.split(/\s+/)[0]?.toUpperCase() ?? '';

        switch (verb) {
          case 'EHLO':
            write(sock, `250 ${this.#domain} at your service`);
            break;
          case 'HELO':
            write(sock, `250 ${this.#domain}`);
            break;
          case 'MAIL':
            from = addrOf(line);
            recipients = [];
            write(sock, '250 2.1.0 Ok');
            break;
          case 'RCPT':
            recipients.push(addrOf(line));
            write(sock, '250 2.1.5 Ok');
            break;
          case 'DATA':
            if (recipients.length === 0) {
              write(sock, '503 5.5.1 Error: need RCPT command');
              break;
            }
            inData = true;
            write(sock, '354 End data with <CR><LF>.<CR><LF>');
            break;
          case 'RSET':
            from = '';
            recipients = [];
            write(sock, '250 2.0.0 Ok');
            break;
          case 'NOOP':
            write(sock, '250 2.0.0 Ok');
            break;
          case 'QUIT':
            write(sock, '221 2.0.0 Bye');
            sock.end();
            return;
          default:
            write(sock, '500 5.5.2 Error: command not recognized');
        }
      }
    });
  }
}

/** Run a body against a fresh sink, always tearing it down. */
export async function withSink<T>(fn: (sink: SinkServer) => Promise<T>): Promise<T> {
  const sink = await SinkServer.start();
  try {
    return await fn(sink);
  } finally {
    await sink.close();
  }
}
