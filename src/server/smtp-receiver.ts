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
import type { AuthThrottle } from './auth-throttle.ts';

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
  /** The authenticated SASL login (submission only; undefined on the inbound port). The
   *  submission handler authorizes the message's sender against this identity (ADR 0015). */
  readonly authenticatedUser?: string;
}

/**
 * A deliberate, PERMANENT rejection raised by the delivery handler — e.g. a submission
 * sender-authorization failure (ADR 0015). It carries the full SMTP reply line so the
 * receiver returns that 5xx, distinct from the generic transient 451 an unexpected
 * store/sign error maps to. Anything the handler throws that is NOT a MessageRejected stays
 * a transient 451 (a crash is a "try again", not a "never").
 */
export class MessageRejected extends Error {
  readonly reply: string;
  constructor(reply: string) {
    super(reply);
    this.name = 'MessageRejected';
    this.reply = reply;
  }
}

export type DeliveryHandler = (message: DeliveredMessage) => void | Promise<void>;

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
  /** Idle-connection timeout in ms (default 5 min). Tests set it short. */
  readonly idleTimeoutMs?: number;
  /**
   * Decide whether to accept a recipient at RCPT time. Returns false to reject it.
   * The inbound (port 25) path uses this to accept only local mailboxes — otherwise
   * we would accept (and misdeliver, or become backscatter for) mail addressed to
   * unknown users or foreign domains. Unset = accept every recipient (the submission
   * path, where an authenticated user may relay anywhere).
   */
  readonly acceptRecipient?: (address: string) => boolean;
  /** Per-IP brute-force throttle for submission AUTH (shared with the IMAP server). */
  readonly throttle?: AuthThrottle;
}

const addrOf = (line: string): string => /<([^>]*)>/.exec(line)?.[1] ?? '';
const NUL = String.fromCharCode(0);

/** Idle-connection timeout (RFC 5321 §4.5.3.2 server timeouts are ~5 min per step). */
const IDLE_TIMEOUT_MS = 300_000;

/** Max recipients per transaction (RFC 5321 §4.5.3.1.10 sets the floor at 100). */
const MAX_RECIPIENTS = 100;
const MAX_CONNECTIONS = 512; // concurrent-connection ceiling per listener (pre-auth DoS bound)
// Client protocol errors tolerated before we drop the connection (Postfix's
// smtpd_hard_error_limit is 20). The idle timer resets on every received chunk, so a
// peer that streams junk commands — unknown verbs, out-of-order commands, recipient
// probing — holds its connection slot indefinitely and is otherwise bounded only by
// MAX_CONNECTIONS. Counting errors and disconnecting reclaims the slot from an abusive
// peer while leaving well-behaved clients (which essentially never err) untouched.
const MAX_HARD_ERRORS = 20;

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

function findEndOfData(buf: Buffer, from = 0): number {
  // Resume from `from` (minus the 4-byte terminator overlap so a <CRLF>.<CRLF> split
  // across a chunk boundary is still caught) instead of rescanning from 0 each chunk —
  // that rescan is O(n²) over a message delivered in many small segments (CPU DoS).
  const start = Math.max(0, from - 4);
  for (let i = start; i + 4 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === DOT && buf[i + 3] === CR && buf[i + 4] === LF) return i + 5;
  }
  if (buf.length >= 3 && buf[0] === DOT && buf[1] === CR && buf[2] === LF) return 3;
  return -1;
}

/**
 * A bare LF (not preceded by CR) or bare CR (not followed by LF) in the DATA payload.
 * RFC 5321 §2.3.8 permits CR and LF only as a paired <CRLF> line terminator. A message
 * with bare newlines is the SMTP-smuggling vector (SEC Consult, 2023): our strict
 * <CRLF>.<CRLF> end-of-data ignores a bare-LF "\n.\n", but a lenient downstream server we
 * relay to may read it as end-of-data and execute the bytes after it as injected SMTP
 * commands. Rejecting here (as modern Postfix/Exim/Sendmail do by default) stops us being
 * a smuggling conduit and refuses malformed line endings outright.
 */
function hasBareNewline(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === LF && buf[i - 1] !== CR) return true;
    if (buf[i] === CR && buf[i + 1] !== LF) return true;
  }
  return false;
}

class Connection {
  #active: Duplex;
  #buf = Buffer.alloc(0);
  #from = '';
  #recipients: string[] = [];
  #inData = false;
  #dataScanned = 0; // bytes of #buf already scanned for the DATA terminator (resume point)
  #inTransaction = false; // a reverse-path buffer exists (MAIL accepted, not yet reset)
  #tls = false;
  #authed = false;
  #authedUser = ''; // the SASL authcid once authenticated — the identity send-as authorizes against
  #awaitingAuth = false; // AUTH PLAIN issued without an initial response; next line is the SASL data
  #processing: Promise<void> = Promise.resolve(); // serializes async #onData over chunks
  #hardErrors = 0; // cumulative client protocol errors this session (see MAX_HARD_ERRORS)
  #ended = false; // set once we have closed the connection ourselves; stops the #onData loop
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
    // RFC 5321 §4.5.3.2: time out an idle connection so a client that opens a socket
    // and then stalls (slowloris) can't hold resources indefinitely. The timer resets
    // on every received chunk, so a slow-but-progressing transfer is fine; only true
    // inactivity trips it. Set on the raw socket, so it also covers the post-STARTTLS
    // phase (TLS traffic still flows through it).
    sock.setTimeout(opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
    sock.on('timeout', () => {
      try {
        this.#write('421 4.4.2 idle timeout, closing connection');
      } catch {
        // best-effort; the socket may already be gone
      }
      this.#active.end();
      sock.destroy();
    });
    this.#bind(sock);
    this.#write(`220 ${domain} ESMTP`);
  }

  #bind(stream: Duplex): void {
    // Serialize chunk processing: #onData is async (an inbound delivery may await a
    // DNS lookup for DKIM), so chain each chunk after the previous one completes.
    // Without this, a pipelined client's next chunk could re-enter #onData while it
    // is awaiting and corrupt the shared receive buffer.
    stream.on('data', (chunk: Buffer) => {
      this.#processing = this.#processing.then(() => this.#onData(chunk)).catch(() => {});
    });
    stream.on('error', () => {});
  }

  #write(line: string): void {
    this.#active.write(Buffer.from(`${line}\r\n`, 'latin1'));
  }

  /**
   * Emit a client-error reply and count it toward the hard-error limit. Returns true
   * once the peer has exceeded MAX_HARD_ERRORS and the connection has been closed — the
   * #onData loop then stops via its `#ended` guard. Only unambiguous client faults are
   * routed through here (unknown/out-of-order/malformed commands, recipient probing);
   * our own transient failures (451) and normal policy limits (SIZE, auth-required) are
   * not counted, and repeated AUTH failures are handled separately by the per-IP throttle.
   */
  #reject(reply: string): boolean {
    this.#write(reply);
    if (++this.#hardErrors < MAX_HARD_ERRORS) return false;
    this.#write('421 4.7.0 too many protocol errors, closing connection');
    this.#active.end();
    this.#ended = true;
    return true;
  }

  async #onData(chunk: Buffer): Promise<void> {
    this.#buf = Buffer.concat([this.#buf, Buffer.from(chunk)]);
    for (;;) {
      // We closed the connection ourselves (e.g. hard-error limit) — stop processing
      // anything the peer had already pipelined into #buf.
      if (this.#ended) return;
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
        const eod = findEndOfData(this.#buf, this.#dataScanned);
        if (eod === -1) {
          this.#dataScanned = this.#buf.length; // scanned this far without a terminator
          break;
        }
        // The terminating sequence is <CRLF>.<CRLF>, but RFC 5321 §4.1.1.4 is explicit
        // that its first <CRLF> "is also the <CRLF> that ends the final line of the data".
        // So the message keeps that final CRLF; only the ".<CRLF>" indicator (3 bytes) is
        // stripped. eod is past the whole terminator, so eod-3 is the byte after that CRLF.
        // The bare-".<CRLF>" no-data case (eod===3) yields an empty message, as it should.
        const payload = this.#buf.subarray(0, eod - 3);
        // SMTP-smuggling defence: reject bare CR/LF in the message body (RFC 5321 §2.3.8).
        if (hasBareNewline(payload)) {
          this.#write('550 5.6.0 bare CR or LF in message data (RFC 5321 §2.3.8); use CRLF line endings');
          this.#from = '';
          this.#recipients = [];
          this.#inData = false;
          this.#inTransaction = false;
          this.#buf = this.#buf.subarray(eod);
          continue;
        }
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
        let reply = '250 2.0.0 message stored';
        try {
          await this.#handler({
            from: this.#from,
            recipients: [...this.#recipients],
            data: unstuffed,
            overTls: this.#tls,
            helo: this.#helo,
            remoteAddress: this.#remoteAddress,
            authenticated: this.#authed,
            ...(this.#authed ? { authenticatedUser: this.#authedUser } : {}),
          });
        } catch (err) {
          // A deliberate policy rejection carries its own permanent reply; anything else is
          // an unexpected store/sign failure — transient, so the client retries.
          reply = err instanceof MessageRejected ? err.reply : '451 4.3.0 error storing message';
        }
        this.#from = '';
        this.#recipients = [];
        this.#inData = false;
        this.#inTransaction = false;
        this.#buf = this.#buf.subarray(eod);
        this.#write(reply);
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
      // A SASL continuation response (after "AUTH PLAIN" with no initial response)
      // is the base64 credentials — never a command; consume it here and redact.
      if (this.#awaitingAuth) {
        if (DEBUG) process.stderr.write('[smtp<] <SASL continuation redacted>\n');
        this.#awaitingAuth = false;
        if (line.trim() === '*') this.#write('501 5.7.0 authentication cancelled');
        else this.#verifySaslPlain(line.trim());
        continue;
      }
      if (DEBUG) process.stderr.write(`[smtp<] ${line.replace(/^(AUTH\s+\S+\s+).*/i, '$1***')}\n`);
      // RFC 5321 §4.1.2: a command carrying an ASCII control octet (the CRLF
      // terminator is already stripped) is invalid — reject 501, never execute it.
      if (lineBytes.some((b) => b < 0x20)) {
        if (this.#reject('501 5.5.2 control character in command')) return;
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
          this.#reject('503 5.5.1 need MAIL before RCPT');
          break;
        }
        {
          const rcpt = addrOf(line);
          // Reject recipients we don't serve (RFC 5321 §7.2): otherwise we accept and
          // misdeliver mail for unknown users, and become a backscatter source for
          // foreign domains we can't actually relay to.
          if (this.#opts.acceptRecipient !== undefined && !this.#opts.acceptRecipient(rcpt)) {
            // Rejected recipients count toward the hard-error limit: an unauthenticated
            // peer spraying RCPTs to enumerate/relay-probe is exactly the abuse to bound.
            this.#reject('550 5.7.1 relaying denied — recipient not hosted here');
            break;
          }
          // Cap recipients per transaction (RFC 5321 §4.5.3.1.10 permits ≥100). Without
          // it, an attacker streams unbounded RCPT lines — each resetting the idle timer
          // — and grows the array without ever sending DATA, a memory-exhaustion DoS.
          if (this.#recipients.length >= MAX_RECIPIENTS) {
            this.#write('452 4.5.3 too many recipients');
            break;
          }
          this.#recipients.push(rcpt);
          this.#write('250 2.1.5 Ok');
        }
        break;
      case 'DATA':
        if (this.#recipients.length === 0) {
          this.#write('503 5.5.1 need RCPT');
          break;
        }
        this.#inData = true;
        this.#dataScanned = 0; // fresh DATA payload — scan from the start of #buf
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
        this.#reject('500 5.5.2 command not recognized');
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
    if ((parts[1] ?? '').toUpperCase() !== 'PLAIN') {
      this.#write('504 5.5.4 unsupported AUTH mechanism');
      return;
    }
    if (parts[2] === undefined) {
      // RFC 4954 continuation form: no initial response — ask for the SASL data.
      this.#awaitingAuth = true;
      this.#write('334 ');
      return;
    }
    this.#verifySaslPlain(parts[2]);
  }

  /** Verify a base64 SASL PLAIN payload (authzid NUL authcid NUL passwd). */
  #verifySaslPlain(b64: string): void {
    if (this.#opts.authenticate === undefined) {
      this.#write('504 5.5.4 AUTH not supported');
      return;
    }
    // Brute-force throttle: too many recent failures from this IP → refuse without checking
    // the password (a transient 4yz, so a legitimate client retries after the window drains).
    if (this.#opts.throttle?.isBlocked(this.#remoteAddress) === true) {
      this.#write('454 4.7.0 too many failed attempts, try again later');
      return;
    }
    const decoded = Buffer.from(b64, 'base64').toString('latin1').split(NUL);
    const username = decoded[1] ?? '';
    const password = decoded[2] ?? '';
    if (this.#opts.authenticate(username, password)) {
      this.#opts.throttle?.recordSuccess(this.#remoteAddress);
      this.#authed = true;
      this.#authedUser = username;
      this.#write('235 2.7.0 Authentication successful');
    } else {
      this.#opts.throttle?.recordFailure(this.#remoteAddress);
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

  /** Live connection count — for observability / leak diagnostics (must return to baseline after churn). */
  get connectionCount(): number {
    return this.#sockets.size;
  }

  static start(handler: DeliveryHandler, options: ReceiverOptions = {}): Promise<SmtpReceiver> {
    const domain = options.domain ?? 'mail.example.com';
    const server = net.createServer();
    // Bound concurrent connections against a pre-auth flood / slowloris (no per-IP accounting on
    // the single-threaded daemon, so a global ceiling is the backstop — audit run-5). Far above
    // any real sending pattern.
    server.maxConnections = MAX_CONNECTIONS;
    const sockets = new Set<net.Socket>();
    return new Promise((resolve, reject) => {
      // A bind failure (EADDRINUSE — a stale instance or a system MTA already on the port;
      // EACCES — a privileged port 25/587 without root/setcap) otherwise emits an unhandled
      // 'error' event that crashes the process with a raw stack trace, and this Promise never
      // settles. Reject cleanly so the caller can report it; hand error handling back to the
      // app once we're listening.
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
        server.removeListener('error', reject);
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
