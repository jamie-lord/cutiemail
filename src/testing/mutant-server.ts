/**
 * The mutant server: a minimal SMTP receiver whose conformance can be broken on
 * purpose, one defect at a time.
 *
 * This is the most important piece of test infrastructure in the project, and it
 * was missing from the original plan. Everything else proves the suite RUNS.
 * Only this proves the suite DETECTS. A conformance suite that has never been
 * shown to catch a violation is faith dressed as evidence — and the
 * fabricated-quote incident is a standing reminder of how confident wrongness
 * looks from the inside.
 *
 * How it is used (task #25): for each planted defect, the corpus test for the
 * violated requirement must report `non-conformant` against exactly that
 * requirement — and must NOT report findings against the requirements the
 * mutant does not violate. That second half matters as much as the first: a
 * test that fires on everything is as useless as one that fires on nothing.
 *
 * This is emphatically NOT a reference server. Its "conformant" baseline is only
 * as correct as this file, which is why real ground truth is Postfix and Exim
 * (task #13). The mutant's job is narrow: be conformant enough that a single
 * switched-on defect is the ONLY thing a good test could find.
 *
 * It is deliberately built directly on the byte DSL and raw sockets — not on any
 * SMTP library — so that a defect like "honour a bare LF" can be expressed at
 * the byte level, which a library would paper over.
 */

import net from 'node:net';
import { crlf, lf, CR, LF, DOT } from '../wire/bytes.ts';

/**
 * The switchable defects. Each maps to one or more register requirements it
 * violates. Names are the wire-level behaviour, not the requirement, so a test
 * author reads what the server DOES.
 */
export interface Defects {
  /** Honour a bare LF as a command terminator. Violates R-5321-2.3.8-a. */
  readonly honourBareLf?: boolean;
  /**
   * REJECT a bare-LF-terminated command with a 500 error — the hardened,
   * anti-smuggling behaviour (Postfix smtpd_forbid_bare_newline=reject). This is
   * CONFORMANT, not a defect: it models the smuggling-safe server the suite must
   * bless, and exists so the bare-LF tests can be shown to NOT flag it.
   */
  readonly rejectBareLf?: boolean;
  /** Honour <LF>.<LF> as end-of-data (the SMTP-smuggling primitive). */
  readonly honourBareLfEndOfData?: boolean;
  /**
   * Honour <LF>.<CR><LF> as end-of-data — the variant Postfix, Sendmail and
   * Exim all mishandled (CVE-2023-51764/65/66). The highest-value smuggling
   * primitive. See docs/research/smtp-divergence.md §1.
   */
  readonly honourLfDotCrlfEndOfData?: boolean;
  /** Honour <CR>.<CR> as end-of-data — the Cisco Secure Email Gateway variant. */
  readonly honourCrDotCrEndOfData?: boolean;
  /** Reply to a command line before its CRLF arrives. Violates R-5321-2.4-f. */
  readonly actOnUnterminatedLine?: boolean;
  /** Emit a reply with an out-of-grammar code (260). */
  readonly outOfGrammarCode?: boolean;
  /** Emit a reply code with no text at all (bare code). */
  readonly bareCodeReplies?: boolean;
  /** Put an 8-bit octet in reply text. */
  readonly eightBitReplyText?: boolean;
  /**
   * Accept MAIL FROM before EHLO/HELO.
   *
   * NOTE: this is NOT a clear RFC 5321 violation — §4.1.4-k says servers SHOULD
   * process commands without prior EHLO, and accepting MAIL without a greeting is
   * common and conformant. The defect exists for completeness but the corpus does
   * NOT assert it as a violation. See the §4.1.4 register notes.
   */
  readonly acceptMailBeforeGreeting?: boolean;
  /** Do not reset transaction state on RSET. Violates R-5321-4.1.1.5-a. */
  readonly ignoreRset?: boolean;
  /** Reply something other than 250 to RSET. Violates R-5321-4.1.1.5-b. */
  readonly rsetWrongReply?: boolean;
  /** Close the connection on RSET. Violates R-5321-4.1.1.5-e. */
  readonly rsetClosesConnection?: boolean;
  /** Accept RCPT before MAIL. Violates §4.1.4-o (out of order → 503). */
  readonly acceptRcptBeforeMail?: boolean;
  /** Accept DATA before any RCPT. Violates §4.1.4-o. */
  readonly acceptDataBeforeRcpt?: boolean;
  /** Reply something other than 250 to NOOP. Violates R-5321-4.1.1.9-b. */
  readonly noopWrongReply?: boolean;
  /** Reply something other than 221 to QUIT. Violates R-5321-4.1.1.10-a. */
  readonly quitWrongReply?: boolean;
  /** Reply 221 to QUIT but then RST the connection instead of a clean close. */
  readonly quitResetsAfterReply?: boolean;
  /** Return an EHLO-style multiline response to HELO. Violates R-5321-3.2-b. */
  readonly extendedResponseToHelo?: boolean;
  /** Emit a four-digit reply code. Violates R-5321-4.3.2-c (three digits only). */
  readonly fourDigitCode?: boolean;
  /**
   * Reject a source-route RCPT with a 501 syntax error — i.e. fail to PARSE it.
   * Violates R-5321-4.1.1.3-b (receivers MUST recognize source route syntax).
   * A policy rejection (550) would be conformant; a syntax error is not.
   */
  readonly rejectSourceRouteAsSyntax?: boolean;
  /** Send NO greeting on connect (stay silent). Violates R-5321-3.1-a. */
  readonly silentOnConnect?: boolean;
  /** Send a greeting with no domain identification ("220" alone). Violates R-5321-4.1.1.1-d. */
  readonly greetingWithoutDomain?: boolean;
  /** Reject the HELO command. Violates R-5321-4.1.1.1-h (servers MUST support HELO). */
  readonly rejectHelo?: boolean;
  /**
   * Advertise STARTTLS in EHLO but return 502 to the STARTTLS command.
   * Violates R-5321-4.2.4-c (MUST NOT advertise capabilities you will 502/500).
   */
  readonly advertiseStarttlsButReject?: boolean;
  /** Close the connection on error without sending 421. */
  readonly closeWithout421?: boolean;
  /**
   * Answer an unknown command with 421 (service closing) then close — the
   * CONFORMANT shutdown posture (§3.8/§4.2.1), not a defect. Exists so the
   * connection-stays-open test can be shown to NOT flag a shutting-down server.
   */
  readonly shutdownWith421?: boolean;
  /** Send mismatched continuation codes in a multiline reply. */
  readonly mismatchedContinuation?: boolean;
  /** Accept a command line longer than 512 octets without 500. */
  readonly acceptOverlongCommand?: boolean;
  /** After STARTTLS, do NOT discard state (advertise pre-TLS EHLO keywords). */
  readonly keepStateAcrossStartTls?: boolean;
  /**
   * Reject command lines longer than 300 octets — below the 512-octet floor
   * §4.5.3.1.4 requires a server to accept. Simulates a too-small command buffer.
   */
  readonly rejectCommandLineAt300?: boolean;
  /**
   * Reject text lines (in DATA) longer than 500 octets — below the 1000-octet
   * floor §4.5.3.1.6 requires. Simulates a too-small text buffer.
   */
  readonly rejectTextLineAt500?: boolean;
}

export interface MutantOptions {
  readonly domain?: string;
  readonly defects?: Defects;
  /** Recipients the server treats as valid. Default: accept all. */
  readonly validRecipients?: readonly string[];
}

interface SessionState {
  greeted: boolean;
  hasMail: boolean;
  rcptCount: number;
  inData: boolean;
}

const DEFAULT_DOMAIN = 'mutant.test';

export class MutantServer {
  readonly port: number;
  #server: net.Server;
  #domain: string;
  #defects: Defects;

  private constructor(server: net.Server, port: number, domain: string, defects: Defects) {
    this.#server = server;
    this.port = port;
    this.#domain = domain;
    this.#defects = defects;
  }

  static start(opts: MutantOptions = {}): Promise<MutantServer> {
    const domain = opts.domain ?? DEFAULT_DOMAIN;
    const defects = opts.defects ?? {};
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('no port'));
          return;
        }
        const m = new MutantServer(server, addr.port, domain, defects);
        server.on('connection', (sock) => m.#handle(sock));
        resolve(m);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #write(sock: net.Socket, buf: Buffer): void {
    if (!sock.destroyed) sock.write(buf);
  }

  #handle(sock: net.Socket): void {
    const d = this.#defects;
    const state: SessionState = { greeted: false, hasMail: false, rcptCount: 0, inData: false };
    let buf = Buffer.alloc(0);

    sock.on('error', () => {});
    if (d.silentOnConnect) {
      // No greeting at all — the client is left waiting.
    } else if (d.greetingWithoutDomain) {
      // A bare 220 with no domain identification.
      this.#write(sock, crlf`220`);
    } else {
      this.#write(sock, crlf`220 ${this.#domain} ESMTP mutant`);
    }

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);

      for (;;) {
        if (state.inData) {
          const consumed = this.#tryConsumeData(sock, buf, state);
          if (consumed === 0) break;
          buf = buf.subarray(consumed);
          continue;
        }

        // Hardened-reject behaviour: if a bare LF appears before any CRLF, refuse
        // it with a 500 rather than executing or ignoring it. Conformant.
        if (d.rejectBareLf) {
          const lfAt = buf.indexOf(LF);
          const crlfAt = buf.indexOf(Buffer.from([CR, LF]));
          if (lfAt !== -1 && (crlfAt === -1 || lfAt < crlfAt)) {
            this.#write(sock, crlf`500 Error: bare <LF> received`);
            buf = buf.subarray(lfAt + 1);
            continue;
          }
        }

        const line = this.#nextCommandLine(buf);
        if (line === null) {
          // No terminator yet. The defect: act on what we have anyway.
          if (d.actOnUnterminatedLine && buf.length > 0 && this.#looksLikeCommand(buf)) {
            this.#dispatch(sock, buf, state);
            buf = Buffer.alloc(0);
          }
          break;
        }
        // Defect: reject a command line the RFC requires the server to accept.
        // command.length excludes CRLF; +2 approximates the §4.5.3.1.4 total.
        if (d.rejectCommandLineAt300 && line.command.length + 2 > 300) {
          this.#write(sock, crlf`500 Error: line too long`);
          buf = buf.subarray(line.consumed);
          continue;
        }
        this.#dispatch(sock, line.command, state);
        buf = buf.subarray(line.consumed);
      }
    });
  }

  #looksLikeCommand(buf: Buffer): boolean {
    return buf.length >= 4; // enough for a verb
  }

  /** Find the next command line. Honours CRLF always; bare LF only under defect. */
  #nextCommandLine(buf: Buffer): { command: Buffer; consumed: number } | null {
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === CR && buf[i + 1] === LF) {
        return { command: buf.subarray(0, i), consumed: i + 2 };
      }
      if (buf[i] === LF && this.#defects.honourBareLf) {
        // The violation: a bare LF terminates a command.
        return { command: buf.subarray(0, i), consumed: i + 1 };
      }
    }
    return null;
  }

  #tryConsumeData(sock: net.Socket, buf: Buffer, state: SessionState): number {
    // Look for CRLF.CRLF always; under defect also LF.LF.
    const eod = this.#findEndOfData(buf);
    if (eod === null) return 0;
    state.inData = false;
    state.hasMail = false;
    state.rcptCount = 0;
    // Defect: reject a message containing a text line longer than 500 octets,
    // below the 1000-octet floor §4.5.3.1.6 requires a server to accept.
    if (this.#defects.rejectTextLineAt500 && this.#hasOverlongTextLine(buf.subarray(0, eod), 500)) {
      this.#write(sock, crlf`500 Error: text line too long`);
      return eod;
    }
    this.#write(sock, crlf`250 2.0.0 message accepted`);
    return eod;
  }

  #hasOverlongTextLine(data: Buffer, limit: number): boolean {
    let lineStart = 0;
    for (let i = 0; i + 1 < data.length; i++) {
      if (data[i] === CR && data[i + 1] === LF) {
        if (i + 2 - lineStart > limit) return true;
        lineStart = i + 2;
        i++;
      }
    }
    return false;
  }

  #findEndOfData(buf: Buffer): number | null {
    // Canonical: CRLF "." CRLF
    for (let i = 0; i + 4 < buf.length + 1; i++) {
      if (
        buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === DOT &&
        buf[i + 3] === CR && buf[i + 4] === LF
      ) {
        return i + 5;
      }
      // Smuggling defect: honour LF "." LF as end-of-data too.
      if (
        this.#defects.honourBareLfEndOfData &&
        buf[i] === LF && buf[i + 1] === DOT && buf[i + 2] === LF
      ) {
        return i + 3;
      }
      // Smuggling defect: honour LF "." CRLF — the Postfix/Sendmail/Exim variant.
      if (
        this.#defects.honourLfDotCrlfEndOfData &&
        buf[i] === LF && buf[i + 1] === DOT && buf[i + 2] === CR && buf[i + 3] === LF
      ) {
        return i + 4;
      }
      // Smuggling defect: honour CR "." CR — the Cisco variant.
      if (
        this.#defects.honourCrDotCrEndOfData &&
        buf[i] === CR && buf[i + 1] === DOT && buf[i + 2] === CR
      ) {
        return i + 3;
      }
    }
    // Leading "." CRLF at the very start (empty message) — canonical.
    if (buf.length >= 3 && buf[0] === DOT && buf[1] === CR && buf[2] === LF) return 3;
    return null;
  }

  #dispatch(sock: net.Socket, commandBytes: Buffer, state: SessionState): void {
    const d = this.#defects;
    const text = commandBytes.toString('latin1');
    const verb = text.split(/\s+/)[0]?.toUpperCase() ?? '';

    // Malformed-reply defects apply to the first substantive reply.
    const replyOK = (code: number, msg: string): void => {
      if (d.outOfGrammarCode) return this.#write(sock, crlf`260 ${msg}`);
      if (d.fourDigitCode) return this.#write(sock, crlf`2500 ${msg}`);
      if (d.bareCodeReplies) return this.#write(sock, Buffer.concat([Buffer.from(String(code)), Buffer.from([CR, LF])]));
      if (d.eightBitReplyText) return this.#write(sock, Buffer.concat([Buffer.from(`${code} `), Buffer.from([0xe9]), Buffer.from([CR, LF])]));
      this.#write(sock, crlf`${String(code)} ${msg}`);
    };

    switch (verb) {
      case 'EHLO': {
        state.greeted = true;
        const keywords = d.keepStateAcrossStartTls
          ? ['PIPELINING', 'SIZE 10240000', '8BITMIME', 'STARTTLS', 'SECRET-PRE-TLS-KEYWORD']
          : ['PIPELINING', 'SIZE 10240000', '8BITMIME', 'STARTTLS'];
        if (d.mismatchedContinuation) {
          this.#write(sock, crlf`250-${this.#domain}`);
          this.#write(sock, crlf`251-PIPELINING`); // wrong continuation code
          this.#write(sock, crlf`250 8BITMIME`);
        } else {
          const lines = [crlf`250-${this.#domain}`];
          for (let i = 0; i < keywords.length; i++) {
            lines.push(i === keywords.length - 1 ? crlf`250 ${keywords[i]!}` : crlf`250-${keywords[i]!}`);
          }
          this.#write(sock, Buffer.concat(lines));
        }
        return;
      }
      case 'STARTTLS':
        // The mutant does not implement TLS; it only models the advertise-vs-honour
        // conformance question. A clean mutant that advertised STARTTLS would 220
        // then expect a handshake — but since no case here completes TLS, a clean
        // 220 is the honest "capability is real" answer. The defect 502s it.
        if (d.advertiseStarttlsButReject) return replyOK(502, 'Error: command not implemented');
        return replyOK(220, 'Ready to start TLS');

      case 'HELO':
        if (d.rejectHelo) return replyOK(502, 'Error: HELO not supported');
        state.greeted = true;
        if (d.extendedResponseToHelo) {
          // The violation: HELO must get a single-line reply, never EHLO-style.
          this.#write(sock, crlf`250-${this.#domain}`);
          this.#write(sock, crlf`250 PIPELINING`);
          return;
        }
        return replyOK(250, this.#domain);

      case 'MAIL':
        if (!state.greeted && !d.acceptMailBeforeGreeting) {
          return replyOK(503, 'Error: send HELO/EHLO first');
        }
        state.hasMail = true;
        return replyOK(250, '2.1.0 Ok');

      case 'RCPT':
        if (!state.hasMail && !d.acceptRcptBeforeMail) {
          return replyOK(503, 'Error: need MAIL command');
        }
        // Defect: treat a source-route path (a "@host," before the mailbox) as a
        // syntax error rather than recognising it. text is the whole command line.
        if (d.rejectSourceRouteAsSyntax && /RCPT\s+TO:\s*<@/i.test(text)) {
          return replyOK(501, 'Error: syntax');
        }
        state.rcptCount++;
        return replyOK(250, '2.1.5 Ok');

      case 'DATA':
        if (state.rcptCount === 0 && !d.acceptDataBeforeRcpt) {
          return replyOK(503, 'Error: need RCPT command');
        }
        state.inData = true;
        return this.#write(sock, crlf`354 End data with <CR><LF>.<CR><LF>`);

      case 'RSET':
        if (d.rsetClosesConnection) {
          sock.destroy();
          return;
        }
        if (!d.ignoreRset) {
          state.hasMail = false;
          state.rcptCount = 0;
        }
        return replyOK(d.rsetWrongReply ? 451 : 250, '2.0.0 Ok');

      case 'NOOP':
        return replyOK(d.noopWrongReply ? 500 : 250, '2.0.0 Ok');

      case 'QUIT':
        if (d.quitWrongReply) {
          this.#write(sock, crlf`500 not bye`);
          sock.end();
          return;
        }
        this.#write(sock, crlf`221 2.0.0 Bye`);
        if (d.quitResetsAfterReply) {
          // 221 then an abrupt RST rather than a clean FIN. resetAndDestroy sends
          // an actual RST segment; plain destroy() can close cleanly once the
          // peer has drained the buffer.
          setTimeout(() => {
            if (typeof sock.resetAndDestroy === 'function') sock.resetAndDestroy();
            else sock.destroy();
          }, 10);
          return;
        }
        sock.end();
        return;

      case 'VRFY':
        return replyOK(252, 'Cannot VRFY user');

      default:
        if (d.closeWithout421) {
          sock.destroy(); // rude: no 421, just gone
          return;
        }
        if (d.shutdownWith421) {
          // Conformant shutdown: 421 then close.
          this.#write(sock, crlf`421 ${this.#domain} Service closing transmission channel`);
          sock.end();
          return;
        }
        return replyOK(500, 'Error: command not recognized');
    }
  }
}

/** Run a body against a mutant server, always tearing it down. */
export async function withMutant<T>(
  opts: MutantOptions,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const server = await MutantServer.start(opts);
  try {
    return await fn(server.port);
  } finally {
    await server.close();
  }
}

void lf; // reserved for defect variants authored against the byte DSL
