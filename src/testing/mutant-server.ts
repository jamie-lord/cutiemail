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
  /**
   * Return a CONFORMANT multiline PROSE banner to HELO (no extension keywords).
   * Not a defect — §3.2 forbids an EHLO-STYLE response, not any multiline reply.
   * Exists so the HELO test can be shown to NOT flag a prose banner.
   */
  readonly multilineProseHelo?: boolean;
  /** Emit a four-digit reply code. Violates R-5321-4.3.2-c (three digits only). */
  readonly fourDigitCode?: boolean;
  /** Emit a two-digit reply code. Violates R-5321-4.3.2-c (three digits only). */
  readonly twoDigitCode?: boolean;
  /**
   * Emit a well-formed THREE-digit code whose first digit is outside 2-5 (e.g.
   * 250 -> 650). Distinct from four/two-digit: the length is legal but the class
   * digit is not. Violates R-5321-4.2-s / R-5321-4.3.2-c's second prong.
   */
  readonly firstDigitOutOfRange?: boolean;
  /** Terminate replyOK-path replies with a bare LF instead of CRLF. Violates R-5321-4.2-d. */
  readonly bareLfReplyTerminator?: boolean;
  /** Use '=' instead of SP as the reply code separator. Violates R-5321-4.2-i. */
  readonly malformedReplySeparator?: boolean;
  /**
   * Emit a reply LINE longer than 512 octets (code + ~600 octets of text + CRLF).
   * Violates R-5321-4.5.3.1.5-a (max reply line incl. CRLF is 512 octets).
   */
  readonly overlongReplyLine?: boolean;
  /**
   * Emit the FINAL line of the multiline EHLO with "=" instead of the required
   * <SP> separator. A genuine multiline-FORMAT violation (R-5321-4.2.1-f), distinct
   * from the single-line malformedReplySeparator above.
   */
  readonly malformedMultilineSeparator?: boolean;
  /** VRFY clears transaction state. Violates R-5321-4.1.1.6-b (no effect on buffers). */
  readonly vrfyResetsState?: boolean;
  /** EXPN (recognised) clears transaction state. Violates R-5321-4.1.1.7-c. */
  readonly expnResetsState?: boolean;
  /** HELP clears transaction state. Violates R-5321-4.1.1.8-c. */
  readonly helpResetsState?: boolean;
  /** NOOP clears session/transaction state. Violates R-5321-4.1.1.9-a/c. */
  readonly noopResetsState?: boolean;
  /** Require command verbs in upper case (500 to lowercase). Violates R-5321-2.4-a. */
  readonly requireUppercaseVerbs?: boolean;
  /** Accept commands containing C0/DEL control characters. Violates R-5321-4.1.2-j/-n. */
  readonly acceptControlCharsInCommand?: boolean;
  /** Reject a recipient with 550 (models wrongly refusing a valid recipient). Violates §3.3-h. */
  readonly rejectValidRecipient?: boolean;
  /** Accept a fixture-declared rejected recipient with 250. Violates §3.3-i (MUST reject undeliverable). */
  readonly acceptRejectedRecipient?: boolean;
  /** Reply to end-of-data with a 5yz even for an accepted transaction. Violates §3.3-t. */
  readonly rejectAcceptedMessage?: boolean;
  /** Reject a RCPT whose local-part is "Postmaster" in non-lowercase. Violates §4.1.1.3-m. */
  readonly postmasterCaseSensitive?: boolean;
  /**
   * Reject a control-char command with a NON-501 5yz (500). The command IS
   * rejected (so §4.1.2-j is satisfied — not executed), but §4.1.2-n's EXACT-501
   * duty is violated. Exercises the exact-code branch of the -n test.
   */
  readonly rejectControlCharsWith500?: boolean;
  /**
   * Reject a source-route RCPT with a 501 syntax error — i.e. fail to PARSE it.
   * Violates R-5321-4.1.1.3-b (receivers MUST recognize source route syntax).
   * A policy rejection (550) would be conformant; a syntax error is not.
   */
  readonly rejectSourceRouteAsSyntax?: boolean;
  /**
   * Drop (destroy) the connection when a source-routed forward-path is seen —
   * the "unprepared" behaviour R-5321-3.3-k forbids (as opposed to any well-formed
   * reply, which is conformant).
   */
  readonly dropOnSourceRoute?: boolean;
  /**
   * Stay silent on connect (send no greeting, keep the socket open). Models a
   * server indistinguishable from a merely slow one — used to prove the greeting
   * test yields INCONCLUSIVE (not a finding) on a timeout, not to catch a
   * violation.
   */
  readonly silentOnConnect?: boolean;
  /**
   * Accept the TCP connection then immediately close with NO opening message.
   * This IS the observable §3.1-a violation (distinct from staying silent), so
   * it is the provable negative control for the greeting test.
   */
  readonly closeOnConnect?: boolean;
  /** Send a greeting with no domain identification ("220" alone). Violates R-5321-4.1.1.1-d. */
  readonly greetingWithoutDomain?: boolean;
  /** EHLO reply's first line carries no server domain. Violates R-5321-4.1.1.1-d. */
  readonly ehloResponseNoDomain?: boolean;
  /** Reject the HELO command. Violates R-5321-4.1.1.1-h (servers MUST support HELO). */
  readonly rejectHelo?: boolean;
  /** Reject the EHLO command (500). Violates R-5321-2.2.1-b (servers MUST support EHLO). */
  readonly rejectEhlo?: boolean;
  /**
   * Do NOT advertise 8BITMIME in EHLO. This is CONFORMANT (§2.4-n is a SHOULD, not
   * a MUST) — it models a server declining the SHOULD, used to prove the latitude
   * case reports permitted-latitude rather than a finding.
   */
  readonly no8bitmime?: boolean;
  /**
   * Return 501 to RSET when it carries an argument (RSET foo). CONFORMANT —
   * §4.3.2-g is a SHOULD; this models a server that FOLLOWS it (the clean server
   * ignores the argument and returns 250, which is the permitted decline).
   */
  readonly rset501OnArgs?: boolean;
  /**
   * Return 501 to NOOP when it carries a parameter (NOOP foo). CONFORMANT —
   * §4.1.1.9-e is a SHOULD to IGNORE the parameter; this models a server that
   * DECLINES that SHOULD (the clean server ignores it and returns 250).
   */
  readonly noop501OnArgs?: boolean;
  /**
   * Reject a command line carrying trailing whitespace (a space/tab before the
   * CRLF) with 500. CONFORMANT-adjacent: §4.1.1-a is a SHOULD to TOLERATE trailing
   * whitespace, so this models a server DECLINING that SHOULD (the clean server
   * tolerates it — its verb parser ignores trailing whitespace).
   */
  readonly rejectTrailingWhitespace?: boolean;
  /**
   * Refuse VRFY with 503 "bad sequence" before an EHLO/HELO. CONFORMANT-adjacent:
   * §4.1.4-b is a SHOULD to accept non-mail commands without initialisation, so
   * this models a server DECLINING that SHOULD (the clean server accepts it).
   */
  readonly vrfy503BeforeGreeting?: boolean;
  /**
   * Answer VRFY with 502 "not implemented". CONFORMANT — §3.5.2-g is a SHOULD,
   * and declining VRFY (anti-harvesting) is standard; models the decline branch.
   */
  readonly vrfyNotSupported?: boolean;
  /**
   * Reject the BARE reserved mailbox `RCPT TO:<postmaster>` (no domain) with 550.
   * Violates R-5321-2.3.5-g (bare postmaster MUST be accepted). Only the
   * domain-less spelling; postmaster@domain is a different requirement.
   */
  readonly rejectBarePostmaster?: boolean;
  /**
   * Answer RSET with 503 "bad sequence" when issued before EHLO/HELO. Violates
   * R-5321-4.1.1.5-d (RSET is a no-op — a 250 — in every state, including before
   * EHLO). The clean server answers 250.
   */
  readonly rset503BeforeGreeting?: boolean;
  /**
   * Honour EXPN with a 250 while NEVER advertising it in EHLO. Violates
   * R-5321-3.5.2-j (if EXPN is supported it MUST be listed as a service extension).
   * The clean server does not implement EXPN (falls through to 500).
   */
  readonly honorUnadvertisedExpn?: boolean;
  /**
   * EHLO/HELO does NOT clear the in-progress transaction (reverse-path buffer),
   * so a 250 to EHLO mid-transaction is a false confirmation. Violates
   * R-5321-4.1.1.1-j (a 250 to EHLO confirms buffers are cleared). The clean
   * server clears the transaction on EHLO/HELO, the RFC §4.1.4 behaviour.
   */
  readonly ehloKeepsTransaction?: boolean;
  /** Answer NOOP with a 500 "command not recognized". Violates R-5321-4.5.1-b. */
  readonly unrecognizedNoop?: boolean;
  /** Send TWO replies to a single NOOP. Violates R-5321-4.2-a (exactly one reply). */
  readonly doubleReplyToNoop?: boolean;
  /** Answer HELP with a 500. Violates R-5321-4.1.1.8-a (HELP sends helpful info). */
  readonly rejectHelp?: boolean;
  /**
   * Honour AUTH with a 334 challenge while NEVER advertising it in EHLO. The
   * clean server has no AUTH (falls through to 500), so this is the inverse of
   * advertiseStarttlsButReject: a supported non-required command left off the
   * EHLO keyword list. Violates R-5321-4.1.1.1-l.
   */
  readonly honorUnadvertisedAuth?: boolean;
  /**
   * Advertise STARTTLS in EHLO but return 502 to the STARTTLS command.
   * Violates R-5321-4.2.4-c (MUST NOT advertise capabilities you will 502/500).
   */
  readonly advertiseStarttlsButReject?: boolean;
  /**
   * The STARTTLS plaintext-injection vulnerability (CVE-2011-0411 class): after
   * answering STARTTLS with 220, PROCESS a command that was pipelined in the same
   * TCP segment (buffered before the TLS handshake) instead of discarding it.
   * RFC 3207 §4.2 requires that buffered plaintext be discarded; processing it
   * lets a MITM inject commands that appear to arrive inside the TLS session.
   */
  readonly injectAfterStartTls?: boolean;
  /**
   * CONFORMANT temp-deferral profiles (not defects): a server under transient
   * conditions answers 4yz. RFC 5321 permits this everywhere — a 4yz is never a
   * MUST violation. They exist to power the "a temporarily-deferring server draws
   * zero findings" invariant, which guards the whole class of 4yz false positive
   * (see mail-delivery accepted-transaction-stored). Each defers at one stage:
   */
  readonly tempDeferAtMail?: boolean; // MAIL FROM -> 451 (e.g. load-based deferral)
  readonly tempDeferAtRcpt?: boolean; // RCPT TO  -> 451 (the canonical greylist)
  readonly tempDeferAtStorage?: boolean; // end-of-data -> 451 (disk pressure / post-DATA defer)
  /** Close the connection on error without sending 421. */
  readonly closeWithout421?: boolean;
  /**
   * Answer an unknown command with 421 (service closing) then close — the
   * CONFORMANT shutdown posture (§3.8/§4.2.1), not a defect. Exists so the
   * connection-stays-open test can be shown to NOT flag a shutting-down server.
   */
  readonly shutdownWith421?: boolean;
  /**
   * Answer an unknown command with 502 rather than the §3.8-d SHOULD's 500 — still
   * tolerant (no close), so a CONFORMANT decline of that SHOULD, used as the
   * `declines` arm of the 3.8-d latitude control.
   */
  readonly unknownCommand502?: boolean;
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
  /**
   * Recipients the server treats as valid (250). Default: accept all. When set,
   * a RCPT for an address NOT in this list is rejected 550 — this is how the
   * mutant models an operator-declared fixture (a valid vs a rejected recipient),
   * so the fixture-gated delivery-path cases have something to observe.
   */
  readonly validRecipients?: readonly string[];
  /** Recipients the server explicitly rejects (550), even if validRecipients is unset. */
  readonly rejectedRecipients?: readonly string[];
}

interface SessionState {
  greeted: boolean;
  hasMail: boolean;
  rcptCount: number;
  inData: boolean;
  /** Set after a 220 to STARTTLS on a safe server: further plaintext is discarded,
   *  awaiting the TLS ClientHello a real client would send next. */
  awaitingTls: boolean;
}

const DEFAULT_DOMAIN = 'mutant.test';

export class MutantServer {
  readonly port: number;
  #server: net.Server;
  #domain: string;
  #defects: Defects;
  #validRecipients: readonly string[] | undefined;
  #rejectedRecipients: readonly string[];

  private constructor(
    server: net.Server,
    port: number,
    domain: string,
    defects: Defects,
    validRecipients: readonly string[] | undefined,
    rejectedRecipients: readonly string[],
  ) {
    this.#server = server;
    this.port = port;
    this.#domain = domain;
    this.#defects = defects;
    this.#validRecipients = validRecipients;
    this.#rejectedRecipients = rejectedRecipients;
  }

  static start(opts: MutantOptions = {}): Promise<MutantServer> {
    const domain = opts.domain ?? DEFAULT_DOMAIN;
    const defects = opts.defects ?? {};
    const lc = (a: string): string => a.toLowerCase();
    const valid = opts.validRecipients?.map(lc);
    const rejected = (opts.rejectedRecipients ?? []).map(lc);
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('no port'));
          return;
        }
        const m = new MutantServer(server, addr.port, domain, defects, valid, rejected);
        server.on('connection', (sock) => m.#handle(sock));
        resolve(m);
      });
    });
  }

  /**
   * Decide the RCPT reply for an address per the declared fixture.
   *
   * Only EXPLICITLY rejected recipients are refused; everything else is accepted.
   * (We do not reject "not in validRecipients", to preserve the accept-all
   * default the existing corpus relies on — the fixture models a specific
   * rejected address, not an allow-list.)
   */
  #recipientVerdict(addr: string): 'accept' | 'reject' {
    return this.#rejectedRecipients.includes(addr.toLowerCase()) ? 'reject' : 'accept';
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #write(sock: net.Socket, buf: Buffer): void {
    if (!sock.destroyed) sock.write(buf);
  }

  #handle(sock: net.Socket): void {
    const d = this.#defects;
    const state: SessionState = { greeted: false, hasMail: false, rcptCount: 0, inData: false, awaitingTls: false };
    let buf = Buffer.alloc(0);

    sock.on('error', () => {});
    if (d.closeOnConnect) {
      // Accept then immediately hang up with no greeting — the observable violation.
      sock.end();
      return;
    }
    if (d.silentOnConnect) {
      // No greeting at all, but the socket stays open — indistinguishable from slow.
    } else if (d.greetingWithoutDomain) {
      // A bare 220 with no domain identification.
      this.#write(sock, crlf`220`);
    } else {
      this.#write(sock, crlf`220 ${this.#domain} ESMTP mutant`);
    }

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);

      for (;;) {
        // After a safe STARTTLS 220, all further plaintext is discarded — the
        // server is waiting for the TLS ClientHello, not SMTP commands.
        if (state.awaitingTls) {
          buf = Buffer.alloc(0);
          break;
        }
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
        // STARTTLS injection primitive (RFC 3207 §4.2, CVE-2011-0411 class). When
        // STARTTLS is honoured, a conformant server answers 220 then MUST discard
        // any plaintext already buffered before the TLS handshake — it must not
        // process a command pipelined in the same segment. We model this without a
        // real handshake: the observable is simply whether that buffered command is
        // answered. `advertiseStarttlsButReject` still falls through to the dispatch
        // 502 (that is a different, advertise-vs-honour defect).
        const verb = line.command.toString('latin1').split(/\s+/)[0]?.toUpperCase();
        if (verb === 'STARTTLS' && !d.advertiseStarttlsButReject) {
          this.#write(sock, crlf`220 2.0.0 Ready to start TLS`);
          buf = buf.subarray(line.consumed);
          if (!d.injectAfterStartTls) {
            // Safe: discard the buffered plaintext and await the ClientHello.
            buf = Buffer.alloc(0);
            state.awaitingTls = true;
          }
          // Defect injectAfterStartTls: do NOT discard — fall through and process
          // whatever was pipelined after STARTTLS (the injected command runs).
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
    // Defect: reject an otherwise-accepted message at end-of-data.
    if (this.#defects.rejectAcceptedMessage) {
      this.#write(sock, crlf`554 5.0.0 message rejected`);
      return eod;
    }
    // Defect: reject a message containing a text line longer than 500 octets,
    // below the 1000-octet floor §4.5.3.1.6 requires a server to accept.
    if (this.#defects.rejectTextLineAt500 && this.#hasOverlongTextLine(buf.subarray(0, eod), 500)) {
      this.#write(sock, crlf`500 Error: text line too long`);
      return eod;
    }
    // Conformant temp-deferral at storage: the message was received but not stored
    // (disk pressure / post-DATA deferral), so a 451 is owed, not a 250.
    if (this.#defects.tempDeferAtStorage) {
      this.#write(sock, crlf`451 4.3.0 message not stored, try again later`);
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
      if (d.twoDigitCode) return this.#write(sock, crlf`25 ${msg}`);
      if (d.firstDigitOutOfRange) return this.#write(sock, crlf`6${String(code).slice(1)} ${msg}`);
      if (d.bareCodeReplies) return this.#write(sock, Buffer.concat([Buffer.from(String(code)), Buffer.from([CR, LF])]));
      if (d.eightBitReplyText) return this.#write(sock, Buffer.concat([Buffer.from(`${code} `), Buffer.from([0xe9]), Buffer.from([CR, LF])]));
      if (d.bareLfReplyTerminator) return this.#write(sock, Buffer.concat([Buffer.from(`${code} ${msg}`, 'latin1'), Buffer.from([LF])]));
      if (d.malformedReplySeparator) return this.#write(sock, crlf`${String(code)}=${msg}`);
      if (d.overlongReplyLine) return this.#write(sock, crlf`${String(code)} ${'x'.repeat(600)}`);
      this.#write(sock, crlf`${String(code)} ${msg}`);
    };

    // Clean-baseline character validation (§4.1.2-n): a command line containing a
    // C0 control octet (other than TAB) or DEL is rejected with 501, UNLESS the
    // acceptControlCharsInCommand defect is on — in which case the forbidden octet
    // is "used" and the command dispatches normally (the violation).
    if (!d.acceptControlCharsInCommand) {
      for (const byte of commandBytes) {
        if ((byte <= 0x08 || (byte >= 0x0b && byte <= 0x1f) || byte === 0x7f)) {
          // Clean baseline rejects with the exact 501; the rejectControlCharsWith500
          // defect rejects (so §4.1.2-j holds) but with the wrong code (so §4.1.2-n's
          // exact-501 duty is violated).
          return replyOK(d.rejectControlCharsWith500 ? 500 : 501, 'Error: invalid character');
        }
      }
    }

    // Trailing-whitespace decline (§4.1.1-a is a SHOULD to TOLERATE trailing
    // whitespace): the clean baseline's verb parser ignores it, so a command with
    // a trailing space/tab dispatches normally. Under this defect it draws 500.
    if (d.rejectTrailingWhitespace) {
      const last = commandBytes[commandBytes.length - 1];
      if (last === 0x20 || last === 0x09) return replyOK(500, 'Error: trailing whitespace not accepted');
    }

    // Case-sensitivity defect (§2.4-a): the clean baseline folds case (verb is
    // uppercased above), so lowercase/mixed verbs dispatch normally. Under this
    // defect, a verb that is not already all-uppercase draws 500.
    if (d.requireUppercaseVerbs) {
      const rawVerb = text.split(/\s+/)[0] ?? '';
      if (rawVerb !== rawVerb.toUpperCase()) {
        return replyOK(500, 'Error: command not recognized');
      }
    }

    switch (verb) {
      case 'EHLO': {
        if (d.rejectEhlo) return replyOK(500, 'Error: command not recognized');
        state.greeted = true;
        // §4.1.4/§4.1.1.1-j: EHLO clears any in-progress transaction. The defect
        // keeps it, making the 250 a false "buffers cleared" confirmation.
        if (!d.ehloKeepsTransaction) {
          state.hasMail = false;
          state.rcptCount = 0;
        }
        const baseKeywords = d.keepStateAcrossStartTls
          ? ['PIPELINING', 'SIZE 10240000', '8BITMIME', 'STARTTLS', 'SECRET-PRE-TLS-KEYWORD']
          : ['PIPELINING', 'SIZE 10240000', '8BITMIME', 'STARTTLS'];
        const keywords = d.no8bitmime ? baseKeywords.filter((k) => k !== '8BITMIME') : baseKeywords;
        if (d.mismatchedContinuation) {
          this.#write(sock, crlf`250-${this.#domain}`);
          this.#write(sock, crlf`251-PIPELINING`); // wrong continuation code
          this.#write(sock, crlf`250 8BITMIME`);
        } else {
          // Defect: first line carries no domain identity ("250-" then a space).
          const firstLine = d.ehloResponseNoDomain ? crlf`250- ` : crlf`250-${this.#domain}`;
          const lines = [firstLine];
          for (let i = 0; i < keywords.length; i++) {
            const isFinal = i === keywords.length - 1;
            // Defect: the final line of the multiline reply carries "=" instead of
            // the required <SP> — a genuine §4.2.1-f multiline-format violation.
            const finalSep = d.malformedMultilineSeparator ? crlf`250=${keywords[i]!}` : crlf`250 ${keywords[i]!}`;
            lines.push(isFinal ? finalSep : crlf`250-${keywords[i]!}`);
          }
          this.#write(sock, Buffer.concat(lines));
        }
        return;
      }
      case 'STARTTLS':
        // Only the advertiseStarttlsButReject (502) path is live here: the HONOURED
        // STARTTLS is intercepted earlier in the #handle data loop (which controls
        // the pre-handshake buffer for the injection test), so it never reaches this
        // case. The 220 below is a dead-but-honest fallback for the honoured path.
        if (d.advertiseStarttlsButReject) return replyOK(502, 'Error: command not implemented');
        return replyOK(220, 'Ready to start TLS');

      case 'HELO':
        if (d.rejectHelo) return replyOK(502, 'Error: HELO not supported');
        state.greeted = true;
        // HELO clears an in-progress transaction too (§4.1.4).
        if (!d.ehloKeepsTransaction) {
          state.hasMail = false;
          state.rcptCount = 0;
        }
        if (d.multilineProseHelo) {
          // Conformant: multiline, but pure prose — no extension keywords.
          this.#write(sock, crlf`250-${this.#domain} at your service`);
          this.#write(sock, crlf`250 Have a nice day`);
          return;
        }
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
        if (d.tempDeferAtMail) return replyOK(451, '4.3.0 try again later');
        state.hasMail = true;
        return replyOK(250, '2.1.0 Ok');

      case 'RCPT':
        if (!state.hasMail && !d.acceptRcptBeforeMail) {
          return replyOK(503, 'Error: need MAIL command');
        }
        if (d.tempDeferAtRcpt) return replyOK(451, '4.7.1 greylisted, try again later');
        // Defect: treat a source-route path (a "@host," before the mailbox) as a
        // syntax error rather than recognising it. text is the whole command line.
        if (d.rejectSourceRouteAsSyntax && /RCPT\s+TO:\s*<@/i.test(text)) {
          return replyOK(501, 'Error: syntax');
        }
        // Defect: be UNPREPARED — drop the connection on a source route (§3.3-k).
        if (d.dropOnSourceRoute && /RCPT\s+TO:\s*<@/i.test(text)) {
          sock.destroy();
          return;
        }
        {
          // Extract the address for the fixture verdict. RCPT TO:<addr> (last @-path).
          const m = /RCPT\s+TO:\s*<([^>]*)>/i.exec(text);
          const addr = m?.[1]?.split(':').pop() ?? '';
          const localPart = addr.split('@')[0] ?? '';
          if (d.rejectValidRecipient) return replyOK(550, '5.1.1 User unknown');
          // Defect: treat "Postmaster" as case-SENSITIVE — reject any spelling
          // that is not exactly lowercase "postmaster" (§4.1.1.3-m requires
          // case-insensitive treatment of the Postmaster local-part).
          if (d.postmasterCaseSensitive && localPart.toLowerCase() === 'postmaster' && localPart !== 'postmaster') {
            return replyOK(550, '5.1.1 User unknown');
          }
          // Defect: reject the BARE (domain-less) postmaster form (§2.3.5-g).
          if (d.rejectBarePostmaster && addr.toLowerCase() === 'postmaster') {
            return replyOK(550, '5.1.1 User unknown');
          }
          const verdict = this.#recipientVerdict(addr);
          if (verdict === 'reject' && !d.acceptRejectedRecipient) {
            return replyOK(550, '5.1.1 Recipient rejected');
          }
          state.rcptCount++;
          return replyOK(250, '2.1.5 Ok');
        }

      case 'DATA':
        if (state.rcptCount === 0 && !d.acceptDataBeforeRcpt) {
          return replyOK(503, 'Error: need RCPT command');
        }
        state.inData = true;
        return this.#write(sock, crlf`354 End data with <CR><LF>.<CR><LF>`);

      case 'RSET':
        // Defect: RSET refused before EHLO — but §4.1.1.5-d says RSET is a no-op
        // (250) in every state, including before EHLO.
        if (d.rset503BeforeGreeting && !state.greeted) {
          return replyOK(503, 'Error: send HELO/EHLO first');
        }
        if (d.rset501OnArgs && /^RSET\s+\S/i.test(text)) {
          return replyOK(501, 'Error: RSET takes no arguments');
        }
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
        if (d.unrecognizedNoop) return replyOK(500, 'Error: command not recognized');
        if (d.noop501OnArgs && /^NOOP\s+\S/i.test(text)) return replyOK(501, 'Error: NOOP takes no arguments');
        if (d.doubleReplyToNoop) {
          // Two replies to one command — the §4.2-a "exactly one reply" violation.
          this.#write(sock, crlf`250 2.0.0 Ok`);
          this.#write(sock, crlf`250 2.0.0 Ok again`);
          return;
        }
        if (d.noopResetsState) {
          // NOOP MUST NOT affect state (§4.1.1.9-a/c). Clear everything to trip
          // both the transaction-buffer and the previous-command tests.
          state.greeted = false;
          state.hasMail = false;
          state.rcptCount = 0;
        }
        return replyOK(d.noopWrongReply ? 500 : 250, '2.0.0 Ok');

      case 'HELP':
        if (d.rejectHelp) return replyOK(500, 'Error: command not recognized');
        if (d.helpResetsState) {
          state.hasMail = false;
          state.rcptCount = 0;
        }
        return replyOK(214, 'https://example.com/smtp-help');

      case 'EXPN':
        // Defect: honour EXPN (250) while EHLO never advertises it — §3.5.2-j.
        if (d.honorUnadvertisedExpn) return replyOK(250, 'Expansion complete');
        // Clean baseline has no EXPN (falls through to 500). The defect makes it a
        // recognised success that wrongly clears state (§4.1.1.7-c).
        if (d.expnResetsState) {
          state.hasMail = false;
          state.rcptCount = 0;
          return replyOK(250, 'Expansion complete');
        }
        return replyOK(500, 'Error: command not recognized');

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

      case 'AUTH':
        // Clean baseline does not implement AUTH and never advertises it, so it
        // falls through to the 500 below. The defect honours it (a 334 challenge)
        // while EHLO still omits the AUTH keyword — the §4.1.1.1-l violation.
        if (d.honorUnadvertisedAuth) return replyOK(334, 'VXNlcm5hbWU6');
        return replyOK(500, 'Error: command not recognized');

      case 'VRFY':
        if (d.vrfy503BeforeGreeting && !state.greeted) {
          return replyOK(503, 'Error: send HELO/EHLO first');
        }
        if (d.vrfyNotSupported) return replyOK(502, 'VRFY not implemented');
        if (d.vrfyResetsState) {
          state.hasMail = false;
          state.rcptCount = 0;
        }
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
        // Latitude decline for §3.8-d: tolerant of the unknown command (no close)
        // but answers 502 rather than the SHOULD's 500 — conformant, just declining
        // the specific code the SHOULD names.
        if (d.unknownCommand502) return replyOK(502, 'Error: command not implemented');
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
