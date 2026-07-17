/**
 * The wire: a byte-exact, non-normalising SMTP transport.
 *
 * This layer exists to make the project's central rule structural rather than a
 * matter of discipline: **bytes, never strings**. JS strings are UTF-16; SMTP is
 * an octet protocol. A suite that must send a bare LF, a lone CR, an 8-bit octet
 * in a header, or a mis-timed dot cannot afford a layer that helpfully repairs
 * any of it. Nothing here accepts or returns a string.
 *
 * Two design decisions worth stating, because both look like mistakes until you
 * see why:
 *
 * 1. **Timeouts and peer closes are values, not exceptions.** A server that
 *    slams the connection, or says nothing at all, is not an error case — it is
 *    the observation the test came for. RFC 5321 §4.5.3.2 makes silence-for-N
 *    a conformance question, and §2.4 requires a receiver to take no action on
 *    an unterminated line, which is only assertable by observing silence. So
 *    `read()` returns a discriminated result and throws only on genuine faults.
 *
 * 2. **This layer knows nothing about SMTP.** It frames bytes on demand via a
 *    caller-supplied `Framer`. Reply parsing lives in `reply.ts`, so the
 *    transport can never quietly "fix up" a malformed reply on its way past.
 *
 * Every byte in and out, plus every lifecycle event, lands in the transcript
 * with a monotonic timestamp. The transcript is what the report renders and what
 * a human reads when triaging a disagreement — see task #23.
 */

import net from 'node:net';
import tls from 'node:tls';

/** Milliseconds since this connection was opened, monotonic, sub-ms precision. */
export type Elapsed = number;

export type WireEvent =
  | { readonly kind: 'connected'; readonly at: Elapsed; readonly tls: boolean }
  | { readonly kind: 'sent'; readonly at: Elapsed; readonly bytes: Buffer }
  | { readonly kind: 'received'; readonly at: Elapsed; readonly bytes: Buffer }
  /** Peer sent FIN. Half-open: we may still be able to write. */
  | { readonly kind: 'peer-ended'; readonly at: Elapsed }
  | {
      readonly kind: 'closed';
      readonly at: Elapsed;
      readonly by: 'peer' | 'us';
      readonly hadError: boolean;
    }
  /** RST — distinct from an orderly close, and a different conformance signal. */
  | { readonly kind: 'reset'; readonly at: Elapsed }
  | {
      readonly kind: 'tls-established';
      readonly at: Elapsed;
      readonly protocol: string | null;
      readonly cipher: string | undefined;
    }
  | { readonly kind: 'tls-failed'; readonly at: Elapsed; readonly error: string };

/**
 * Pulls one value off the head of the accumulated bytes.
 *
 * Returns null when more bytes are needed. `consumed` lets a framer take less
 * than the whole buffer, which matters for pipelining (RFC 2920): several
 * replies can arrive in one TCP segment and must be read as several replies,
 * not concatenated into one.
 */
export type Framer<T> = (buf: Buffer) => { readonly value: T; readonly consumed: number } | null;

/**
 * The outcome of a read.
 *
 * `timeout` and `closed` are ordinary outcomes a test may be asserting on, so
 * they are values. `partial` carries whatever unframed bytes were sitting in the
 * buffer when we gave up — without it, a test that times out mid-reply has no
 * evidence to report, and "the server sent nothing" and "the server sent half a
 * reply" would look identical in the results.
 */
export type ReadResult<T> =
  | { readonly kind: 'framed'; readonly value: T; readonly at: Elapsed }
  | { readonly kind: 'timeout'; readonly waitedMs: number; readonly partial: Buffer }
  | { readonly kind: 'closed'; readonly at: Elapsed; readonly partial: Buffer }
  | { readonly kind: 'reset'; readonly at: Elapsed; readonly partial: Buffer };

export interface QuietResult {
  /** True when the peer sent nothing at all during the window. */
  readonly quiet: boolean;
  /** Whatever did arrive. Empty iff `quiet`. */
  readonly bytes: Buffer;
  /** Set when the peer closed during the window — silence for the wrong reason. */
  readonly closed: boolean;
}

export interface WireOptions {
  readonly host: string;
  readonly port: number;
  /** 'implicit' wraps TLS from the first byte (e.g. port 465). */
  readonly tls?: 'none' | 'implicit';
  readonly tlsOptions?: tls.ConnectionOptions;
  readonly connectTimeoutMs?: number;
  /**
   * Restrict the address family when resolving `host`. Outbound relay sets 4:
   * large receivers (Gmail) hard-reject IPv6 connections without a matching v6
   * PTR + auth, so a dual-stack box that happens to prefer AAAA gets 550s that
   * IPv4 (where our PTR does match) does not.
   */
  readonly family?: 4 | 6;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** TLS handshake deadline — a peer that 220s STARTTLS then stalls must not hang us. */
const DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS = 30_000;

export class Wire {
  #socket: net.Socket | tls.TLSSocket;
  #buffer: Buffer = Buffer.alloc(0);
  #events: WireEvent[] = [];
  #origin: bigint;
  #closed = false;
  #peerEnded = false;
  #reset = false;
  /** Woken on any state change: bytes, close, reset. */
  #wake: (() => void)[] = [];

  private constructor(socket: net.Socket, origin: bigint) {
    this.#socket = socket;
    this.#origin = origin;
    this.#attach(socket);
  }

  #now(): Elapsed {
    return Number(process.hrtime.bigint() - this.#origin) / 1e6;
  }

  #record(e: WireEvent): void {
    this.#events.push(e);
  }

  #notify(): void {
    const waiters = this.#wake;
    this.#wake = [];
    for (const w of waiters) w();
  }

  #attach(socket: net.Socket): void {
    socket.on('data', (chunk: Buffer) => {
      // Copy: Node may reuse the underlying pool for the next read, and the
      // transcript must hold the bytes we actually saw, not whatever occupied
      // that memory afterwards. This bug is invisible until it isn't.
      const bytes = Buffer.from(chunk);
      this.#record({ kind: 'received', at: this.#now(), bytes });
      this.#buffer = Buffer.concat([this.#buffer, bytes]);
      this.#notify();
    });
    socket.on('end', () => {
      this.#peerEnded = true;
      this.#record({ kind: 'peer-ended', at: this.#now() });
      this.#notify();
    });
    socket.on('close', (hadError: boolean) => {
      if (this.#closed) return;
      this.#closed = true;
      this.#record({
        kind: 'closed',
        at: this.#now(),
        by: this.#peerEnded ? 'peer' : 'us',
        hadError,
      });
      this.#notify();
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      // ECONNRESET is a conformance observation (a server RSTing rather than
      // replying), not a fault. Everything else stays a fault, but we still must
      // not let an unhandled 'error' kill the process mid-suite.
      if (err.code === 'ECONNRESET') {
        this.#reset = true;
        this.#record({ kind: 'reset', at: this.#now() });
      }
      this.#notify();
    });
  }

  static connect(opts: WireOptions): Promise<Wire> {
    const origin = process.hrtime.bigint();
    const timeout = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    return new Promise<Wire>((resolve, reject) => {
      const useTls = opts.tls === 'implicit';
      const socket = useTls
        ? tls.connect({ host: opts.host, port: opts.port, ...(opts.family !== undefined ? { family: opts.family } : {}), ...opts.tlsOptions })
        : net.connect({ host: opts.host, port: opts.port, ...(opts.family !== undefined ? { family: opts.family } : {}) });

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`connect timeout after ${timeout}ms to ${opts.host}:${opts.port}`));
      }, timeout);
      timer.unref();

      const onReady = (): void => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        const wire = new Wire(socket, origin);
        wire.#record({ kind: 'connected', at: wire.#now(), tls: useTls });
        resolve(wire);
      };
      const onError = (err: Error): void => {
        clearTimeout(timer);
        reject(err);
      };

      socket.once(useTls ? 'secureConnect' : 'connect', onReady);
      socket.once('error', onError);
    });
  }

  /**
   * Send exact bytes. No terminator is appended — if you want CRLF, send CRLF.
   *
   * The absence of an implicit line ending is deliberate and load-bearing: the
   * moment this method appends a CRLF for you, the entire smuggling corpus
   * becomes unwritable.
   */
  send(bytes: Buffer): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('send on closed wire'));
    return new Promise<void>((resolve, reject) => {
      this.#socket.write(bytes, (err) => {
        if (err) reject(err);
        else {
          this.#record({ kind: 'sent', at: this.#now(), bytes: Buffer.from(bytes) });
          resolve();
        }
      });
    });
  }

  /** Bytes buffered but not yet framed. Diagnostic only — does not consume. */
  peek(): Buffer {
    return Buffer.from(this.#buffer);
  }

  /**
   * Read one framed value, or a non-framed outcome (timeout/closed/reset).
   *
   * `eofFramer`, when supplied, is tried once the peer has closed and the normal
   * framer still can't frame the buffer — for a final reply whose terminator is
   * ambiguous until EOF (a trailing bare CR). Critically the reframe happens HERE
   * so its bytes are consumed from #buffer: a reply is surfaced exactly once, and
   * the next read reports the true close with an empty partial. (A previous fix
   * reframed a peek() copy in the caller, which never advanced the buffer and made
   * every subsequent read re-deliver the same phantom reply — a regression the
   * second pressure-test pass caught.)
   */
  async read<T>(framer: Framer<T>, timeoutMs: number, eofFramer?: Framer<T>): Promise<ReadResult<T>> {
    const deadline = this.#now() + timeoutMs;

    for (;;) {
      const framed = framer(this.#buffer);
      if (framed !== null) {
        this.#buffer = this.#buffer.subarray(framed.consumed);
        return { kind: 'framed', value: framed.value, at: this.#now() };
      }
      // Order matters: try to frame what we have BEFORE reporting a close.
      // A server may send a complete reply and close in the same breath, and
      // reporting 'closed' there would discard a reply it did in fact send.
      if (this.#reset || this.#closed || this.#peerEnded) {
        // At EOF, a normally-unframeable partial (e.g. a trailing bare CR) may
        // still be a complete final reply. Reframe once, consuming the bytes.
        if (eofFramer !== undefined && this.#buffer.length > 0) {
          const atEof = eofFramer(this.#buffer);
          if (atEof !== null) {
            this.#buffer = this.#buffer.subarray(atEof.consumed);
            return { kind: 'framed', value: atEof.value, at: this.#now() };
          }
        }
        return this.#reset
          ? { kind: 'reset', at: this.#now(), partial: this.peek() }
          : { kind: 'closed', at: this.#now(), partial: this.peek() };
      }

      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        return { kind: 'timeout', waitedMs: timeoutMs, partial: this.peek() };
      }
      await this.#waitForChange(remaining);
    }
  }

  #waitForChange(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = this.#wake.filter((w) => w !== wake);
        resolve();
      }, ms);
      timer.unref();
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.#wake.push(wake);
    });
  }

  /**
   * Assert the peer stays quiet for `ms`.
   *
   * Needed for requirements that are only observable as an absence — §2.4's
   * "The receiver will take no action until this sequence is received" being the
   * headline case. A server that replies to an unterminated command line is
   * acting on it, which is the same family of defect as honouring a bare LF.
   *
   * "Quiet" means the peer has said NOTHING we have not already consumed. Bytes
   * ALREADY sitting in the buffer at entry are not silence — they are data the
   * peer sent that the caller has not framed yet (e.g. a second reply that
   * coalesced with the first into one TCP segment). Baselining on the current
   * buffer length would treat that already-buffered second reply as silence — a
   * bug the new-module pressure test caught: it let a double-reply
   * (desynchronised/smuggling) server pass the §4.2-a "exactly one reply" check
   * ~33% of the time. So we report non-quiet immediately if anything is buffered
   * at entry, and otherwise wait for new bytes. Safe for every caller, since an
   * unconsumed buffered byte always means the peer already spoke.
   */
  async expectQuiet(ms: number): Promise<QuietResult> {
    if (this.#buffer.length > 0) {
      return { quiet: false, bytes: this.peek(), closed: this.#closed || this.#peerEnded };
    }
    await this.#sleep(ms);
    const arrived = this.peek();
    return { quiet: arrived.length === 0, bytes: arrived, closed: this.#closed || this.#peerEnded };
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref();
    });
  }

  /**
   * Upgrade an established plaintext connection to TLS (RFC 3207 STARTTLS).
   *
   * The caller is responsible for having sent STARTTLS and read its 220 first —
   * this method knows nothing about SMTP.
   *
   * Note for the corpus: RFC 3207 §4 requires the server to discard all state
   * learned before the handshake. Testing that means re-issuing EHLO after this
   * returns and comparing, which is a corpus concern (task #19), not a transport
   * one. The transport's only job is to not lose the buffered bytes — and in
   * fact any bytes buffered here are themselves a finding, since a server that
   * sends before the handshake completes is vulnerable to command injection
   * (the CVE-2011-0411 class).
   */
  startTls(opts?: tls.ConnectionOptions, timeoutMs = DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pending = this.#buffer.length;
      const plain = this.#socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('end');
      plain.removeAllListeners('close');
      plain.removeAllListeners('error');

      const secure = tls.connect({ socket: plain, ...opts });
      let settled = false;
      // A remote that replies 220 to STARTTLS then stalls the handshake would otherwise
      // hang this await forever — and since the relay loop awaits delivery under a
      // single-flight guard, one such peer wedges the WHOLE outbound queue. Bound it.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        secure.removeListener('secureConnect', onSecure);
        secure.removeListener('error', onError);
        this.#record({ kind: 'tls-failed', at: this.#now(), error: 'TLS handshake timed out' });
        secure.destroy();
        reject(new Error('TLS handshake timed out'));
      }, timeoutMs);
      timer.unref();
      const onSecure = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        secure.removeListener('error', onError);
        this.#socket = secure;
        this.#attach(secure);
        this.#record({
          kind: 'tls-established',
          at: this.#now(),
          protocol: secure.getProtocol(),
          cipher: secure.getCipher()?.name,
        });
        if (pending > 0) {
          // Not fatal here, but the corpus should treat it as a finding.
          this.#record({
            kind: 'tls-failed',
            at: this.#now(),
            error: `${pending} bytes were buffered before the TLS handshake — possible pre-handshake injection`,
          });
        }
        resolve();
      };
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#record({ kind: 'tls-failed', at: this.#now(), error: err.message });
        reject(err);
      };
      secure.once('secureConnect', onSecure);
      secure.once('error', onError);
    });
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#socket.end(() => resolve());
      // Some servers never FIN back; don't hang the suite on a rude peer.
      const t = setTimeout(() => {
        this.#socket.destroy();
        resolve();
      }, 2_000);
      t.unref();
    });
  }

  /** Immediate RST, for tests that need to model an abrupt client disappearance. */
  destroy(): void {
    this.#socket.destroy();
  }

  get transcript(): readonly WireEvent[] {
    return this.#events;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  get tlsEstablished(): boolean {
    return this.#events.some((e) => e.kind === 'tls-established');
  }
}
