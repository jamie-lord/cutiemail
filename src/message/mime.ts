/**
 * A MIME Content-* analyzer (RFC 2045 §4/§5/§6), with switchable defects.
 *
 * The MIME-confusion surface: it reads the MIME-Version, Content-Type and
 * Content-Transfer-Encoding headers and reduces them to a single unambiguous view
 * — media type lowercased, a concrete default where the RFC gives one, and an
 * explicit "treat as opaque octets" flag when the transfer-encoding is not
 * understood. The whole point is that two agents given the same bytes reach the
 * same conclusion; the defects below each reintroduce one way they could diverge.
 *
 * Opinionated cut (ADR 0007): a DUPLICATE Content-Type is flagged as ambiguous
 * rather than silently resolved, because "which Content-Type wins" is exactly the
 * disagreement MIME-confusion attacks exploit.
 *
 * Bytes, never strings — but a Content-* header is structured ASCII, so (as with
 * the date parser) we verify the value is printable ASCII and then work on the
 * decoded token string. An 8-bit octet in a Content-Type value is itself an
 * anomaly, not something to silently decode.
 */

import type { Header } from './model.ts';

const KNOWN_CTE = new Set(['7bit', '8bit', 'binary', 'quoted-printable', 'base64']);
/** Parameters this analyzer "recognizes"; any other is ignored (kept, not fatal). */
const KNOWN_PARAMS = new Set(['charset', 'boundary']);

export interface ContentType {
  readonly type: string;
  readonly subtype: string;
  readonly params: ReadonlyMap<string, string>;
  /** Recognized-but-not-acted-on parameter names (ignored per R-2045-5-b). */
  readonly ignoredParams: readonly string[];
  /** False when the header was syntactically invalid and the default was substituted. */
  readonly valid: boolean;
}

export interface MimeInfo {
  /** The MIME-Version value, or null if the header was absent. */
  readonly mimeVersion: string | null;
  readonly contentType: ContentType;
  /** The transfer-encoding mechanism, lowercased. '7bit' when the header is absent. */
  readonly cte: string;
  readonly cteRecognized: boolean;
  /** True when an unrecognized CTE forces application/octet-stream treatment (R-2045-6-a). */
  readonly octetStreamTreatment: boolean;
  readonly anomalies: readonly string[];
}

export interface MimeDefects {
  /** Do not flag a missing MIME-Version. Violates R-2045-4-a. */
  readonly dontFlagMissingMimeVersion?: boolean;
  /** Preserve the case of type/subtype instead of lowercasing. Violates R-2045-5-a. */
  readonly caseSensitiveType?: boolean;
  /** Let an unrecognized parameter invalidate the Content-Type. Violates R-2045-5-b. */
  readonly failOnUnknownParam?: boolean;
  /** Do not substitute the text/plain default for a missing Content-Type. Violates R-2045-5.2-a. */
  readonly noDefaultContentType?: boolean;
  /** Treat an unrecognized CTE as decodable instead of octet-stream. Violates R-2045-6-a. */
  readonly acceptUnknownCte?: boolean;
  /** Do not flag a duplicate Content-Type. Undoes the ADR-0007 MIME-confusion cut. */
  readonly acceptDuplicateContentType?: boolean;
}

const DEFAULT_TYPE: ContentType = {
  type: 'text',
  subtype: 'plain',
  params: new Map([['charset', 'us-ascii']]),
  ignoredParams: [],
  valid: true,
};

/** All values of a header (case-insensitive name), as decoded ASCII, in order. */
function valuesOf(headers: readonly Header[], name: string): string[] {
  const lower = name.toLowerCase();
  const out: string[] = [];
  for (const h of headers) {
    if (h.name.toString('latin1').toLowerCase() === lower) out.push(h.value.toString('latin1').trim());
  }
  return out;
}

/** True if every octet is printable ASCII (0x20-0x7e) — a Content-* value should be. */
function isAsciiPrintable(headers: readonly Header[], name: string): boolean {
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toString('latin1').toLowerCase() !== lower) continue;
    for (const octet of h.value) if (octet < 0x20 || octet > 0x7e) return false;
  }
  return true;
}

function parseContentType(raw: string, defects: MimeDefects): ContentType {
  const parts = raw.split(';');
  const media = (parts[0] ?? '').trim();
  const slash = media.indexOf('/');
  if (slash <= 0 || slash === media.length - 1) {
    // Syntactically invalid: §5.2 recommends the text/plain default.
    return DEFAULT_TYPE;
  }
  let type = media.slice(0, slash).trim();
  let subtype = media.slice(slash + 1).trim();
  if (defects.caseSensitiveType !== true) {
    type = type.toLowerCase();
    subtype = subtype.toLowerCase();
  }

  const params = new Map<string, string>();
  const ignoredParams: string[] = [];
  let valid = true;
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const pname = p.slice(0, eq).trim().toLowerCase();
    if (pname === '') continue;
    let pval = p.slice(eq + 1).trim();
    if (pval.startsWith('"') && pval.endsWith('"') && pval.length >= 2) pval = pval.slice(1, -1);
    if (KNOWN_PARAMS.has(pname)) {
      params.set(pname, pval);
    } else {
      // R-2045-5-b: ignore unknown params (keep the media type). The defect lets
      // an unknown param invalidate the type instead.
      if (defects.failOnUnknownParam === true) valid = false;
      else ignoredParams.push(pname);
    }
  }
  if (!valid) return DEFAULT_TYPE;
  return { type, subtype, params, ignoredParams, valid: true };
}

export function analyzeMime(headers: readonly Header[], defects: MimeDefects = {}): MimeInfo {
  const anomalies: string[] = [];

  // MIME-Version (R-2045-4-a).
  const mimeVersions = valuesOf(headers, 'MIME-Version');
  const mimeVersion = mimeVersions[0] ?? null;
  if (mimeVersion === null && defects.dontFlagMissingMimeVersion !== true) {
    anomalies.push('missing-mime-version');
  } else if (mimeVersion !== null && mimeVersion !== '1.0') {
    anomalies.push('mime-version-not-1.0');
  }

  // Content-Type (R-2045-5-a/-b, R-2045-5.2-a) + the duplicate-Content-Type cut.
  const ctValues = valuesOf(headers, 'Content-Type');
  if (ctValues.length > 1 && defects.acceptDuplicateContentType !== true) {
    anomalies.push('duplicate-content-type');
  }
  let contentType: ContentType;
  if (ctValues.length === 0) {
    if (defects.noDefaultContentType === true) {
      contentType = { type: '', subtype: '', params: new Map(), ignoredParams: [], valid: false };
    } else {
      contentType = DEFAULT_TYPE; // §5.2 default
    }
  } else {
    if (!isAsciiPrintable(headers, 'Content-Type')) anomalies.push('eight-bit-content-type');
    contentType = parseContentType(ctValues[0]!, defects);
  }
  if (contentType.ignoredParams.length > 0) anomalies.push('ignored-unknown-param');

  // Content-Transfer-Encoding (R-2045-6-a). Absent = 7bit (the default).
  const cteValues = valuesOf(headers, 'Content-Transfer-Encoding');
  const cteRaw = (cteValues[0] ?? '7bit').toLowerCase();
  let cte = cteRaw;
  let cteRecognized = KNOWN_CTE.has(cteRaw);
  let octetStreamTreatment = false;
  if (!cteRecognized) {
    if (defects.acceptUnknownCte === true) {
      cteRecognized = true; // the defect pretends it understands the encoding
    } else {
      anomalies.push('unknown-cte');
      octetStreamTreatment = true; // treat body as opaque octets
      cte = cteRaw; // keep the raw label for evidence
    }
  }

  return { mimeVersion, contentType, cte, cteRecognized, octetStreamTreatment, anomalies };
}

/** True if `kind` is present in the analysis anomalies. */
export function hasMimeAnomaly(info: MimeInfo, kind: string): boolean {
  return info.anomalies.includes(kind);
}
