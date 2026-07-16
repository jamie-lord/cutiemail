/**
 * A scriptable SMTP peer for driving OUTBOUND client tests.
 *
 * This is the mirror of the mutant server. The mutant server is a configurable
 * *receiver* used to prove the receiver suite detects server defects; this is a
 * configurable *peer* used to prove the outbound suite detects CLIENT defects. The
 * system under test here is our reference delivery client (src/client/deliver.ts),
 * and this peer is the far end it talks to.
 *
 * Like the sink server it is built on raw sockets and Buffers so every octet the
 * client transmits is captured exactly — the byte-level obligations (CRLF-only
 * line terminators, the terminating <CRLF>.<CRLF>) can only be checked against the
 * raw bytes, not a normalised parse. Unlike the sink server it is deliberately
 * *scriptable*: reply codes can be overridden (to answer EHLO with 500, or MAIL
 * with a 5yz) and the reply to MAIL can be withheld briefly so a lock-step
 * violation is observable.
 *
 * It is NOT a conformance oracle — like scripted-server.ts it does exactly what it
 * is told and has no opinion about SMTP. Ground truth for server behaviour remains
 * the real MTAs (Exim, mox) under the calibration harness.
 *
 * Terminator tolerance is deliberate: it reads command lines on LF so that a
 * client emitting a bare LF (the emitBareLf defect) still elicits replies and the
 * transaction proceeds far enough for the violation to be captured — rather than
 * deadlocking. The peer's leniency is what lets us OBSERVE the client's
 * non-conformance instead of merely hanging on it.
 */

import net from 'node:net';
import { CR, LF, DOT } from '../wire/bytes.ts';

export interface PeerOptions {
  /** Status for EHLO. Default 250. Set 500 to force the HELO-fallback path. */
  readonly ehloStatus?: number;
  /** Status for HELO. Default 250. */
  readonly heloStatus?: number;
  /** Status for MAIL FROM. Default 250. Set 5xx to test the no-data-after-5yz rule. */
  readonly mailStatus?: number;
  /** Status for RCPT TO. Default 250. Set 5xx to reject recipients. */
  readonly rcptStatus?: number;
  /**
   * Milliseconds to withhold the MAIL reply. During the wait the peer snapshots
   * what it has received; a lock-step client is blocked on the MAIL reply and can
   * have sent nothing further, so the snapshot reveals a pipelining client.
   */
  readonly withholdMailReplyMs?: number;
  /** Called with the raw bytes received so far, at the moment the MAIL line arrives. */
  readonly onMailReceived?: (received: Buffer) => void;
}

const write = (sock: net.Socket, code: number, text: string): void => {
  sock.write(Buffer.from(`${code} ${text}\r\n`, 'latin1'));
};

/** Find <CRLF>.<CRLF> or the bare-LF variant <LF>.<LF>; return index just past it, or -1. */
function findEndOfData(buf: Buffer): number {
  for (let i = 0; i + 2 < buf.length; i++) {
    // CRLF . CRLF
    if (buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === DOT && buf[i + 3] === CR && buf[i + 4] === LF) return i + 5;
    // LF . LF (bare-LF client)
    if (buf[i] === LF && buf[i + 1] === DOT && buf[i + 2] === LF) return i + 3;
  }
  return -1;
}

export interface CapturedDelivery {
  readonly from: string;
  readonly recipients: readonly string[];
  /** The DATA payload as received (still dot-stuffed — the raw wire form). */
  readonly rawData: Buffer;
}

export class ClientPeer {
  readonly port: number;
  #server: net.Server;
  readonly #opts: PeerOptions;
  #received: Buffer = Buffer.alloc(0);
  #deliveries: CapturedDelivery[] = [];

  private constructor(server: net.Server, port: number, opts: PeerOptions) {
    this.#server = server;
    this.port = port;
    this.#opts = opts;
  }

  /** Every octet received from the client so far — the evidence for byte-level checks. */
  get received(): Buffer {
    return this.#received;
  }

  /** Deliveries the client completed (reached DATA end and got a 250). */
  get deliveries(): readonly CapturedDelivery[] {
    return this.#deliveries;
  }

  static async start(opts: PeerOptions = {}): Promise<ClientPeer> {
    const server = net.createServer();
    const peer = await new Promise<ClientPeer>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve(new ClientPeer(server, port, opts));
      });
    });
    server.on('connection', (sock) => peer.#handle(sock));
    return peer;
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
    write(sock, 220, 'peer.test ESMTP scripted');

    const addrOf = (line: string): string => /<([^>]*)>/.exec(line)?.[1] ?? '';

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      this.#received = Buffer.concat([this.#received, Buffer.from(chunk)]);

      for (;;) {
        if (inData) {
          const eod = findEndOfData(buf);
          if (eod === -1) break;
          // Trim the terminating sequence (5 octets for CRLF.CRLF, 3 for LF.LF).
          const termLen = buf[eod - 5] === CR ? 5 : 3;
          const payload = eod >= termLen ? buf.subarray(0, eod - termLen) : Buffer.alloc(0);
          this.#deliveries.push({ from, recipients: [...recipients], rawData: Buffer.from(payload) });
          from = '';
          recipients = [];
          inData = false;
          buf = buf.subarray(eod);
          write(sock, 250, '2.0.0 message accepted');
          continue;
        }

        // Read a command line on LF (tolerating a missing CR, so a bare-LF client
        // still makes progress and its violation is captured, not deadlocked on).
        const nl = buf.indexOf(LF);
        if (nl === -1) break;
        const end = nl > 0 && buf[nl - 1] === CR ? nl - 1 : nl;
        const line = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(nl + 1);
        const verb = line.split(/\s+/)[0]?.toUpperCase() ?? '';

        switch (verb) {
          case 'EHLO':
            write(sock, this.#opts.ehloStatus ?? 250, this.#opts.ehloStatus === undefined || this.#opts.ehloStatus < 400 ? 'peer.test at your service' : 'command not recognized');
            break;
          case 'HELO':
            write(sock, this.#opts.heloStatus ?? 250, 'peer.test');
            break;
          case 'MAIL': {
            from = addrOf(line);
            recipients = [];
            const status = this.#opts.mailStatus ?? 250;
            const replyMail = (): void => {
              // Snapshot at REPLY time (end of any withhold window), so a
              // pipelining client's already-sent RCPT/DATA bytes have arrived and
              // are visible — while a lock-step client, blocked on this very reply,
              // has necessarily sent nothing further.
              this.#opts.onMailReceived?.(Buffer.from(this.#received));
              write(sock, status, status < 400 ? '2.1.0 Ok' : '5.1.0 rejected');
            };
            const delay = this.#opts.withholdMailReplyMs ?? 0;
            if (delay > 0) {
              const t = setTimeout(replyMail, delay);
              t.unref();
            } else {
              replyMail();
            }
            break;
          }
          case 'RCPT': {
            const status = this.#opts.rcptStatus ?? 250;
            if (status < 400) recipients.push(addrOf(line));
            write(sock, status, status < 400 ? '2.1.5 Ok' : '5.1.1 no such user');
            break;
          }
          case 'DATA':
            if (recipients.length === 0) {
              write(sock, 503, '5.5.1 need RCPT');
              break;
            }
            inData = true;
            write(sock, 354, 'End data with <CR><LF>.<CR><LF>');
            break;
          case 'RSET':
            from = '';
            recipients = [];
            write(sock, 250, '2.0.0 Ok');
            break;
          case 'NOOP':
            write(sock, 250, '2.0.0 Ok');
            break;
          case 'QUIT':
            write(sock, 221, '2.0.0 Bye');
            sock.end();
            return;
          default:
            write(sock, 500, '5.5.2 command not recognized');
        }
      }
    });
  }
}

/** Run a body against a fresh peer, always tearing it down. */
export async function withPeer<T>(opts: PeerOptions, fn: (peer: ClientPeer) => Promise<T>): Promise<T> {
  const peer = await ClientPeer.start(opts);
  try {
    return await fn(peer);
  } finally {
    await peer.close();
  }
}
