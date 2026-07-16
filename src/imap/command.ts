/**
 * A reference IMAP4rev2 client-command parser (RFC 9051 §2.2.1), with switchable
 * defects. The client→server counterpart of response.ts.
 *
 * Parses "tag SP command [SP args]" with the strict spacing IMAP requires, and
 * tracks tag reuse across a session (a server MUST accept it). Command semantics
 * and literals ({n} octet counts) are later increments; this establishes the
 * command-line framing a server dispatches on.
 */

export interface ImapCommand {
  readonly tag: string | null;
  readonly command: string | null; // uppercased
  readonly args: readonly string[];
  readonly valid: boolean;
  readonly anomalies: readonly string[];
}

export interface ImapCommandDefects {
  /** Tolerate leading/trailing/doubled spaces. Violates R-9051-2.2.1-a. */
  readonly acceptSloppySpacing?: boolean;
  /** Reject a reused tag (a server MUST accept it). Violates R-9051-2.2.1-b. */
  readonly rejectTagReuse?: boolean;
}

/**
 * Parse one command line. `seenTags`, if provided, accumulates tags across a
 * session so tag-reuse handling can be exercised.
 */
export function parseCommand(input: Buffer, defects: ImapCommandDefects = {}, seenTags?: Set<string>): ImapCommand {
  const line = input.toString('latin1').replace(/\r?\n$/, '');
  const anomalies: string[] = [];
  let valid = true;

  // Strict spacing (R-9051-2.2.1-a): no leading/trailing/doubled spaces.
  const sloppy = /^ | $|  /.test(line);
  if (sloppy && defects.acceptSloppySpacing !== true) {
    valid = false;
    anomalies.push('sloppy-spacing');
  }

  const cleaned = line.trim().split(/ +/).filter((t) => t.length > 0);
  const tag = cleaned[0] ?? null;
  const command = cleaned[1] ?? null;
  const args = cleaned.slice(2);

  if (tag === null) {
    valid = false;
    anomalies.push('missing-tag');
  } else if (tag === '*' || tag === '+') {
    valid = false;
    anomalies.push('invalid-tag'); // '*'/'+' are reserved for responses
  }
  if (command === null) {
    valid = false;
    anomalies.push('missing-command');
  }

  // Tag reuse (R-9051-2.2.1-b): a server MUST accept it; only the defect rejects.
  if (tag !== null && seenTags !== undefined) {
    if (seenTags.has(tag)) {
      anomalies.push('tag-reused');
      if (defects.rejectTagReuse === true) valid = false;
    }
    seenTags.add(tag);
  }

  return { tag, command: command === null ? null : command.toUpperCase(), args, valid, anomalies };
}

/** True if `kind` is present in the command anomalies. */
export function hasCommandAnomaly(cmd: ImapCommand, kind: string): boolean {
  return cmd.anomalies.includes(kind);
}
