/**
 * DKIM signing for the outbound relay (RFC 6376 §5), wired to the send path.
 *
 * Gmail's rejection of our first real send listed "DKIM = did not pass"; SPF
 * alone gets mail accepted-but-spam-foldered, DKIM is what earns the inbox. The
 * signing crypto (src/crypto/dkim-sign.ts) was already built and vector-pinned;
 * this is the glue that turns an arbitrary submitted message into a signed one:
 * split header/body, sign the headers that are present (in the conventional
 * order), and prepend the DKIM-Signature. It signs AFTER the §6409 fix-up so the
 * added Date/Message-ID are covered.
 *
 * Fail-open: any problem (no header/body boundary, weak key, sign error) returns
 * the message unchanged rather than dropping deliverable mail — an unsigned
 * message still goes out (to spam, as before), which is strictly better than not
 * sending. Bytes, never strings: the body is signed and relayed as octets.
 */

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { signMessage } from '../crypto/dkim-sign.ts';
import { selectSignedFields } from '../crypto/dkim-verify.ts';
import { parseMessage } from '../message/parse.ts';

export interface DkimSigner {
  readonly domain: string;
  readonly selector: string;
  readonly privateKey: KeyObject;
}

/** Header fields to sign when present, in conventional order (RFC 6376 §5.4). */
const SIGN_HEADERS = ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding'];

/** Build a signer from a PEM private key. Throws if the key is unusable. */
export function makeSigner(domain: string, selector: string, privateKeyPem: string): DkimSigner {
  return { domain, selector, privateKey: createPrivateKey(privateKeyPem) };
}

/**
 * Prepend a DKIM-Signature to `raw`, signing the present standard headers over
 * relaxed/relaxed canonicalization. Returns `raw` unchanged if it cannot sign.
 */
export function dkimSign(raw: Buffer, signer: DkimSigner): Buffer {
  const sep = raw.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
  if (sep === -1) return raw; // no header/body boundary — cannot sign safely
  const body = raw.subarray(sep + 4);

  const headers = parseMessage(raw).headers;
  // The h= NAME list: the present standard headers in conventional order, with From OVERSIGNED
  // — listed once more than it appears — so a downstream that PREPENDS a second From breaks our
  // signature (RFC 6376 §5.4.2: the excess h=from selects the null input here, but binds a
  // forged second From at a verifier). A submitted/generated message carries exactly one From
  // (submission enforces it, ADR 0015), so this lists From twice.
  const present = SIGN_HEADERS.filter((want) => headers.some((f) => f.name.toString('latin1').trim().toLowerCase() === want));
  // Never emit a signature that does not cover From (mirrors the inbound guard, dkim-inbound.ts):
  // a From-less signed message (e.g. a MAIL FROM:<> submission with no From header) lets a
  // downstream append ANY From under our d= authority. Fail open — send it unsigned rather than
  // sign a spoofable message (audit run-6).
  if (!present.includes('from')) return raw;
  const headerNames = [...present, 'from']; // oversign From
  // Build the hashed fields through the SAME §5.4.2 selector the verifier uses, so our own
  // round-trip is consistent by construction (the trailing oversign `from` selects null here).
  const signedFields = selectSignedFields(headers, headerNames);
  if (signedFields.length === 0) return raw;

  const result = signMessage({
    domain: signer.domain,
    selector: signer.selector,
    headerCanon: 'relaxed',
    bodyCanon: 'relaxed',
    signedHeaders: signedFields,
    headerNames,
    body,
    privateKey: signer.privateKey,
  });
  if (!result.ok) return raw;
  return Buffer.concat([Buffer.from(`DKIM-Signature: ${result.header}\r\n`, 'latin1'), raw]);
}

/**
 * The public-key DNS TXT record value for a signer's key — what must be published
 * at <selector>._domainkey.<domain> for verifiers to find it (RFC 6376 §3.6.1).
 */
export function publicKeyRecord(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }).toString('base64');
  return `v=DKIM1; k=rsa; p=${der}`;
}
