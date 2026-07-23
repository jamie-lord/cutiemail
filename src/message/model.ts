/**
 * The parsed-message model — the adapter contract a message parser satisfies.
 *
 * This is the message-format analogue of the SMTP suite's wire model: it defines
 * what "a parsed message" IS, so a conformance corpus can be written against the
 * shape rather than against one implementation. The real server parser and the
 * reference parser used to validate the corpus both produce this.
 *
 * BYTES, NEVER STRINGS. A header value can carry 8-bit octets, RFC 2047 encoded
 * words, or (under SMTPUTF8) raw UTF-8; the body is arbitrary octets. Decoding is a
 * later, explicit step — the parser's job is to find the STRUCTURE without lying
 * about the bytes. Every field here is a Buffer for that reason.
 */

/** One header field, as it appeared on the wire. */
export interface Header {
  /** The field name, before the colon, trimmed of surrounding space. e.g. `From`. */
  readonly name: Buffer;
  /**
   * The field body: everything after the first colon, with folding UNremoved
   * (the raw bytes across continuation lines, minus the final CRLF). Unfolding is
   * a caller's decision, so the parser does not discard information.
   */
  readonly value: Buffer;
}

/**
 * A structural anomaly the parser noticed but did not treat as fatal. The corpus
 * asserts on these: a conformant parser must SEE an over-long line or a bare-LF
 * terminator, whether or not it rejects the message. Recording rather than
 * silently normalising is the whole point (cf. the non-normalising SMTP reply
 * reader).
 */
export interface Anomaly {
  readonly kind:
    | 'line-over-998' // R-5322-2.1.1-a: a line exceeds the hard 998-octet limit
    | 'bare-lf' // a line terminated by LF without a preceding CR (§2.1 line def)
    | 'bare-cr' // a CR not followed by LF
    | 'nul-octet' // a NUL (0x00) — unconditionally invalid, even under MIME/EAI
    | 'eight-bit' // an octet >= 0x80 (valid only where 8BITMIME/SMTPUTF8 negotiated)
    | 'header-no-colon' // a header-section line with no colon
    | 'field-name-invalid-char' // R-5322-2.2-a: a field name octet outside 33-126
    | 'too-many-headers' // the header section exceeded MAX_HEADERS fields (a parse-time DoS cap)
    | 'header-section-over-cap' // the header section exceeded MAX_HEADER_SECTION_BYTES (a parse-time DoS cap)
    | 'too-many-anomalies' // the anomaly list hit MAX_ANOMALIES and was truncated (a parse-time DoS cap)
    | 'no-empty-line'; // message never had a header/body separator (all headers)
  /** 1-based line number where it occurred (0 for whole-message anomalies). */
  readonly line: number;
}

export interface Message {
  readonly headers: readonly Header[];
  /** Everything after the first empty line. Empty (length 0) if there was none. */
  readonly body: Buffer;
  /** Non-fatal structural observations, in order. */
  readonly anomalies: readonly Anomaly[];
}
