/**
 * RFC 6376 §6.1 to §6.1.3 — DKIM verification: what a Verifier must refuse, and why.
 *
 * The crypto register covered signing thoroughly and verification barely at all, which is the wrong
 * way round for a receiving server. Signing wrong produces mail other people reject; verifying
 * wrong produces mail WE accept and attribute to a domain that did not send it — and DKIM feeds
 * DMARC, so a verifier that is too generous hands an attacker an aligned pass on a domain
 * publishing p=reject.
 *
 * Almost every requirement below is a refusal, and the RFC names the reason each time (PERMFAIL
 * (From field not signed), PERMFAIL (key revoked), and so on). Those names are worth preserving in
 * the register because they are the difference between "the signature did not verify" and the
 * specific reason, and a verifier that collapses them all into one answer cannot report
 * Authentication-Results honestly.
 *
 * The one to read twice is §6.1.1's From requirement. A signature whose "h=" omits From covers
 * nothing that identifies the author, so an attacker can lift a valid signature from one message
 * and replace the visible sender. Accepting it is not a lenience — it is a spoofing primitive.
 *
 * Verbatim quotes from spec/rfc6376.txt.
 */

import type { RequirementDef } from '../../types.ts';

export const DKIM_VERIFY = [
  {
    id: 'R-6376-6.1-a',
    rfc: 'rfc6376',
    section: '6.1',
    page: 44,
    level: 'MUST NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Verifiers MUST NOT attribute ultimate meaning to the order of multiple DKIM-Signature header fields.',
    testability: { kind: 'parse' },
    note:
      'A message may carry several signatures and their order says nothing. The attack this forecloses '
      + 'is prepending a signature the attacker controls so that a verifier taking "the first one" '
      + 'reports their domain — or, worse, stops there. Each signature is evaluated on its own merits.',
  },
  {
    id: 'R-6376-6.1-b',
    rfc: 'rfc6376',
    section: '6.1',
    page: 44,
    level: 'SHOULD NOT',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Therefore, a Verifier SHOULD NOT treat a message that has one or more bad signatures and no good signatures differently from a message with no signature at all.',
    testability: { kind: 'parse' },
    note:
      'A broken signature is not evidence of anything, in either direction. Treating it as suspicious '
      + 'punishes messages mangled by a mailing list; treating it as partial credit is worse. The '
      + 'observable form is that the verdict for "bad signature only" equals the verdict for "no '
      + 'signature": none, not fail-with-attribution.',
  },
  {
    id: 'R-6376-6.1.1-a',
    rfc: 'rfc6376',
    section: '6.1.1',
    page: 45,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Implementers MUST meticulously validate the format and values in the DKIM-Signature header field; any inconsistency or unexpected values MUST cause the header field to be completely ignored and the Verifier to return PERMFAIL (signature syntax error).',
    testability: { kind: 'parse' },
    note:
      'The RFC rarely uses a word like "meticulously". It is there because a lenient parser is how a '
      + 'verifier ends up disagreeing with the signer about what was signed — and any such '
      + 'disagreement is exploitable. "Completely ignored" rules out partial credit for a signature '
      + 'that is nearly well-formed.',
  },
  {
    id: 'R-6376-6.1.1-b',
    rfc: 'rfc6376',
    section: '6.1.1',
    page: 45,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Verifiers MUST return PERMFAIL (incompatible version) when presented a DKIM-Signature header field with a "v=" tag that is inconsistent with this specification.',
    testability: { kind: 'parse' },
    note:
      'Only "v=1" exists. A different version means the field follows rules this implementation does '
      + 'not know, so guessing at it is exactly the disagreement §6.1.1-a warns about.',
  },
  {
    id: 'R-6376-6.1.1-c',
    rfc: 'rfc6376',
    section: '6.1.1',
    page: 45,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If any tag listed as "required" in Section 3.5 is omitted from the DKIM-Signature header field, the Verifier MUST ignore the DKIM-Signature header field and return PERMFAIL (signature missing required tag).',
    testability: { kind: 'parse' },
    note:
      'The required tags are v, a, b, bh, d, h and s. Each omission is a different missing constraint '
      + '— no "d=" means no domain to attribute the pass to, no "bh=" means the body is unbound — so '
      + 'the case exercises them one at a time rather than trusting one representative.',
  },
  {
    id: 'R-6376-6.1.1-d',
    rfc: 'rfc6376',
    section: '6.1.1',
    page: 46,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the DKIM-Signature header field does not contain the "i=" tag, the Verifier MUST behave as though the value of that tag were "@d", where "d" is the value from the "d=" tag.',
    testability: { kind: 'parse' },
    note:
      'The default that makes the next requirement well-defined: without it, an absent "i=" would '
      + 'leave nothing to compare "d=" against, and a verifier could either skip the check or invent '
      + 'an answer. Most real signatures omit "i=", so this is the common path rather than an edge.',
  },
  {
    id: 'R-6376-6.1.1-e',
    rfc: 'rfc6376',
    section: '6.1.1',
    page: 46,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'Verifiers MUST confirm that the domain specified in the "d=" tag is the same as or a parent domain of the domain part of the "i=" tag.',
    testability: { kind: 'parse' },
    note:
      'Stops a signature signed by one domain claiming an identity in another. "Parent domain" is the '
      + 'trap: `d=example.com` may carry `i=@mail.example.com`, but not `i=@example.com.attacker.test` '
      + '— a suffix comparison that forgets the label boundary accepts the second.',
  },
  {
    id: 'R-6376-6.1.1-f',
    rfc: 'rfc6376',
    section: '6.1.1',
    page: 46,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the "h=" tag does not include the From header field, the Verifier MUST ignore the DKIM-Signature header field and return PERMFAIL (From field not signed).',
    testability: { kind: 'parse' },
    note:
      'The most security-critical requirement in DKIM verification. A signature that does not cover '
      + 'From binds nothing about who the message claims to be from, so an attacker can take a valid '
      + 'signature from a message the signing domain really sent, attach it to their own content with '
      + 'their own From, and collect a DKIM pass. Because DMARC alignment is computed against the '
      + '"d=" of a PASSING signature, accepting this yields an aligned pass on a domain publishing '
      + 'p=reject. Not lenience: a spoofing primitive.',
  },
  {
    id: 'R-6376-6.1.2-a',
    rfc: 'rfc6376',
    section: '6.1.2',
    page: 47,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'The Verifier MUST validate the key record and MUST ignore any public-key records that are malformed.',
    testability: { kind: 'parse' },
    note:
      'The key record arrives from DNS, which is attacker-influenceable for any domain an attacker '
      + 'controls — and the whole point is that they control the domain they are signing as. A '
      + 'malformed record is ignored rather than salvaged.',
  },
  {
    id: 'R-6376-6.1.2-b',
    rfc: 'rfc6376',
    section: '6.1.2',
    page: 47,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the query for the public key fails because the corresponding key record does not exist, the Verifier MUST immediately return PERMFAIL (no key for signature).',
    testability: { kind: 'parse' },
    note:
      'PERM, not TEMP, and the distinction is the point: a missing record is a definite answer, while '
      + 'a DNS failure is not. Collapsing the two either makes a permanently-unverifiable message '
      + 'retry forever, or makes a transient outage look like a forgery.',
  },
  {
    id: 'R-6376-6.1.2-c',
    rfc: 'rfc6376',
    section: '6.1.2',
    page: 48,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the result returned from the query does not adhere to the format defined in this specification, the Verifier MUST ignore the key record and return PERMFAIL (key syntax error).',
    testability: { kind: 'parse' },
    note:
      'Distinct from "no key" (R-6376-6.1.2-b) and from "revoked" (R-6376-6.1.2-e): three different '
      + 'reasons a key cannot be used, which an operator debugging a deliverability problem needs to '
      + 'be able to tell apart.',
  },
  {
    id: 'R-6376-6.1.2-d',
    rfc: 'rfc6376',
    section: '6.1.2',
    page: 48,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'In particular, the Verifier MUST ignore keys with a version code ("v=" tag) that they do not implement.',
    testability: { kind: 'parse' },
    note:
      'The key record\'s own version, separate from the signature\'s (R-6376-6.1.1-b). A key declaring '
      + 'a version we do not implement carries semantics we would be guessing at.',
  },
  {
    id: 'R-6376-6.1.2-e',
    rfc: 'rfc6376',
    section: '6.1.2',
    page: 48,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the public-key data (the "p=" tag) is empty, then this key has been revoked and the Verifier MUST treat this as a failed signature check and return PERMFAIL (key revoked).',
    testability: { kind: 'parse' },
    note:
      'An empty "p=" is a deliberate statement, not an incomplete record: it is how a domain revokes a '
      + 'selector after a key leak. A verifier that reads it as "no key material, try something else" '
      + 'defeats the only revocation mechanism DKIM has.',
  },
  {
    id: 'R-6376-6.1.2-f',
    rfc: 'rfc6376',
    section: '6.1.2',
    page: 48,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the public-key data is not suitable for use with the algorithm and key types defined by the "a=" and "k=" tags in the DKIM-Signature header field, the Verifier MUST immediately return PERMFAIL (inappropriate key algorithm).',
    testability: { kind: 'parse' },
    note:
      'The signature names an algorithm and the key record names a type, and they have to agree. '
      + 'Trying the key against whatever algorithm happens to parse is how an implementation ends up '
      + 'verifying an Ed25519 signature against an RSA key or vice versa.',
  },
  {
    id: 'R-6376-6.1.3-a',
    rfc: 'rfc6376',
    section: '6.1.3',
    page: 49,
    level: 'MUST',
    party: 'server',
    normativeSource: 'keyword',
    text: 'When matching header field names in the "h=" tag against the actual message header field, comparisons MUST be case-insensitive.',
    testability: { kind: 'parse' },
    note:
      'Header field names are case-insensitive everywhere else in mail, and a verifier that compares '
      + 'them exactly here fails every signature listing "from" against a message writing "From" — '
      + 'and, more dangerously, could be steered into skipping a field the signer intended to cover.',
  },
  {
    id: 'R-6376-6.1.3-b',
    rfc: 'rfc6376',
    section: '6.1.3',
    page: 49,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the hash does not match, the Verifier SHOULD ignore the signature and return PERMFAIL (body hash did not verify).',
    testability: { kind: 'parse' },
    note:
      'The body-hash check is what binds the content, and it is separate from the signature check '
      + '(R-6376-6.1.3-c) so that a verifier can report which one failed. A modified body with an '
      + 'otherwise-valid signature is the classic mailing-list breakage AND the classic tamper, and '
      + 'the verifier cannot tell them apart — which is why both are simply PERMFAIL.',
  },
  {
    id: 'R-6376-6.1.3-c',
    rfc: 'rfc6376',
    section: '6.1.3',
    page: 49,
    level: 'SHOULD',
    party: 'server',
    normativeSource: 'keyword',
    text: 'If the signature does not validate, the Verifier SHOULD ignore the signature and return PERMFAIL (signature did not verify).',
    testability: { kind: 'parse' },
    note:
      'The cryptographic check itself, after every structural precondition has passed. Registered '
      + 'separately from the body hash because reaching this point means the message survived all of '
      + 'the above, and reporting them as one answer loses the distinction between "tampered" and '
      + '"the wrong key".',
  },
] as const satisfies readonly RequirementDef[];
