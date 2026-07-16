/**
 * A minimal, conformant SMTP receiver — a live server assembled from the test bed —
 * with optional STARTTLS.
 *
 * It accepts a mail transaction (EHLO / MAIL / RCPT / DATA / QUIT) over a socket,
 * un-stuffs the DATA payload (RFC 5321 §4.5.2), and hands the delivered message to a
 * pluggable handler (the integration test wires it to the SQLite mailbox). With
 * STARTTLS enabled it advertises the extension and upgrades the connection to TLS —
 * and, crucially, DISCARDS any buffered plaintext at the upgrade (RFC 3207 §4.2, the
 * STARTTLS-command-injection defence). Raw sockets + Buffers so delivery is byte-exact.
 */

import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { CR, LF, DOT } from '../wire/bytes.ts';

export interface DeliveredMessage {
  readonly from: string;
  readonly recipients: readonly string[];
  /** The message content, DATA-un-stuffed, byte-exact. */
  readonly data: Buffer;
  /** Whether the connection was over TLS when the message was delivered. */
  readonly overTls: boolean;
}

export type DeliveryHandler = (message: DeliveredMessage) => void;

export interface ReceiverOptions {
  readonly domain?: string;
  /** Enable STARTTLS, advertising it after EHLO and upgrading on the command. */
  readonly tls?: { readonly key: string; readonly cert: string };
  /** DEFECT: keep the receive buffer across STARTTLS (the injection vulnerability). */
  readonly retainBufferAcrossStarttls?: boolean;
}

const addrOf = (line: string): string => /<([^>]*)>/.exec(line)?.[1] ?? '';

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

function findEndOfData(buf: Buffer): number {
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === DOT && buf[i + 3] === CR && buf[i + 4] === LF) return i + 5;
  }
  if (buf.length >= 3 && buf[0] === DOT && buf[1] === CR && buf[2] === LF) return 3;
  return -1;
}

class Connection {
  #active: Duplex;
  #buf = Buffer.alloc(0);
  #from = '';
  #recipients: string[] = [];
  #inData = false;
  #tls = false;
  readonly #handler: DeliveryHandler;
  readonly #domain: string;
  readonly #opts: ReceiverOptions;

  constructor(sock: net.Socket, handler: DeliveryHandler, domain: string, opts: ReceiverOptions) {
    this.#handler = handler;
    this.#domain = domain;
    this.#opts = opts;
    this.#active = sock;
    this.#bind(sock);
    this.#write(`220 ${domain} ESMTP`);
  }

  #bind(stream: Duplex): void {
    stream.on('data', (chunk: Buffer) => this.#onData(chunk));
    stream.on('error', () => {});
  }

  #write(line: string): void {
    this.#active.write(Buffer.from(`${line}\r\n`, 'latin1'));
  }

  #onData(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, Buffer.from(chunk)]);
    for (;;) {
      if (this.#inData) {
        const eod = findEndOfData(this.#buf);
        if (eod === -1) break;
        const payload = eod >= 5 ? this.#buf.subarray(0, eod - 5) : Buffer.alloc(0);
        this.#handler({ from: this.#from, recipients: [...this.#recipients], data: unstuff(payload), overTls: this.#tls });
        this.#from = '';
        this.#recipients = [];
        this.#inData = false;
        this.#buf = this.#buf.subarray(eod);
        this.#write('250 2.0.0 message stored');
        continue;
      }
      const nl = this.#buf.indexOf(Buffer.from([CR, LF]));
      if (nl === -1) break;
      const line = this.#buf.subarray(0, nl).toString('latin1');
      this.#buf = this.#buf.subarray(nl + 2);
      const verb = line.split(/\s+/)[0]?.toUpperCase() ?? '';
      if (verb === 'STARTTLS' && this.#opts.tls !== undefined) {
        this.#startTls();
        return; // stop processing plaintext; anything left in #buf is discarded below
      }
      this.#command(verb, line);
    }
  }

  #command(verb: string, line: string): void {
    switch (verb) {
      case 'EHLO':
        if (this.#opts.tls !== undefined && !this.#tls) {
          this.#write(`250-${this.#domain}`);
          this.#write('250 STARTTLS');
        } else {
          this.#write(`250 ${this.#domain}`);
        }
        break;
      case 'HELO':
        this.#write(`250 ${this.#domain}`);
        break;
      case 'MAIL':
        this.#from = addrOf(line);
        this.#recipients = [];
        this.#write('250 2.1.0 Ok');
        break;
      case 'RCPT':
        this.#recipients.push(addrOf(line));
        this.#write('250 2.1.5 Ok');
        break;
      case 'DATA':
        if (this.#recipients.length === 0) {
          this.#write('503 5.5.1 need RCPT');
          break;
        }
        this.#inData = true;
        this.#write('354 End data with <CR><LF>.<CR><LF>');
        break;
      case 'RSET':
        this.#from = '';
        this.#recipients = [];
        this.#write('250 2.0.0 Ok');
        break;
      case 'NOOP':
        this.#write('250 2.0.0 Ok');
        break;
      case 'QUIT':
        this.#write('221 2.0.0 Bye');
        this.#active.end();
        break;
      default:
        this.#write('500 5.5.2 command not recognized');
    }
  }

  #startTls(): void {
    const raw = this.#active as net.Socket;
    this.#write('220 2.0.0 Ready to start TLS');
    raw.removeAllListeners('data');
    // RFC 3207 §4.2: discard the buffer (and the transaction state) at the upgrade,
    // so any plaintext injected before the handshake is not executed post-TLS.
    this.#buf = this.#opts.retainBufferAcrossStarttls === true ? this.#buf : Buffer.alloc(0);
    this.#from = '';
    this.#recipients = [];
    this.#inData = false;

    const secure = new tls.TLSSocket(raw, { isServer: true, key: this.#opts.tls!.key, cert: this.#opts.tls!.cert });
    this.#active = secure;
    this.#tls = true;
    this.#bind(secure);
    // If a retained buffer holds pipelined plaintext (the defect), process it now.
    if (this.#buf.length > 0) {
      const held = this.#buf;
      this.#buf = Buffer.alloc(0);
      this.#onData(held);
    }
  }
}

export class SmtpReceiver {
  readonly port: number;
  readonly #server: net.Server;
  readonly #sockets = new Set<net.Socket>();

  private constructor(server: net.Server, port: number, sockets: Set<net.Socket>) {
    this.#server = server;
    this.port = port;
    this.#sockets = sockets;
  }

  static start(handler: DeliveryHandler, options: ReceiverOptions = {}): Promise<SmtpReceiver> {
    const domain = options.domain ?? 'mail.example.com';
    const server = net.createServer();
    const sockets = new Set<net.Socket>();
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        server.on('connection', (sock) => {
          sockets.add(sock);
          sock.on('close', () => sockets.delete(sock));
          new Connection(sock, handler, domain, options);
        });
        resolve(new SmtpReceiver(server, port, sockets));
      });
    });
  }

  close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}
