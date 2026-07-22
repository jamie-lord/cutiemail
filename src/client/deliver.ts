/**
 * A reference SMTP delivery client (RFC 5321 client role), with switchable defects.
 *
 * This is the client-side mirror of the mutant server: a correct-by-default
 * implementation of the client half of an SMTP delivery transaction, plus a set of
 * flags that each turn OFF one client obligation. The conformant path proves the
 * client behaves; each defect is a negative control proving the outbound corpus can
 * actually detect the violation. See docs/decisions/0008-outbound-client-harness.md.
 *
 * Scope is one delivery over one already-open route: greet (EHLO, fall back to
 * HELO), MAIL FROM, RCPT TO(s), DATA with transparency and the terminating
 * <CRLF>.<CRLF>, QUIT. It does NOT do MX resolution, queueing, retry scheduling,
 * or TLS negotiation — those are later increments (ADR 0008 "bare-minimum-first").
 *
 * Bytes, never strings: commands are assembled as Buffers and the message data is
 * dot-stuffed at the octet level via wire/bytes.ts, the exact code the receiver
 * suite already trusts.
 */

import { Wire } from '../wire/transport.ts';
import type { WireOptions } from '../wire/transport.ts';
import { replyFramer, frameReplyAtEof } from '../wire/reply.ts';
import type { Reply } from '../wire/reply.ts';
import { CR, LF, DOT, CRLF, EOD, dotStuff } from '../wire/bytes.ts';
import { envelopeIsInternationalized } from '../transport/smtputf8.ts';

export interface DeliveryRequest {
  /** Envelope reverse-path (may be empty for a bounce, i.e. MAIL FROM:<>). */
  readonly from: string;
  readonly recipients: readonly string[];
  /** The message (headers + body), assumed already CRLF-normalised by the caller. */
  readonly data: Buffer;
  /** The domain to announce in EHLO/HELO. */
  readonly clientName: string;
}

export interface ClientDefects {
  /** Terminate commands with a bare LF instead of CRLF. Violates R-5321-2.3.8-c. */
  readonly emitBareLf?: boolean;
  /** Fire MAIL/RCPT/DATA without waiting for each reply. Violates R-5321-2.1-h. */
  readonly pipelineWithoutWaiting?: boolean;
  /** Send message data but omit the terminating <CRLF>.<CRLF>. Violates R-5321-3.3-u. */
  readonly skipTerminatingDot?: boolean;
  /** Proceed to DATA even after MAIL/RCPT was refused 5yz. Violates R-5321-3.3-y. */
  readonly ignore5yzAndSendData?: boolean;
  /** Open with HELO and never attempt EHLO. Undoes the SHOULD of R-5321-2.2.1-c. */
  readonly heloOnly?: boolean;
  /** On an EHLO refusal, give up instead of falling back to HELO. Undoes R-5321-3.2-c. */
  readonly noHeloFallback?: boolean;
  /** Transmit the DATA payload WITHOUT dot-stuffing leading dots. Violates
   *  R-5321-4.5.2-a — the send-side of the SMTP-smuggling surface. */
  readonly skipDotStuffing?: boolean;
}

export interface DeliveryResult {
  readonly ok: boolean;
  readonly greetingCode: number | null;
  /** The verb we opened with, or null if we never got that far. */
  readonly openingVerb: 'EHLO' | 'HELO' | null;
  /** True if we opened with EHLO, it was refused, and we fell back to HELO. */
  readonly heloFellBack: boolean;
  readonly mailCode: number | null;
  readonly rcptCodes: readonly number[];
  /** True once we transmitted (or began transmitting) message data. */
  readonly sentData: boolean;
  readonly dataCode: number | null;
  /**
   * True when we transmitted the FULL terminating <CRLF>.<CRLF> but got no reply within the
   * post-EOD window (timeout / close / reset). The outcome is INDETERMINATE - the peer may have
   * accepted the message without our seeing the 250 (RFC 5321 §4.5.3.2.6, "the likelihood that a
   * duplicate message will be sent"). The relay treats this specially: it must NOT walk to the
   * next MX in the same tick, and must not resend in a way that duplicates.
   */
  readonly dataIndeterminate: boolean;
  readonly quit: boolean;
  /** Why we stopped, when !ok. */
  readonly failure: string | null;
}

const DEFAULT_TIMEOUT = 5000;
/**
 * The reply after the terminating <CRLF>.<CRLF> gets a far longer deadline than the other
 * phases. RFC 5321 §4.5.3.2.6 sets the "DATA termination" timeout to 10 MINUTES, precisely
 * "because of the likelihood that a duplicate message will be sent" if a client gives up here
 * and retries: the peer commonly runs a slow content scanner that has already accepted (and will
 * reply 250) while a short client timer fires. A generous window turns almost every real
 * slow-scanner case into a normal 250 instead of a duplicate. Per-phase timeouts (§4.5.3.2) are
 * otherwise driven by the caller's `timeoutMs`.
 */
const DEFAULT_POST_DATA_REPLY_TIMEOUT = 10 * 60_000;

/** Assemble a command line with the configured terminator. */
function command(verb: string, defects: ClientDefects): Buffer {
  const term = defects.emitBareLf === true ? Buffer.from([LF]) : CRLF;
  return Buffer.concat([Buffer.from(verb, 'latin1'), term]);
}

/** Read one reply, or null if the peer timed out / closed / reset instead. */
async function readReply(wire: Wire, timeoutMs: number): Promise<Reply | null> {
  const r = await wire.read(replyFramer, timeoutMs, frameReplyAtEof);
  return r.kind === 'framed' ? r.value : null;
}

const is2yz = (r: Reply | null): boolean => r !== null && r.code >= 200 && r.code < 300;
const is5yz = (r: Reply | null): boolean => r !== null && r.code >= 500 && r.code < 600;

/** Does an EHLO reply advertise the STARTTLS extension? */
function advertisesStartTls(ehlo: Reply): boolean {
  return ehlo.lines.some((l) => l.text.toString('latin1').trim().toUpperCase().startsWith('STARTTLS'));
}

export interface DeliveryOptions {
  /**
   * Opportunistic STARTTLS: if the peer advertises STARTTLS after EHLO, upgrade
   * the connection before the transaction (RFC 3207). Certificates are NOT
   * validated — opportunistic TLS buys encryption in transit, not authentication,
   * and MX certs are routinely self-signed or name-mismatched. A STARTTLS that
   * fails to negotiate falls back to plaintext rather than dropping the mail.
   */
  readonly startTls?: boolean;
  /**
   * MTA-STS enforce (RFC 8461): require STARTTLS *and* a certificate that validates for
   * the MX hostname. STARTTLS not offered, a failed handshake, or an invalid/mismatched
   * certificate becomes a hard failure for this host with NO plaintext fallback — an
   * active downgrade must never result in delivery. Implies `startTls`.
   */
  readonly requireValidCert?: boolean;
  /**
   * Extra TLS options merged into the STARTTLS handshake (before `rejectUnauthorized`/`servername`,
   * which always win). The load-bearing use is `ca`: under MTA-STS enforce the certificate must
   * chain to a trusted root, and this is the injection point the enforce path lacked - so a
   * positive control (a cert chained to a test CA whose name matches the MX) can prove enforce
   * actually DELIVERS, not only that it refuses. Production leaves this unset (the system trust
   * store applies).
   */
  readonly tlsOptions?: import('node:tls').ConnectionOptions;
  /**
   * Override the reply timeout AFTER the terminating <CRLF>.<CRLF> (RFC 5321 §4.5.3.2.6). Defaults
   * to 10 minutes; tests set it short to exercise the indeterminate (dataIndeterminate) path.
   */
  readonly postDataReplyTimeoutMs?: number;
}

export async function deliver(
  connect: WireOptions,
  req: DeliveryRequest,
  defects: ClientDefects = {},
  timeoutMs: number = DEFAULT_TIMEOUT,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const base: DeliveryResult = {
    ok: false,
    greetingCode: null,
    openingVerb: null,
    heloFellBack: false,
    mailCode: null,
    rcptCodes: [],
    sentData: false,
    dataCode: null,
    dataIndeterminate: false,
    quit: false,
    failure: null,
  };

  const wire = await Wire.connect(connect);
  try {
    // Greeting.
    const greeting = await readReply(wire, timeoutMs);
    if (!is2yz(greeting)) {
      // A non-2yz greeting (RFC 5321 §3.1: 554 "no SMTP service here", 421 "not available")
      // means no transaction can happen; the only sensible next command is QUIT. Send it so the
      // peer closes cleanly rather than being dropped mid-session. The code is surfaced for the
      // relay's classification (5yz greeting → permanent, 4yz → transient).
      await wire.send(command('QUIT', defects));
      return { ...base, greetingCode: greeting?.code ?? null, quit: true, failure: 'no 2yz greeting' };
    }
    const greetingCode = greeting!.code;

    // Greet: EHLO preferred (R-5321-2.2.1-c), HELO fallback on refusal (R-5321-3.2-c).
    let openingVerb: 'EHLO' | 'HELO';
    let heloFellBack = false;
    if (defects.heloOnly === true) {
      openingVerb = 'HELO';
      await wire.send(command(`HELO ${req.clientName}`, defects));
      const helo = await readReply(wire, timeoutMs);
      if (!is2yz(helo)) return { ...base, greetingCode, openingVerb, failure: 'HELO refused' };
    } else {
      openingVerb = 'EHLO';
      await wire.send(command(`EHLO ${req.clientName}`, defects));
      const ehlo = await readReply(wire, timeoutMs);
      if (!is2yz(ehlo)) {
        if (defects.noHeloFallback === true) {
          return { ...base, greetingCode, openingVerb, failure: `EHLO refused (${ehlo?.code ?? 'no reply'}), no fallback` };
        }
        // Fall back to HELO for THIS connection (R-5321-3.2-c).
        await wire.send(command(`HELO ${req.clientName}`, defects));
        const helo = await readReply(wire, timeoutMs);
        if (!is2yz(helo)) return { ...base, greetingCode, openingVerb, failure: 'HELO fallback refused' };
        heloFellBack = true;
      } else if ((options.startTls === true || options.requireValidCert === true) && advertisesStartTls(ehlo!)) {
        // Opportunistic STARTTLS (RFC 3207): upgrade, then re-EHLO over TLS. Under MTA-STS
        // enforce the certificate is validated for the MX hostname (rejectUnauthorized).
        await wire.send(command('STARTTLS', defects));
        const ready = await readReply(wire, timeoutMs);
        if (is2yz(ready)) {
          try {
            await wire.startTls({ ...options.tlsOptions, rejectUnauthorized: options.requireValidCert === true, servername: connect.servername ?? connect.host });
            await wire.send(command(`EHLO ${req.clientName}`, defects));
            const reEhlo = await readReply(wire, timeoutMs);
            if (!is2yz(reEhlo)) return { ...base, greetingCode, openingVerb, failure: 'EHLO after STARTTLS refused' };
          } catch {
            // Handshake or certificate validation failed. Under enforce this is terminal
            // (never downgrade); otherwise the queue retries and may fall back to plaintext.
            return { ...base, greetingCode, openingVerb, failure: options.requireValidCert === true ? 'STARTTLS required: handshake or certificate validation failed' : 'STARTTLS handshake failed' };
          }
        } else if (options.requireValidCert === true) {
          return { ...base, greetingCode, openingVerb, failure: 'STARTTLS required (MTA-STS enforce) but refused' };
        }
        // A refused STARTTLS (non-2yz) without enforce just continues in plaintext.
      } else if (options.requireValidCert === true) {
        // MTA-STS enforce but the MX does not offer STARTTLS — refuse to send in the clear.
        return { ...base, greetingCode, openingVerb, failure: 'STARTTLS required (MTA-STS enforce) but not offered' };
      }
    }

    // MTA-STS enforce / requireValidCert: the transaction must NEVER proceed in cleartext.
    // The STARTTLS branches above return terminally when EHLO *succeeds*, but an EHLO refusal
    // (HELO fallback) or a heloOnly opening skips them entirely — so an active attacker who
    // strips ESMTP by rejecting the EHLO verb could otherwise force a full cleartext send under
    // a policy that exists to forbid exactly that. One post-greeting
    // assertion closes every non-TLS path: under enforce, TLS must be established here.
    if (options.requireValidCert === true && !wire.tlsEstablished) {
      return { ...base, greetingCode, openingVerb, heloFellBack, failure: 'STARTTLS required (MTA-STS enforce) but the session is not encrypted' };
    }

    // SMTPUTF8 transmission gate (RFC 6531 §3.5), wiring src/transport/smtputf8.ts. The outbound
    // client does not yet EMIT the SMTPUTF8 parameter nor UTF-8-encode the MAIL/RCPT lines (a
    // recorded ASCII-only-envelope cut - the submission side governs whether an internationalized
    // envelope is accepted at all; see report). The command assembly is latin1, so an
    // internationalized envelope address would be silently mojibaked onto the wire. Refuse to
    // transmit it - fail loudly rather than corrupt - instead of sending a mangled address.
    const envelopeAddresses = [req.from, ...req.recipients].map((a) => Buffer.from(a, 'utf8'));
    if (envelopeIsInternationalized(envelopeAddresses)) {
      await wire.send(command('QUIT', defects));
      return {
        ...base,
        greetingCode,
        openingVerb,
        heloFellBack,
        quit: true,
        failure: 'internationalized envelope requires SMTPUTF8, which this client does not transmit (ASCII-only envelope)',
      };
    }

    // The mail transaction. In the pipeline defect we fire the envelope + DATA
    // without waiting for replies (violating lock-step, R-5321-2.1-h); otherwise
    // strictly one command, one reply.
    let mailCode: number | null = null;
    const rcptCodes: number[] = [];

    if (defects.pipelineWithoutWaiting === true) {
      await wire.send(command(`MAIL FROM:<${req.from}>`, defects));
      for (const rcpt of req.recipients) await wire.send(command(`RCPT TO:<${rcpt}>`, defects));
      await wire.send(command('DATA', defects));
      // Drain replies best-effort so the transaction can finish; the violation is
      // observed at the peer (RCPT arrived before MAIL was answered), not here.
      mailCode = (await readReply(wire, timeoutMs))?.code ?? null;
      for (let i = 0; i < req.recipients.length; i++) rcptCodes.push((await readReply(wire, timeoutMs))?.code ?? 0);
      const dataReply = await readReply(wire, timeoutMs);
      const sentData = await transmitData(wire, req, defects, timeoutMs);
      const finalReply = dataReply !== null && dataReply.code === 354 ? await readReply(wire, timeoutMs) : null;
      await wire.send(command('QUIT', defects));
      return {
        ...base,
        greetingCode,
        openingVerb,
        heloFellBack,
        mailCode,
        rcptCodes,
        sentData,
        dataCode: finalReply?.code ?? null,
        quit: true,
        ok: is2yz(finalReply),
        failure: is2yz(finalReply) ? null : 'pipelined transaction did not complete',
      };
    }

    // Lock-step path.
    await wire.send(command(`MAIL FROM:<${req.from}>`, defects));
    const mail = await readReply(wire, timeoutMs);
    mailCode = mail?.code ?? null;

    for (const rcpt of req.recipients) {
      await wire.send(command(`RCPT TO:<${rcpt}>`, defects));
      const rr = await readReply(wire, timeoutMs);
      rcptCodes.push(rr?.code ?? 0);
    }

    const anyRecipientAccepted = rcptCodes.some((c) => c >= 200 && c < 300);
    const envelopeRefused = is5yz(mail) || !anyRecipientAccepted;

    // R-5321-3.3-y: on a 5yz (or with no accepted recipient) the client MUST NOT
    // send message data. The defect barrels on regardless.
    if (envelopeRefused && defects.ignore5yzAndSendData !== true) {
      await wire.send(command('QUIT', defects));
      return {
        ...base,
        greetingCode,
        openingVerb,
        heloFellBack,
        mailCode,
        rcptCodes,
        quit: true,
        failure: 'envelope refused; no data sent (R-5321-3.3-y)',
      };
    }

    await wire.send(command('DATA', defects));
    const dataReply = await readReply(wire, timeoutMs);
    if (dataReply === null || dataReply.code !== 354) {
      await wire.send(command('QUIT', defects));
      return { ...base, greetingCode, openingVerb, heloFellBack, mailCode, rcptCodes, quit: true, failure: `DATA not accepted (${dataReply?.code ?? 'no reply'})` };
    }

    const sentData = await transmitData(wire, req, defects, timeoutMs);
    // Per-phase timeout (RFC 5321 §4.5.3.2): the reply after the terminating dot gets the generous
    // DATA-termination window - UNLESS we deliberately skipped the terminator (a defect), in which
    // case there is no dot on the wire and nothing to wait minutes for, so the caller's timeout
    // applies as before.
    const sentTerminator = defects.skipTerminatingDot !== true;
    const postEodTimeout = sentTerminator ? (options.postDataReplyTimeoutMs ?? DEFAULT_POST_DATA_REPLY_TIMEOUT) : timeoutMs;
    const finalReply = await readReply(wire, postEodTimeout);
    // Best-effort QUIT: when the post-EOD outcome is indeterminate BECAUSE the peer closed/reset
    // after consuming the message, the wire is already down and a QUIT send would REJECT - which
    // would throw out of deliver, and the relay's catch would then mark it a plain transient and
    // walk to the next MX (the exact duplicate this fix prevents). Swallow the send error so the
    // indeterminate result is returned intact.
    try {
      await wire.send(command('QUIT', defects));
    } catch {
      /* peer already gone - the outcome below still stands */
    }

    // Sent the full terminator but heard nothing back → INDETERMINATE (the peer may hold the
    // message already). Distinct from a plain "data not accepted": the relay must not next-MX or
    // naively resend on this.
    const dataIndeterminate = sentTerminator && finalReply === null;
    return {
      ...base,
      greetingCode,
      openingVerb,
      heloFellBack,
      mailCode,
      rcptCodes,
      sentData,
      dataCode: finalReply?.code ?? null,
      dataIndeterminate,
      quit: true,
      ok: is2yz(finalReply),
      failure: is2yz(finalReply)
        ? null
        : dataIndeterminate
          ? 'no reply after end-of-data (indeterminate - possible duplicate on resend)'
          : `data not accepted (${finalReply?.code ?? 'no reply/timeout'})`,
    };
  } finally {
    await wire.close();
  }
}

/**
 * Transmit the dot-stuffed message data and the terminating <CRLF>.<CRLF>.
 * Returns true once data was put on the wire. The skipTerminatingDot defect omits
 * the terminator (R-5321-3.3-u) — the peer then never sees end-of-data.
 */
async function transmitData(wire: Wire, req: DeliveryRequest, defects: ClientDefects, _timeoutMs: number): Promise<boolean> {
  // R-5321-4.5.2-a: the sender MUST dot-stuff — double a leading '.' on each body
  // line so it can't be read as end-of-data. The defect skips it (smuggling).
  const body = defects.skipDotStuffing === true ? req.data : dotStuff(req.data);
  await wire.send(body);
  if (defects.skipTerminatingDot !== true) {
    if (defects.emitBareLf === true) {
      // Bare-LF defect: send the <LF>.<LF> form so the (lenient) peer still
      // recognises end-of-data and the transaction completes.
      await wire.send(Buffer.from([LF, DOT, LF]));
    } else {
      // The terminator is <CRLF>.<CRLF>, and RFC 5321 §4.1.1.4 makes its leading
      // <CRLF> the same one that ends the message's final line. So when the message
      // already ends in CRLF (every well-formed RFC 5322 message does), append only
      // ".<CRLF>"; appending the full 5-byte EOD would inject a spurious blank line
      // into the delivered message. Supply the CRLF only if the message lacks one.
      const endsCrlf = body.length >= 2 && body[body.length - 2] === CR && body[body.length - 1] === LF;
      await wire.send(endsCrlf ? Buffer.from([DOT, CR, LF]) : EOD);
    }
  }
  return true;
}
