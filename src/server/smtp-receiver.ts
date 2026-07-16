/**
 * A minimal, conformant SMTP receiver — the first live server assembled from the
 * test bed.
 *
 * It accepts a mail transaction (EHLO / MAIL / RCPT / DATA / QUIT) over a socket,
 * un-stuffs the DATA payload (RFC 5321 §4.5.2), and hands the delivered message to a
 * pluggable handler — which the integration test wires to the SQLite mailbox. Built
 * on raw sockets and Buffers so delivery is byte-exact and nothing normalises away
 * the content under test. This is deliberately the bare minimum that a client can
 * deliver through; AUTH, SIZE, STARTTLS and the receiver's full conformance surface
 * are enforced elsewhere in the bed and wired in as the server grows.
 */

import net from 'node:net';
import { CR, LF, DOT } from '../wire/bytes.ts';

export interface DeliveredMessage {
  readonly from: string;
  readonly recipients: readonly string[];
  /** The message content, DATA-un-stuffed, byte-exact. */
  readonly data: Buffer;
}

export type DeliveryHandler = (message: DeliveredMessage) => void;

const write = (sock: net.Socket, line: string): void => {
  sock.write(Buffer.from(`${line}\r\n`, 'latin1'));
};

const addrOf = (line: string): string => /<([^>]*)>/.exec(line)?.[1] ?? '';

/** Un-stuff a DATA payload: a leading dot on a line is removed (inverse of dot-stuffing). */
function unstuff(payload: Buffer): Buffer {
  const out: Buffer[] = [];
  let start = 0;
  let atLineStart = true;
  for (let i = 0; i < payload.length; i++) {
    if (atLineStart && payload[i] === DOT) {
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

/** Find <CRLF>.<CRLF>; return the index just past it, or -1. */
function findEndOfData(buf: Buffer): number {
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === DOT && buf[i + 3] === CR && buf[i + 4] === LF) return i + 5;
  }
  if (buf.length >= 3 && buf[0] === DOT && buf[1] === CR && buf[2] === LF) return 3;
  return -1;
}

export class SmtpReceiver {
  readonly port: number;
  readonly #server: net.Server;
  readonly #handler: DeliveryHandler;
  readonly #domain: string;

  private constructor(server: net.Server, port: number, handler: DeliveryHandler, domain: string) {
    this.#server = server;
    this.port = port;
    this.#handler = handler;
    this.#domain = domain;
  }

  static start(handler: DeliveryHandler, domain = 'mail.example.com'): Promise<SmtpReceiver> {
    const server = net.createServer();
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        const receiver = new SmtpReceiver(server, port, handler, domain);
        server.on('connection', (sock) => receiver.#handle(sock));
        resolve(receiver);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #handle(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
    let from = '';
    let recipients: string[] = [];
    let inData = false;

    sock.on('error', () => {});
    write(sock, `220 ${this.#domain} ESMTP`);

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      for (;;) {
        if (inData) {
          const eod = findEndOfData(buf);
          if (eod === -1) break;
          const payload = eod >= 5 ? buf.subarray(0, eod - 5) : Buffer.alloc(0);
          this.#handler({ from, recipients: [...recipients], data: unstuff(payload) });
          from = '';
          recipients = [];
          inData = false;
          buf = buf.subarray(eod);
          write(sock, '250 2.0.0 message stored');
          continue;
        }
        const nl = buf.indexOf(Buffer.from([CR, LF]));
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString('latin1');
        buf = buf.subarray(nl + 2);
        const verb = line.split(/\s+/)[0]?.toUpperCase() ?? '';
        switch (verb) {
          case 'EHLO':
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
              write(sock, '503 5.5.1 need RCPT');
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
            write(sock, '500 5.5.2 command not recognized');
        }
      }
    });
  }
}
