/**
 * SMTPUTF8 internationalization detection and the transmission gate (RFC 6531 §3.5),
 * with a defect.
 *
 * Bytes, never strings: "internationalized" is an octet-level property — any octet
 * above 0x7f in an address or header makes the content require SMTPUTF8. The gate
 * refuses to transmit such content to a server that did not advertise the extension.
 */

/** True if any octet is non-ASCII (> 0x7f) — the mark of internationalized content. */
export function isInternationalized(content: Buffer): boolean {
  for (const octet of content) if (octet > 0x7f) return true;
  return false;
}

/** True if any of the envelope addresses is internationalized. */
export function envelopeIsInternationalized(addresses: readonly Buffer[]): boolean {
  return addresses.some(isInternationalized);
}

export interface TransmitDefects {
  /** Transmit internationalized content without SMTPUTF8 negotiated. Violates R-6531-3.5-a. */
  readonly sendWithoutNegotiation?: boolean;
}

/**
 * May this message be transmitted? Internationalized content requires the server to
 * have advertised SMTPUTF8; all-ASCII content transmits to any server.
 */
export function mayTransmit(internationalized: boolean, serverSupportsSmtputf8: boolean, defects: TransmitDefects = {}): boolean {
  if (!internationalized) return true;
  if (defects.sendWithoutNegotiation === true) return true;
  return serverSupportsSmtputf8;
}
