/**
 * A minimal, conformant SMTP receiver — a live server assembled from the test bed —
 * with optional STARTTLS and submission AUTH.
 *
 * It accepts a mail transaction (EHLO / MAIL / RCPT / DATA / QUIT) over a socket,
 * un-stuffs the DATA payload (RFC 5321 §4.5.2), and hands the delivered message to a
 * pluggable handler (the integration test wires it to the SQLite mailbox). With
 * STARTTLS enabled it advertises the extension and upgrades the connection to TLS —
 * and, crucially, DISCARDS any buffered plaintext at the upgrade (RFC 3207 §4.2, the
 * STARTTLS-command-injection defence). In submission mode it requires a successful
 * SASL PLAIN AUTH (over TLS only, ADR 0007) before accepting mail. Raw sockets +
 * Buffers so delivery is byte-exact.
 */

import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { CR, LF, DOT } from '../wire/bytes.ts';
import { countReceived } from './received.ts';

/** MAIL_DEBUG=1 logs each received command line (AUTH redacted) to stderr. */
const DEBUG = process.env.MAIL_DEBUG === '1';

export interface DeliveredMessage {
  readonly from: string;
  readonly recipients: readonly string[];
  /** The message content, DATA-un-stuffed, byte-exact. */
  readonly data: Buffer;
  /** Whether the connection was over TLS when the message was delivered. */
  readonly overTls: boolean;
  /** The name the client gave in EHLO/HELO (for the Received trace line). */
  readonly helo: string;
  /** The client's remote IP address (for the Received trace line). */
  readonly remoteAddress: string;
  /** Whether the client authenticated (submission) — selects ESMTPSA vs ESMTP(S). */
  readonly authenticated: boolean;
}

export type DeliveryHandler = (message: DeliveredMessage) => void;

export interface ReceiverOptions {
  readonly domain?: string;
  /** Bind host (default 127.0.0.1). */
  readonly host?: string;
  /** Bind port (default 0 — an ephemeral port, for tests). */
  readonly port?: number;
  /** Enable STARTTLS, advertising it after EHLO and upgrading on the command. */
  readonly tls?: { readonly key: string; readonly cert: string };
  /** DEFECT: keep the receive buffer across STARTTLS (the injection vulnerability). */
  readonly retainBufferAcrossStarttls?: boolean;
  /** Maximum message size in octets (RFC 1870 SIZE). Advertised in EHLO and
   *  enforced during DATA so an over-large message can't exhaust memory.
   *  Undefined = no limit (tests). */
  readonly maxMessageSize?: number;
  /** Reject a message carrying at least this many Received: headers as a mail
   *  loop (RFC 5321 §6.3; SHOULD be large, ≥100). Undefined = no loop check. */
  readonly maxReceivedHops?: number;
  /** Submission mode: require a successful AUTH before MAIL (rejects unauthenticated mail 530). */
  readonly requireAuth?: boolean;
  /** Verify a SASL PLAIN (username, password); wired to the account store by the caller. */
  readonly authenticate?: (username: string, password: string) => boolean;
}

const addrOf = (line: string): string => /<([^>]*)>/.exec(line)?.[1] ?? '';
const NUL = String.fromCharCode(0);

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
  #inTransaction = false; // a reverse-path buffer exists (MAIL accepted, not yet reset)
  #tls = false;
  #authed = false;
  #helo = '';
  readonly #remoteAddress: string;
  readonly #handler: DeliveryHandler;
  readonly #domain: string;
  readonly #opts: ReceiverOptions;

  constructor(sock: net.Socket, handler: DeliveryHandler, domain: string, opts: ReceiverOptions) {
    this.#handler = handler;
    this.#domain = domain;
    this.#opts = opts;
    this.#active = sock;
    this.#remoteAddress = sock.remoteAddress ?? '';
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
        // Cap the buffered DATA so an unterminated or oversized message cannot
        // grow memory without bound (RFC 1870 SIZE, enforced on actual bytes).
        const max = this.#opts.maxMessageSize;
        if (max !== undefined && this.#buf.length > max) {
          this.#write('552 5.3.4 message size exceeds fixed maximum message size');
          this.#inData = false;
          this.#from = '';
          this.#recipients = [];
          this.#active.end();
          return;
        }
        const eod = findEndOfData(this.#buf);
        if (eod === -1) break;
        const payload = eod >= 5 ? this.#buf.subarray(0, eod - 5) : Buffer.alloc(0);
        const unstuffed = unstuff(payload);
        // RFC 5321 §6.3: a message carrying too many Received hops is looping.
        const hops = this.#opts.maxReceivedHops;
        if (hops !== undefined && countReceived(unstuffed) >= hops) {
          this.#write('554 5.4.6 too many Received hops — mail loop detected');
          this.#from = '';
          this.#recipients = [];
          this.#inData = false;
          this.#buf = this.#buf.subarray(eod);
          continue;
        }
        let stored = true;
        try {
          this.#handler({
            from: this.#from,
            recipients: [...this.#recipients],
            data: unstuffed,
            overTls: this.#tls,
            helo: this.#helo,
            remoteAddress: this.#remoteAddress,
            authenticated: this.#authed,
          });
        } catch {
          stored = false; // a store/sign failure is a temporary error, not a crash
        }
        this.#from = '';
        this.#recipients = [];
        this.#inData = false;
        this.#inTransaction = false;
        this.#buf = this.#buf.subarray(eod);
        this.#write(stored ? '250 2.0.0 message stored' : '451 4.3.0 error storing message');
        continue;
      }
      const nl = this.#buf.indexOf(Buffer.from([CR, LF]));
      if (nl === -1) {
        // An unterminated command line must not grow memory without bound. The
        // §4.5.3.1.4 command-line floor is 512 octets; 64 KiB is a generous cap.
        if (this.#buf.length > 65536) {
          this.#write('500 5.5.2 command line too long');
          this.#active.end();
        }
        break;
      }
      const lineBytes = this.#buf.subarray(0, nl);
      const line = lineBytes.toString('latin1');
      this.#buf = this.#buf.subarray(nl + 2);
      if (DEBUG) process.stderr.write(`[smtp<] ${line.replace(/^(AUTH\s+\S+\s+).*/i, '$1***')}\n`);
      // RFC 5321 §4.1.2: a command carrying an ASCII control octet (the CRLF
      // terminator is already stripped) is invalid — reject 501, never execute it.
      if (lineBytes.some((b) => b < 0x20)) {
        this.#write('501 5.5.2 control character in command');
        continue;
      }
      const verb = line.split(/\s+/)[0]?.toUpperCase() ?? '';
      if (verb === 'STARTTLS' && this.#opts.tls !== undefined) {
        this.#startTls();
        return; // stop processing plaintext; anything left in #buf is discarded
      }
      // A malformed command must never crash the connection or the process.
      try {
        this.#command(verb, line);
      } catch {
        this.#write('451 4.3.0 internal error processing command');
      }
    }
  }

  #command(verb: string, line: string): void {
    switch (verb) {
      case 'EHLO': {
        this.#helo = line.split(/\s+/)[1] ?? '';
        // §4.1.1.1: EHLO/HELO clears any pending transaction (like RSET).
        this.#from = '';
        this.#recipients = [];
        this.#inTransaction = false;
        const ext: string[] = [];
        if (this.#opts.maxMessageSize !== undefined) ext.push(`SIZE ${this.#opts.maxMessageSize}`);
        // We accept 8-bit content byte-exact (bytes, never strings), so advertise
        // 8BITMIME truthfully (RFC 6152). A BODY=8BITMIME on MAIL FROM is accepted
        // (the parser reads the address and ignores trailing params).
        ext.push('8BITMIME');
        if (this.#opts.tls !== undefined && !this.#tls) ext.push('STARTTLS');
        if (this.#opts.authenticate !== undefined && this.#tls) ext.push('AUTH PLAIN');
        if (ext.length === 0) {
          this.#write(`250 ${this.#domain}`);
        } else {
          this.#write(`250-${this.#domain}`);
          for (let i = 0; i < ext.length; i++) this.#write(`${i === ext.length - 1 ? '250 ' : '250-'}${ext[i]}`);
        }
        break;
      }
      case 'AUTH':
        this.#auth(line);
        break;
      case 'HELO':
        this.#helo = line.split(/\s+/)[1] ?? '';
        this.#from = '';
        this.#recipients = [];
        this.#inTransaction = false;
        this.#write(`250 ${this.#domain}`);
        break;
      case 'MAIL': {
        if (this.#opts.requireAuth === true && !this.#authed) {
          this.#write('530 5.7.0 Authentication required');
          break;
        }
        // RFC 1870: a SIZE= declaration already over the limit is rejected up
        // front, before the client transmits (the real check is on actual bytes).
        const max = this.#opts.maxMessageSize;
        const declared = /\bSIZE=(\d+)/i.exec(line);
        if (max !== undefined && declared !== null && Number(declared[1]) > max) {
          this.#write('552 5.3.4 message size exceeds fixed maximum message size');
          break;
        }
        this.#from = addrOf(line);
        this.#recipients = [];
        this.#inTransaction = true;
        this.#write('250 2.1.0 Ok');
        break;
      }
      case 'RCPT':
        // §4.1.4: RCPT with no reverse-path buffer is out of order — reject 503.
        if (!this.#inTransaction) {
          this.#write('503 5.5.1 need MAIL before RCPT');
          break;
        }
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
        this.#inTransaction = false;
        this.#write('250 2.0.0 Ok');
        break;
      // VRFY MUST be recognised (§4.5.1) — never answer 500. We don't verify
      // addresses, so 252 "cannot VRFY but will attempt delivery" (§3.5.3, §7.3).
      // None of these touch the transaction buffers (§4.1.1.6/.7/.8).
      case 'VRFY':
        this.#write('252 2.1.5 Cannot VRFY user, but will accept message and attempt delivery');
        break;
      case 'EXPN':
        this.#write('502 5.5.1 EXPN not supported');
        break;
      case 'HELP':
        this.#write('214 2.0.0 This is a minimal RFC 5321 SMTP service');
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

  /** Handle "AUTH PLAIN <base64>". SASL PLAIN is offered only over TLS (ADR 0007). */
  #auth(line: string): void {
    if (this.#opts.authenticate === undefined) {
      this.#write('504 5.5.4 AUTH not supported');
      return;
    }
    if (!this.#tls) {
      this.#write('538 5.7.11 Encryption required for AUTH'); // no plaintext AUTH
      return;
    }
    if (this.#authed) {
      this.#write('503 5.5.1 already authenticated');
      return;
    }
    const parts = line.split(/\s+/);
    if ((parts[1] ?? '').toUpperCase() !== 'PLAIN' || parts[2] === undefined) {
      this.#write('504 5.5.4 unsupported AUTH mechanism');
      return;
    }
    // SASL PLAIN payload: authzid NUL authcid NUL passwd.
    const decoded = Buffer.from(parts[2], 'base64').toString('latin1').split(NUL);
    const username = decoded[1] ?? '';
    const password = decoded[2] ?? '';
    if (this.#opts.authenticate(username, password)) {
      this.#authed = true;
      this.#write('235 2.7.0 Authentication successful');
    } else {
      this.#write('535 5.7.8 Authentication credentials invalid');
    }
  }

  #startTls(): void {
    const raw = this.#active as net.Socket;
    this.#write('220 2.0.0 Ready to start TLS');
    raw.removeAllListeners('data');
    // RFC 3207 §4.2: discard the buffer (and transaction state) at the upgrade, so
    // any plaintext injected before the handshake is not executed post-TLS.
    this.#buf = this.#opts.retainBufferAcrossStarttls === true ? this.#buf : Buffer.alloc(0);
    this.#from = '';
    this.#recipients = [];
    this.#inData = false;

    const secure = new tls.TLSSocket(raw, { isServer: true, key: this.#opts.tls!.key, cert: this.#opts.tls!.cert });
    this.#active = secure;
    this.#tls = true;
    this.#bind(secure);
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
  readonly #sockets: Set<net.Socket>;

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
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
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
