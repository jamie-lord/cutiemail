/**
 * The sink view handed to a test that inspects DELIVERED messages.
 *
 * Most of RFC 5321's delivery/transparency surface — dot-un-stuffing (§4.5.2),
 * local-part case preservation (§2.4-c/-d), Received/trace insertion (§4.4), body
 * non-modification (§2.4-i) — is invisible from the client side of a connection:
 * it lives in the message the server DELIVERS, one hop downstream. A test for it
 * drives the server under test to relay a crafted message to a sink we control,
 * then reads back what arrived. This is that read-back interface.
 *
 * Defined here, in the conformance layer, so `Conn` can reference it without the
 * conformance layer depending on the concrete sink implementation in `testing/`.
 */

export interface SinkMessage {
  /** The reverse-path from MAIL FROM, exactly as received (angle brackets stripped). */
  readonly from: string;
  /** The forward-paths from RCPT TO, in order, exactly as received. */
  readonly recipients: readonly string[];
  /**
   * The message content after DATA, dot-UN-stuffed and with the terminating
   * <CRLF>.<CRLF> removed — the bytes a conformant receiver would store.
   */
  readonly data: Buffer;
}

export interface SinkView {
  /** Every message delivered to the sink so far, in arrival order. */
  readonly received: readonly SinkMessage[];
  /**
   * Resolve once at least `count` messages have arrived (default 1), or with the
   * messages received so far if `timeoutMs` elapses first. A relay is asynchronous
   * — the server delivers after it has replied to the client — so a test must wait
   * for arrival rather than read immediately.
   */
  waitFor(count?: number, timeoutMs?: number): Promise<readonly SinkMessage[]>;
}
