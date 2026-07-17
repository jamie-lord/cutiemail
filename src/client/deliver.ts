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
  readonly quit: boolean;
  /** Why we stopped, when !ok. */
  readonly failure: string | null;
}

const DEFAULT_TIMEOUT = 5000;

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
    quit: false,
    failure: null,
  };

  const wire = await Wire.connect(connect);
  try {
    // Greeting.
    const greeting = await readReply(wire, timeoutMs);
    if (!is2yz(greeting)) {
      return { ...base, greetingCode: greeting?.code ?? null, failure: 'no 2yz greeting' };
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
      } else if (options.startTls === true && advertisesStartTls(ehlo!)) {
        // Opportunistic STARTTLS (RFC 3207): upgrade, then re-EHLO over TLS.
        await wire.send(command('STARTTLS', defects));
        const ready = await readReply(wire, timeoutMs);
        if (is2yz(ready)) {
          try {
            await wire.startTls({ rejectUnauthorized: false, servername: connect.host });
            await wire.send(command(`EHLO ${req.clientName}`, defects));
            const reEhlo = await readReply(wire, timeoutMs);
            if (!is2yz(reEhlo)) return { ...base, greetingCode, openingVerb, failure: 'EHLO after STARTTLS refused' };
          } catch {
            // Handshake failed — the connection is unusable now; give up this
            // attempt so the queue retries (plaintext fallback needs a fresh
            // connection, which the retry provides).
            return { ...base, greetingCode, openingVerb, failure: 'STARTTLS handshake failed' };
          }
        }
        // A refused STARTTLS (non-2yz) just continues in plaintext.
      }
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
    const finalReply = await readReply(wire, timeoutMs);
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
      failure: is2yz(finalReply) ? null : `data not accepted (${finalReply?.code ?? 'no reply/timeout'})`,
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
