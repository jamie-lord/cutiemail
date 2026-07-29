/**
 * A minimal, live IMAP4rev2 server — the read leg, assembled from the test bed.
 *
 * The command surface is driven by what REAL clients demand, each addition traced
 * to a captured conversation (MAIL_DEBUG) with Thunderbird 140 against the live
 * deployment:
 *
 *   - CAPABILITY / LIST / NAMESPACE / ID / LSUB and the UID variants of
 *     FETCH/STORE/SEARCH — the account-setup sequence (2026-07-16 probe).
 *   - RFC822.HEADER etc. — how TB builds its message list.
 *   - Multi-mailbox: TB's first act after setup is CREATE "Trash", and delete /
 *     sent-mail workflows need Trash and Sent with COPY/MOVE/APPEND (with
 *     literals) and STATUS. Served from a catalog of named mailboxes.
 *   - Partial fetch BODY.PEEK[TEXT]<0.2048> — TB's body preview sync.
 *
 * It takes either a single mailbox (wrapped as an INBOX-only catalog — the shape
 * most tests use) or a catalog (MemoryCatalog / SqliteCatalog) for real
 * multi-folder service. INTERNALDATE is stamped at receive time (and preserved
 * across APPEND/COPY), and the FAST/ALL/FULL fetch macros expand to include it.
 */

import net from 'node:net';
import tls from 'node:tls';
import { parseMessage } from '../message/parse.ts';
import { bodyResponse, bodyStructureResponse, resolvePart } from '../message/body-structure.ts';
import { buildEnvelope, serializeEnvelope } from '../imap/envelope.ts';
import { matchesSearch, type SearchableMessage, type SearchKey } from '../imap/search.ts';
import { parseSequenceSet } from '../imap/sequence-set.ts';
import { canonicalMailboxName, withinMailboxNameBounds } from '../store/mailbox-name.ts';
import { sanitizeForTerminalLine } from '../ops/terminal.ts';
import type { MessageMeta } from '../store/mailbox.ts';
import type { MailboxNotifier } from './mailbox-notifier.ts';
import type { AuthThrottle } from './auth-throttle.ts';

const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Render an epoch-millis value as an IMAP INTERNALDATE ("dd-Mon-yyyy HH:MM:SS +0000"), always UTC. */
function formatImapDateTime(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, ' '); // ABNF date-day-fixed: SP-padded to width 2
  return `${day}-${IMAP_MONTHS[d.getUTCMonth()]!}-${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
}

/** Parse an IMAP date-time ("17-Jul-2026 01:30:00 +0000") to epoch-millis, or null if malformed. */
function parseImapDateTime(s: string): number | null {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})\s*$/.exec(s);
  if (m === null) return null;
  const month = IMAP_MONTHS.findIndex((mon) => mon.toLowerCase() === m[2]!.toLowerCase());
  if (month === -1) return null;
  const zone = m[7]!;
  const offsetMin = (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  return Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offsetMin * 60_000;
}

export interface ServableMailbox {
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly highestModseq: number;
  /**
   * Ordered (mailbox / ascending-UID) metadata for every message, WITHOUT body bytes —
   * the cheap whole-mailbox view. Historically this was a `messages` getter that loaded
   * every raw BLOB (and ran a flag query per message) on every access, so even
   * `FETCH 1 (FLAGS)` cost O(total mailbox bytes) and, because node:sqlite is
   * synchronous, froze the event loop for its duration (docs/PERFORMANCE.md). index()
   * returns only metadata, turning those commands into bounded, sub-millisecond work.
   */
  index(): readonly MessageMeta[];
  /** One message's raw bytes by UID (undefined if absent) — fetched a single row at a time. */
  raw(uid: number): Buffer | undefined;
  /**
   * Run `fn` as one atomic batch: every append/storeFlags/expunge it makes on this mailbox
   * commits at a single fsync. Wrap a bulk STORE/COPY/EXPUNGE loop in this so it costs one
   * transaction, not one per message (docs/PERFORMANCE.md).
   */
  transaction<T>(fn: () => T): T;
  append(raw: Buffer, flags?: readonly string[], internalDate?: number): number;
  expunge(uid: number): void;
  storeFlags(uid: number, mode: 'add' | 'remove' | 'replace', flags: readonly string[]): void;
  expungeDeleted(): readonly number[];
  /** UIDs expunged after `modseq` (RFC 7162 QRESYNC), optionally restricted to a set. */
  expungedSince(modseq: number, restrictTo?: ReadonlySet<number>): number[];
}

/** A catalog of named mailboxes (MemoryCatalog / SqliteCatalog satisfy this). */
export interface ServableCatalog {
  listNames(): readonly string[];
  get(name: string): ServableMailbox | undefined;
  /** Create a mailbox; undefined if the name already exists. */
  create(name: string): ServableMailbox | undefined;
  /** Delete a mailbox and its messages. False if it is absent or is INBOX (RFC 9051 §6.3.4). */
  delete?(name: string): boolean;
  /** Rename a mailbox (RFC 9051 §6.3.5). 'notfound' if source absent, 'exists' if target taken. */
  rename?(from: string, to: string): 'ok' | 'notfound' | 'exists';
}

/** Wrap a bare mailbox as an INBOX-only catalog (the single-mailbox test shape). */
function inboxOnly(mailbox: ServableMailbox): ServableCatalog {
  return {
    listNames: () => ['INBOX'],
    get: (name) => (canonicalMailboxName(name) === 'INBOX' ? mailbox : undefined),
    create: () => undefined,
    delete: () => false,
    rename: () => 'notfound',
  };
}

// We advertise IMAP4rev1 *and* IMAP4rev2 (RFC 9051 §6.1.1 permits, and real rev2
// servers do, advertising both). The server always speaks rev2 — we do not build a
// separate rev1 downgrade mode; rev2 is a near-superset and modern clients (Apple
// Mail, Thunderbird) drive it fine without the rev1 atom. The atom is a compatibility
// SIGNAL for clients/tooling that gate connection on seeing "IMAP4rev1"/"IMAP4" in
// CAPABILITY (e.g. Python's imaplib refuses a server that lacks it outright). The rev1
// features rev2 removed — \Recent/RECENT, SEARCH RECENT/NEW/OLD — stay intentionally
// unimplemented (ADR 0007); no real client depends on them. See ADR 0007 for the record.
// LIST-STATUS (RFC 5819) is folded into IMAP4rev2's base LIST, but a client speaking rev1 only
// uses `LIST ... RETURN (STATUS ...)` if it sees the capability named — so it is advertised
// separately. Advertising it is the claim that it works; see the §6.3.9.5 handling in LIST.
const CAPABILITIES = 'IMAP4rev1 IMAP4rev2 IDLE UIDPLUS SPECIAL-USE LIST-STATUS CONDSTORE QRESYNC AUTH=PLAIN';

/** Commands allowed before authentication (RFC 9051 §3, Not Authenticated state). */
const PREAUTH_COMMANDS = new Set(['CAPABILITY', 'NOOP', 'LOGOUT', 'LOGIN', 'AUTHENTICATE', 'ID', 'STARTTLS']);

/** Cap on an APPEND literal's declared size (octets) — bounds server memory. */
const MAX_APPEND_LITERAL = 26_214_400; // 25 MiB default, matching the SMTP SIZE default

/**
 * Server-wide ceiling on APPEND-literal octets buffered across all connections. An APPEND uploads a
 * message as a literal, and the server buffers the whole thing in the connection's receive buffer
 * before it can store it. A client that declares a big literal then sends it slowly (or withholds
 * the terminating CRLF) pins ~its size in memory — and, summed across connections that each need
 * only ONE such APPEND (so MAX_CONNECTIONS doesn't help), that OOMs the process, the read-side twin
 * of the FETCH slow-consumer OOM (docs/PERFORMANCE.md). Since a literal's size is DECLARED up front,
 * we bound it cleanly: a new APPEND is refused (transient NO) once accepting it would push the total
 * reserved over this budget, so at most ~budget/25 MB uploads are ever in flight. Generous vs any
 * personal-scale concurrent upload, tiny vs modern RAM.
 */
const MAX_APPEND_INFLIGHT = 268_435_456; // 256 MiB
/**
 * How many accounts the in-flight APPEND budget is divided between.
 *
 * The budget exists to bound memory, but a single global counter is also a lock: reservations are
 * charged on the size the client DECLARES, before any of the literal arrives, so one account can
 * pin the lot and deny APPEND to everyone else while sending nothing. Slicing it costs a heavy
 * single user some concurrency and removes the cross-account lever. The floor of one maximal
 * literal (see #reserveAppend) keeps a normal upload working regardless of this number.
 */
const APPEND_ACCOUNT_SHARES = 8;
/**
 * Protocol-error limits, mirroring MAX_HARD_ERRORS in smtp-receiver.ts. Pre-auth is tighter
 * because an unauthenticated peer has no legitimate reason to issue unknown commands, and it is
 * the pre-auth case that lets an anonymous peer occupy connection slots.
 */
const MAX_BAD_COMMANDS_PREAUTH = 3;
const MAX_BAD_COMMANDS = 20;

/**
 * Is `s` a well-formed base64 SASL response (RFC 9051 §6.2.2, RFC 4648 §4)?
 *
 * §6.2.2 names two ways it can be malformed — "characters outside the base64 alphabet or
 * non-terminal '='" — and requires a tagged BAD for either. This has to be checked explicitly
 * because `Buffer.from(s, 'base64')` does not: Node's decoder SKIPS anything outside the alphabet
 * and stops at the first '=', so `!!!not base64!!!` decodes cheerfully to a short buffer that then
 * fails the credential check and draws NO. The client is told its password was rejected when what
 * is actually broken is its own encoder, and it goes back to the user for a password that was
 * never wrong.
 *
 * The length rule is the same insistence in a different form: base64 encodes three octets into
 * four characters, so a string whose length is not a multiple of four is truncated, and a
 * truncated credential is not a wrong credential.
 */
function isValidBase64(s: string): boolean {
  if (s.length % 4 !== 0) return false;
  const body = s.replace(/={1,2}$/, ''); // at most two '=' and only at the very end
  return !body.includes('=') && /^[A-Za-z0-9+/]*$/.test(body);
}

/** Inactivity autologout (RFC 9051 §5.4 requires a timer of at least 30 minutes). */
const AUTOLOGOUT_MS = 1_800_000;
/**
 * How often to re-examine live sessions for a disabled account or a rotated credential.
 *
 * Deliberately far shorter than the autologout: an operator responding to a compromise expects
 * `account disable` to take effect in seconds, and the sessions that most need cutting are the
 * ones that will never send another command to be checked against.
 */
const REVOCATION_SWEEP_MS = 15_000;
const MAX_SEARCH_KEYS = 64; // top-level SEARCH keys; a real query uses a handful (DoS bound)
const MAX_SEARCH_NODES = 256; // TOTAL keys across the tree incl. nested OR/NOT (recursion DoS bound)
/**
 * Distinct BODY[...] sections one FETCH may name. A real client asks for a handful; the cap is
 * the second half of the de-duplication in `parseFetchAtts`, since 32 DISTINCT sections of a
 * 25 MiB message is still a 800 MiB response built as one contiguous buffer.
 */
const MAX_BODY_SECTIONS = 32;
const MAX_CONNECTIONS = 512; // concurrent-connection ceiling per listener (pre-auth DoS bound)
const HANDSHAKE_TIMEOUT_MS = 10_000; // IMAPS TLS-handshake deadline (handshake-slowloris bound)

/**
 * Server-wide ceiling on bytes queued for slow-reading clients. The server frames a whole FETCH
 * response and hands it to the socket; a client that stops reading — deliberately, or on a slow
 * link — leaves that response buffered in memory with no OS/Node bound. Summed across connections
 * this is an OOM: ~112 connections each stalling on a 25 MB body killed a 3.7 GB box (an
 * authenticated read-slowloris — docs/PERFORMANCE.md). MAX_CONNECTIONS (512) does not help, since
 * each connection needs only one big fetch. When the total queued across ALL connections exceeds
 * this budget, the slowest-draining connections are dropped until back under it — a client reading
 * promptly holds ~0 and is never chosen, so normal use is untouched. Sized to hold a healthy burst
 * of concurrent large fetches while bounding total write memory far below any modern server's RAM.
 */
const MAX_WRITE_BACKLOG = 256 * 1024 * 1024; // 256 MiB

/** A socket enough of, for the slow-consumer guard: how much it has buffered, and how to drop it. */
export interface Sheddable {
  readonly writableLength: number;
  destroy(): void;
}

/**
 * Enforce the slow-consumer write-backlog budget. If the summed `writableLength` across `sockets`
 * exceeds `budget`, destroy the biggest-backlog sockets (the slowest-draining consumers) until the
 * total is back under it, and return how many were dropped. A promptly-reading client has
 * `writableLength` ~0, so it sorts last and is never chosen — the guard only ever sheds connections
 * that are failing to consume their data. Pure and deterministic, so it can be tested without
 * depending on real kernel socket buffering (which varies by platform).
 */
export function shedToBudget(sockets: Iterable<Sheddable>, budget: number, exempt?: Sheddable): number {
  const all = [...sockets];
  let total = 0;
  for (const s of all) total += s.writableLength;
  if (total <= budget) return 0;
  let shed = 0;
  // Never shed `exempt` — the socket whose own write just triggered this check. Its
  // writableLength is sampled synchronously, before the kernel has drained a single byte, so it
  // sits at the full pre-drain size of a response it is about to consume normally, which by size
  // alone is indistinguishable from a stalled backlog. Dropping it would let an attacker holding
  // many modest, genuinely-stalled sockets (each kept below the victim's transient peak) push a
  // promptly-reading victim's own FETCH over budget and get the VICTIM destroyed while the abuser
  // survives — cross-tenant, since one listener serves every account. `exempt` still
  // counts toward `total`, so we shed the genuinely-accumulated backlog of OTHERS until under it.
  const candidates = all.filter((s) => s !== exempt).sort((a, b) => b.writableLength - a.writableLength);
  for (const s of candidates) {
    if (total <= budget) break;
    total -= s.writableLength;
    s.destroy(); // a client not draining won't receive a BYE anyway — just reclaim the memory
    shed++;
  }
  return shed;
}

/** Special-use attributes by conventional folder name (RFC 6154 / 9051 §7.3.1). */
// Null-prototype: this table is indexed by a mailbox name the client chose, and CREATE only
// forbids INBOX and non-NFC names. With Object.prototype in the chain, `CREATE constructor` made
// the lookup return a function, whose stringification carries parentheses that terminate the LIST
// attribute list early for a non-counting parser — and made the mailbox pass the (SPECIAL-USE)
// filter, which is supposed to mean "has a special-use attribute".
const SPECIAL_USE: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  Trash: '\\Trash',
  Sent: '\\Sent',
  Drafts: '\\Drafts',
  Junk: '\\Junk',
  Archive: '\\Archive',
});

/**
 * Redact credentials from an IMAP command line for debug logging. Covers BOTH auth forms:
 * `tag LOGIN user pass` (password), `tag AUTHENTICATE PLAIN <base64>` (the inline SASL
 * initial response), and — when `isSaslContinuation` is set — a standalone base64 line that
 * is the response to an `AUTHENTICATE` continuation (it decodes to \0user\0password).
 * Missing the AUTHENTICATE forms wrote recoverable passwords to the log despite the
 * "credentials redacted" contract. Exported for its unit test.
 */
export function redactImapDebugLine(line: string, isSaslContinuation: boolean): string {
  if (isSaslContinuation) return '<SASL response redacted>';
  return sanitizeForTerminalLine(
    line
      // Redact the ARGUMENT, not one whitespace-delimited token. The LOGIN handler is
      // deliberately quote-aware — a passphrase may be a quoted string containing spaces — and
      // this was not, so `LOGIN "alice" "correct horse battery staple"` logged everything after
      // the first word of a credential that had just SUCCEEDED. Deliberately not `$`-anchored:
      // `LOGIN bob s3cr3t ` (trailing space) is a successful login here, and an anchored
      // pattern would stop matching and leak the whole password.
      .replace(/^(\S+\s+LOGIN\s+(?:"(?:[^"\\]|\\.)*"|\S+)\s+)(?:"(?:[^"\\]|\\.)*"|\S+).*/i, '$1***')
      .replace(/^(\S+\s+AUTHENTICATE\s+\S+\s+).*/i, '$1***'),
  );
}

/** MAIL_DEBUG=1 logs each received command line (credentials redacted) to stderr. */
const DEBUG = process.env.MAIL_DEBUG === '1';
function debugLog(line: string, isSaslContinuation = false): void {
  if (!DEBUG) return;
  process.stderr.write(`[imap<] ${redactImapDebugLine(line, isSaslContinuation)}\n`);
}

/**
 * How long a client gets to consume the shutdown BYE and close before its socket is reclaimed.
 * Long enough for a loopback or LAN round trip, short enough that one unresponsive session cannot
 * stall a restart.
 */
const BYE_GRACE_MS = 500;

const write = (sock: net.Socket, line: string): void => {
  sock.write(Buffer.from(`${line}\r\n`, 'latin1'));
};

const unquote = (s: string): string => s.replace(/^"|"$/g, '');

/**
 * Serialise a mailbox name to the wire as an astring (RFC 9051 §4.3). A bare `name.includes(' ')
 * ? '"'+name+'"' : name` test both fails to escape a `"`/`\` inside the name (an embedded quote
 * closes the quoted-string early and desyncs a strict client's LIST/STATUS parse) and emits a
 * raw atom for a name with a non-space special. Quote and escape `\`/`"`; a control octet forces
 * a literal — the same discipline envelope.imapString / body-structure.qstr already apply
 * (mailbox names are owner-created, so this is an interop-correctness fix, not a
 * cross-trust-boundary bypass).
 *
 * ENCODING DECISION (RFC 9051 §5.1). rev2 mailbox names are Net-Unicode (UTF-8) on the wire, and
 * rev2 REMOVED the rev1 modified-UTF-7 encoding. cutiemail is byte-transparent: a name is the exact
 * octet sequence the client sent (the whole server reads/writes latin1, so one JS char == one wire
 * byte, and `name.length` is the true octet count for the literal header). A UTF-8 name round-trips
 * verbatim through CREATE/LIST/SELECT/STATUS; an octet outside atom/quoted-string range forces a
 * literal so the bytes are preserved exactly. We NEVER interpret modified-UTF-7: an mUTF-7-shaped
 * name like `Fo&AOk-o` is stored and returned as those literal ASCII bytes, not decoded to `Foéo`.
 * This is the deliberate rev2 position; a legacy client still speaking mUTF-7 gets its own bytes
 * back, which is self-consistent for that client.
 */
/**
 * Is an 8-bit mailbox name Net-Unicode (RFC 5198), i.e. valid UTF-8 already in NFC? RFC 9051 §5.1
 * makes prohibiting anything else a MUST. `name` is latin1 octets off the wire, so decode first.
 * A 7-bit name is trivially conformant. Invalid UTF-8 is rejected too: it decodes to U+FFFD, which
 * would not survive a round trip through any normalising client.
 */
function isNetUnicode(name: string): boolean {
  const octets = Buffer.from(name, 'latin1');
  if (!octets.some((b) => b >= 0x80)) return true;
  const decoded = octets.toString('utf8');
  return decoded === decoded.normalize('NFC') && Buffer.from(decoded, 'utf8').equals(octets);
}

function imapMailboxAstring(name: string): string {
  // A control octet OR an 8-bit byte can appear in neither an atom nor a quoted-string (both are
  // 7-bit) → emit a literal. The declared length must be the octet count ACTUALLY written:
  // write() serialises with latin1 (one byte per JS char), so it is name.length — NOT
  // Buffer.byteLength(name,'utf8'), which over-counts an 8-bit char and desyncs the client.
  if (/[^\x20-\x7e]/.test(name)) return `{${name.length}}\r\n${name}`;
  // A valid atom (RFC 9051 ABNF: printable ASCII, none of the atom-specials SP ( ) { % * " \ ])
  // goes bare — the common case (Work, Sent, INBOX) is unchanged, so simple names stay readable.
  if (name.length > 0 && !/[ "%()*\]\\{]/.test(name)) return name;
  // Otherwise a quoted-string with the quoted-specials (" and \) escaped.
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Tokenise an IMAP argument string, keeping a "quoted string" (which may contain
 * spaces) as ONE token — so SEARCH SUBJECT "annual report" searches for the whole
 * phrase, not just "annual". A plain split(' ') breaks quoted multi-word values.
 */
function imapTokens(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  for (;;) {
    const t = scanToken(s, i);
    if (t === null) return tokens;
    tokens.push(t.value);
    i = t.end;
  }
}

/**
 * Read one space-separated token from `s` at or after `i`, honouring double-quoted strings with
 * backslash escapes, and report where it ended.
 *
 * The incremental form of imapTokens, which is built on it. Commands whose arguments are POSITIONAL
 * can work from the token array; LIST cannot, because its optional leading selection group and
 * trailing RETURN group both shift the positions, and both may contain spaces. Parsing those needs
 * to know where in the ORIGINAL string each token ended, so the parenthesised group can be scanned
 * with its own balanced-paren rules rather than being split on spaces like everything else.
 */
function scanToken(s: string, from: number): { value: string; end: number } | null {
  let i = from;
  while (i < s.length && s[i] === ' ') i += 1;
  if (i >= s.length) return null;
  if (s[i] !== '"') {
    let j = i;
    while (j < s.length && s[j] !== ' ') j += 1;
    return { value: s.slice(i, j), end: j };
  }
  let value = '';
  i += 1;
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && i + 1 < s.length) {
      value += s[i + 1];
      i += 2;
    } else {
      value += s[i];
      i += 1;
    }
  }
  return { value, end: i + 1 }; // past the closing quote
}

/** The "(...)" group starting at `start`, with its contents and end offset. Nesting is tracked. */
function balancedGroup(s: string, start: number): { inner: string; end: number } | null {
  if (s[start] !== '(') return null;
  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') {
      depth -= 1;
      if (depth === 0) return { inner: s.slice(start + 1, i), end: i + 1 };
    }
  }
  return null; // unbalanced
}

/** One RETURN option: a name, plus the "(...)" arguments only STATUS carries. */
interface ListReturnOption {
  readonly name: string;
  readonly args: readonly string[];
}

interface ParsedList {
  readonly selection: readonly string[];
  readonly ret: readonly ListReturnOption[];
  readonly reference: string;
  readonly pattern: string;
}

/**
 * Parse the extended LIST argument list (RFC 9051 §6.3.9):
 *   [ (selection-options) ] reference mailbox-pattern [ RETURN (return-options) ]
 *
 * Returns null when the line does not fit that shape, which is a tagged BAD.
 *
 * Both option groups have to be scanned as balanced groups rather than picked out of a
 * space-split token array. The previous positional parse read the selection group as ONE token,
 * so it worked for `LIST (SUBSCRIBED) "" *` and quietly fell apart on `LIST (SUBSCRIBED
 * RECURSIVEMATCH) "" *`, where "RECURSIVEMATCH)" became the mailbox pattern and the command
 * matched nothing. Recognising an option we do not implement — the point of this change — is
 * impossible without first knowing reliably which tokens ARE the options.
 *
 * The RETURN keyword is only taken as such AFTER the reference and pattern have been read, so a
 * mailbox literally named "RETURN" still lists.
 */
function parseListCommand(rest: string): ParsedList | null {
  let i = 0;
  let selection: readonly string[] = [];
  if (rest.startsWith('(')) {
    const group = balancedGroup(rest, 0);
    if (group === null) return null;
    selection = group.inner.split(/\s+/).filter((o) => o.length > 0).map((o) => o.toUpperCase());
    i = group.end;
  }
  const referenceToken = scanToken(rest, i);
  if (referenceToken === null) return null;
  const patternToken = scanToken(rest, referenceToken.end);
  const reference = referenceToken.value;
  const pattern = patternToken?.value ?? '';

  const ret: ListReturnOption[] = [];
  const after = patternToken === null ? null : scanToken(rest, patternToken.end);
  if (after !== null) {
    if (after.value.toUpperCase() !== 'RETURN') return null; // trailing junk is a syntax error
    let j = after.end;
    while (j < rest.length && rest[j] === ' ') j += 1;
    const group = balancedGroup(rest, j);
    if (group === null) return null;
    if (rest.slice(group.end).trim() !== '') return null;
    // Each option is a name optionally followed by its own "(...)" arguments — only STATUS has
    // any. Scanned the same way, so `RETURN (STATUS (MESSAGES UNSEEN) CHILDREN)` reads as two
    // options rather than as four unrecognised words.
    let k = 0;
    for (;;) {
      const nameToken = scanToken(group.inner, k);
      if (nameToken === null) break;
      const name = nameToken.value.toUpperCase();
      let args: readonly string[] = [];
      k = nameToken.end;
      while (k < group.inner.length && group.inner[k] === ' ') k += 1;
      if (group.inner[k] === '(') {
        const argGroup = balancedGroup(group.inner, k);
        if (argGroup === null) return null;
        args = argGroup.inner.split(/\s+/).filter((a) => a.length > 0).map((a) => a.toUpperCase());
        k = argGroup.end;
      }
      ret.push({ name, args });
    }
  }
  return { selection, ret, reference, pattern };
}

/**
 * The LIST options this server recognises (RFC 9051 §6.3.9.1/§6.3.9.5, plus RFC 6154 SPECIAL-USE).
 *
 * §6.3.9 requires a BAD for anything else — "a client MUST NOT send an option for which the server
 * has not advertised support. A server MUST respond to options it does not recognize with a BAD
 * response" — and the same paragraph requires the options defined in the document to be supported,
 * which is why the set is not simply "the ones we act on".
 *
 * REMOTE and RECURSIVEMATCH are recognised and are no-ops HERE, which is their correct behaviour
 * rather than a shortcut. REMOTE asks for remote mailboxes and there are none: one server, one
 * personal namespace (see the NAMESPACE response). RECURSIVEMATCH asks for CHILDINFO on mailboxes
 * that do not match the selection criteria but whose children do — and since subscription is not
 * tracked, every mailbox is subscribed, so no parent can fail a criterion its child meets. The day
 * subscription state becomes real, this stops being a no-op; the comment is the marker.
 */
const LIST_SELECTION_OPTIONS = new Set(['SUBSCRIBED', 'REMOTE', 'RECURSIVEMATCH', 'SPECIAL-USE']);
const LIST_RETURN_OPTIONS = new Set(['SUBSCRIBED', 'CHILDREN', 'STATUS', 'SPECIAL-USE']);

/**
 * The `(MESSAGES n UIDNEXT n ...)` item list for a STATUS response (RFC 9051 §6.3.11, §7.3.2).
 *
 * Shared by the STATUS command and by LIST's RETURN (STATUS ...) option, which §6.3.9.5 defines as
 * returning "the same untagged STATUS response" — so the two must be the same bytes for the same
 * mailbox, and the way to guarantee that is for them to be the same code.
 */
function statusItems(box: ServableMailbox, wanted: readonly string[]): string[] {
  const items: string[] = [];
  // DE-DUPLICATED, and this is load-bearing rather than tidy. RFC 9051's ABNF for the request
  // (`status-att *(SP status-att)`, §9) puts no uniqueness constraint on the list, so a repeat is
  // legal and cannot be answered BAD — and each of UNSEEN, SIZE and DELETED costs a full pass over
  // the mailbox. LIST … RETURN (STATUS …) then calls this once per matched mailbox, so the work is
  // mailboxes × items × messages with all three chosen by the client: one 64 KiB line of repeated
  // UNSEEN froze the whole event loop, and Node being single-threaded that is every account's IMAP
  // session plus inbound SMTP plus the relay loop, not just the caller's. §6.3.9.5 only requires
  // the response to carry the requested information, which a repeat does not add to.
  const items_ = [...new Set(wanted)];
  // One metadata snapshot (no BLOBs) answers every counted item, including SIZE (from meta.size,
  // not the body). Read only if a count is actually requested.
  const idx = items_.some((w) => w === 'MESSAGES' || w === 'UNSEEN' || w === 'SIZE' || w === 'DELETED') ? box.index() : [];
  for (const w of items_) {
    if (w === 'MESSAGES') items.push(`MESSAGES ${idx.length}`);
    else if (w === 'UIDNEXT') items.push(`UIDNEXT ${box.uidNext}`);
    else if (w === 'UIDVALIDITY') items.push(`UIDVALIDITY ${box.uidValidity}`);
    else if (w === 'UNSEEN') items.push(`UNSEEN ${idx.filter((m) => !m.flags.has('\\Seen')).length}`);
    else if (w === 'SIZE') items.push(`SIZE ${idx.reduce((n, m) => n + m.size, 0)}`);
    else if (w === 'DELETED') items.push(`DELETED ${idx.filter((m) => m.flags.has('\\Deleted')).length}`);
    else if (w === 'HIGHESTMODSEQ') items.push(`HIGHESTMODSEQ ${box.highestModseq}`); // RFC 7162 §3.1.2.1
    else if (w === 'RECENT') items.push('RECENT 0');
  }
  return items;
}

/** A date-only IMAP search date ("1-Jan-2025") to the UTC-day epoch-millis, or null. */
function parseImapDate(s: string): number | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m === null) return null;
  const month = IMAP_MONTHS.findIndex((mon) => mon.toLowerCase() === m[2]!.toLowerCase());
  return month === -1 ? null : Date.UTC(Number(m[3]), month, Number(m[1]));
}

interface SearchContext {
  readonly largestUid: number;
  readonly count: number;
}

/**
 * A syntactically valid sequence-set (RFC 9051 §9 `sequence-set`): comma-separated items, each a
 * number/`*` or a `num:num` range. A command whose set does not match this must be answered BAD
 * rather than silently resolving to the empty set and returning a no-op OK (a lie: the client asked
 * to address messages and got neither data nor an error). `$` (SEARCHRES) is handled separately.
 */
const SEQ_ITEM = String.raw`(\d+|\*)(:(\d+|\*))?`;
const SEQUENCE_SET_RE = new RegExp(`^${SEQ_ITEM}(,${SEQ_ITEM})*$`);
function isSequenceSet(s: string): boolean {
  return SEQUENCE_SET_RE.test(s);
}

/** Compress a sorted ascending list of numbers to an IMAP sequence-set: "1,3:5,8". */
function compressSequenceSet(nums: readonly number[]): string {
  const ranges: string[] = [];
  let start = nums[0]!;
  let prev = start;
  for (let i = 1; i < nums.length; i++) {
    const n = nums[i]!;
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}:${prev}`);
    start = n;
    prev = n;
  }
  ranges.push(start === prev ? `${start}` : `${start}:${prev}`);
  return ranges.join(',');
}

/**
 * Parse SEARCH criteria into a key tree, returning null on any unsupported or
 * malformed key. Returning null (→ the caller answers BAD) is the whole point:
 * silently dropping an unknown key produces WRONG results — "NOT SEEN" with NOT
 * dropped returns the seen messages, the exact inverse. A bare token that is a
 * sequence-set is a message-set key; anything else unrecognised is rejected.
 */
function parseSearchKeys(tokens: readonly string[], ctx: SearchContext): SearchKey[] | null {
  let i = 0;
  // An optional leading "CHARSET <name>" (RFC 9051 §6.4.4). We treat content as
  // bytes, so any charset is accepted and ignored.
  if ((tokens[0] ?? '').toUpperCase() === 'CHARSET') i = 2;

  const flag = (f: string, present: boolean): SearchKey => ({ type: 'flag', flag: f, present });
  // Total parsed nodes across the WHOLE key tree, incremented on every (recursive) parseOne.
  // The top-level MAX_SEARCH_KEYS cap alone is bypassable: OR/NOT recurse and push nothing onto
  // keys[], so a deeply nested `OR TEXT a (OR TEXT b (...))` is a single top-level key with
  // thousands of TEXT leaves — the same O(keys×messages×size) freeze the cap was meant to stop.
  // Bound the total node count too.
  let nodeCount = 0;
  const parseOne = (): SearchKey | null => {
    if (++nodeCount > MAX_SEARCH_NODES) return null;
    const raw = tokens[i++];
    if (raw === undefined) return null;
    const k = raw.toUpperCase();
    switch (k) {
      case 'ALL':
        return { type: 'all' };
      case 'ANSWERED':
        return flag('\\Answered', true);
      case 'UNANSWERED':
        return flag('\\Answered', false);
      case 'DELETED':
        return flag('\\Deleted', true);
      case 'UNDELETED':
        return flag('\\Deleted', false);
      case 'DRAFT':
        return flag('\\Draft', true);
      case 'UNDRAFT':
        return flag('\\Draft', false);
      case 'FLAGGED':
        return flag('\\Flagged', true);
      case 'UNFLAGGED':
        return flag('\\Flagged', false);
      case 'SEEN':
        return flag('\\Seen', true);
      case 'UNSEEN':
        return flag('\\Seen', false);
      case 'KEYWORD':
      case 'UNKEYWORD': {
        const f = tokens[i++];
        return f === undefined ? null : flag(f, k === 'KEYWORD');
      }
      case 'FROM':
      case 'TO':
      case 'CC':
      case 'BCC':
      case 'SUBJECT': {
        const v = tokens[i++];
        return v === undefined ? null : { type: 'header', name: k.toLowerCase(), value: v };
      }
      case 'HEADER': {
        const name = tokens[i++];
        const v = tokens[i++];
        return name === undefined || v === undefined ? null : { type: 'header', name, value: v };
      }
      case 'BODY': {
        const v = tokens[i++];
        return v === undefined ? null : { type: 'body', value: v };
      }
      case 'TEXT': {
        const v = tokens[i++];
        return v === undefined ? null : { type: 'text', value: v };
      }
      case 'SINCE':
      case 'BEFORE':
      case 'ON': {
        const d = parseImapDate(tokens[i++] ?? '');
        return d === null ? null : { type: 'date', field: 'internal', op: k.toLowerCase() as 'since' | 'before' | 'on', day: d };
      }
      case 'SENTSINCE':
      case 'SENTBEFORE':
      case 'SENTON': {
        const d = parseImapDate(tokens[i++] ?? '');
        const op = k === 'SENTSINCE' ? 'since' : k === 'SENTBEFORE' ? 'before' : 'on';
        return d === null ? null : { type: 'date', field: 'sent', op, day: d };
      }
      case 'LARGER':
      case 'SMALLER': {
        const n = Number(tokens[i++]);
        return Number.isFinite(n) ? { type: 'size', op: k === 'LARGER' ? 'larger' : 'smaller', value: n } : null;
      }
      case 'NOT': {
        const sub = parseOne();
        return sub === null ? null : { type: 'not', key: sub };
      }
      case 'OR': {
        const a = parseOne();
        const b = parseOne();
        return a === null || b === null ? null : { type: 'or', a, b };
      }
      case 'UID': {
        const set = tokens[i++];
        return set === undefined ? null : { type: 'uid', uids: new Set(parseSequenceSet(set, ctx.largestUid)) };
      }
      case 'MODSEQ': {
        // RFC 7162 §3.1.5: MODSEQ [<entry-name> <entry-type>] <modseq>. We match on the
        // message mod-sequence and skip the optional per-flag entry-name/type (a
        // quoted "/flags/..." plus all|priv|shared) that clients almost never send.
        let val = tokens[i++];
        if (val !== undefined && !Number.isFinite(Number(val))) {
          i++; // entry-type (all|priv|shared)
          val = tokens[i++]; // the actual mod-sequence
        }
        const n = Number(val);
        return Number.isFinite(n) ? { type: 'modseq', value: n } : null;
      }
      default:
        // A bare sequence-set is a message-set key (e.g. "1,3:5" or "1:*").
        if (/^(\d+|\*)([,:](\d+|\*))*$/.test(raw)) return { type: 'seq', seqs: new Set(parseSequenceSet(raw, ctx.count)) };
        return null; // unknown / unsupported key — reject, never silently drop
    }
  };

  const keys: SearchKey[] = [];
  while (i < tokens.length) {
    // Cap the number of top-level keys: a legitimate SEARCH uses a handful, but an
    // authenticated client could send thousands of `TEXT x` keys, each scanning every message —
    // O(keys × messages × size) work that freezes the single-threaded server for all accounts.
    // 64 is far above any real query; beyond it, reject.
    if (keys.length >= MAX_SEARCH_KEYS) return null;
    const key = parseOne();
    if (key === null) return null;
    keys.push(key);
  }
  return keys;
}

/**
 * System flags (RFC 9051 §2.3.2) are case-insensitive: a client's `\deleted` is the
 * same flag as `\Deleted`. Canonicalise so stored flags match the capitalised forms
 * that EXPUNGE (`\Deleted`), the \Seen fetch side-effect, SEARCH, and PERMANENTFLAGS
 * all use — otherwise a lowercase `\deleted` would be stored verbatim and never
 * expunged. Keywords (no leading backslash) are case-sensitive and left as-is.
 */
const SYSTEM_FLAG_CANON = new Map<string, string>([
  ['\\seen', '\\Seen'],
  ['\\answered', '\\Answered'],
  ['\\flagged', '\\Flagged'],
  ['\\deleted', '\\Deleted'],
  ['\\draft', '\\Draft'],
  ['\\recent', '\\Recent'],
]);
function canonicalFlag(f: string): string {
  return SYSTEM_FLAG_CANON.get(f.toLowerCase()) ?? f;
}

/**
 * Which catalog names a LIST/LSUB reference+pattern matches, per the IMAP wildcard
 * rules (RFC 9051 §6.3.9). The reference and pattern are concatenated; then `*`
 * matches any run of characters INCLUDING the hierarchy separator, `%` matches any
 * run NOT crossing the separator (so it stays within one level), and every other
 * character is a literal. The old implementation only handled a bare `*`/`%` and
 * treated everything else as an exact name — so `INBOX/%`, `qbox*`, and every other
 * real pattern a client uses to walk the hierarchy matched nothing.
 */
/** Product of |pattern|×|name| below which the exact DP runs. Real patterns/names are tens of
 *  chars (product < 10k); the fallback only engages for a hostile huge pattern×name. */
const LIST_DP_BUDGET = 262_144;

/**
 * Exact IMAP LIST match by bottom-up dynamic programming — correct for any mix of `*`, `%`, and
 * literals. O(|pattern|×|name|) time, O(|name|) space, no backtracking (so no ReDoS, unlike the
 * original regex the ReDoS fix removed). `*` matches any run including '/'; `%` matches any run
 * not crossing '/'. Gated by LIST_DP_BUDGET so a hostile huge pattern×name can't make it costly.
 */
function matchGlobExact(pat: string, name: string): boolean {
  const n = name.length;
  let prev = new Array<boolean>(n + 1).fill(false);
  prev[0] = true; // empty pattern matches empty name prefix
  for (let ip = 1; ip <= pat.length; ip++) {
    const c = pat[ip - 1]!;
    const cur = new Array<boolean>(n + 1).fill(false);
    if (c === '*' || c === '%') {
      cur[0] = prev[0]!; // a wildcard can match the empty run
      for (let j = 1; j <= n; j++) cur[j] = prev[j]! || (cur[j - 1]! && (c === '*' || name[j - 1] !== '/'));
    } else {
      for (let j = 1; j <= n; j++) cur[j] = prev[j - 1]! && c === name[j - 1];
    }
    prev = cur;
  }
  return prev[n]!;
}

/**
 * Linear fallback for pathological |pattern|×|name| (over LIST_DP_BUDGET): a two-pointer glob with
 * adjacent wildcard runs collapsed (any run containing `*` → `*`, since `*` dominates `%`). It is
 * ReDoS-free and fails CLOSED — it may under-match an exotic `*`…literal…`%` pattern that crosses
 * '/', so a client sees fewer of its OWN mailboxes; it never over-matches, so it can never list
 * another account's mail. Only reachable for absurdly large inputs the exact DP declines.
 */
function matchGlobLinear(pat: string, name: string): boolean {
  let collapsed = '';
  for (let k = 0; k < pat.length; ) {
    const ch = pat[k]!;
    if (ch === '*' || ch === '%') {
      let star = false;
      while (k < pat.length && (pat[k] === '*' || pat[k] === '%')) star ||= pat[k++] === '*';
      collapsed += star ? '*' : '%';
    } else collapsed += pat[k++];
  }
  let i = 0;
  let j = 0;
  let iStar = -1;
  let jStar = -1;
  let pctStar = false;
  while (i < name.length) {
    const pc = collapsed[j];
    if (j < collapsed.length && (pc === '*' || pc === '%')) {
      iStar = i;
      jStar = j;
      pctStar = pc === '%';
      j++;
    } else if (j < collapsed.length && pc === name[i]) {
      i++;
      j++;
    } else if (iStar >= 0 && (!pctStar || name[iStar] !== '/')) {
      i = ++iStar;
      j = jStar + 1;
    } else {
      return false;
    }
  }
  while (j < collapsed.length && (collapsed[j] === '*' || collapsed[j] === '%')) j++;
  return j === collapsed.length;
}

/**
 * Match one mailbox name against an IMAP LIST pattern. `*` matches any run including the '/'
 * hierarchy separator; `%` matches any run NOT crossing '/'; every other character is a literal.
 * Exact (DP) for realistic sizes; a bounded linear fallback for hostile huge inputs. This replaced
 * the original regex compile (`[^/]*[^/]*…`), whose V8 backtracking was a catastrophic ReDoS —
 * both the pattern (off the wire) and the name (via CREATE) are attacker-controlled, so a single
 * authenticated `LIST "" %%%%%%%%%%%%b` against a long mailbox froze the whole event loop.
 */
function matchesListPattern(pat: string, name: string): boolean {
  return pat.length * name.length <= LIST_DP_BUDGET ? matchGlobExact(pat, name) : matchGlobLinear(pat, name);
}

function matchNames(reference: string, pattern: string, names: readonly string[]): readonly string[] {
  const pat = unquote(reference) + unquote(pattern);
  return names.filter((n) => matchesListPattern(pat, n));
}

/**
 * The LIST attribute list for a mailbox name: special-use where conventional, and
 * \HasChildren / \HasNoChildren (RFC 9051 §7.3.1) computed from whether any other
 * name sits under it — so a client shows an expand affordance for a parent folder.
 */
function listAttributes(name: string, allNames: readonly string[]): string {
  const use = SPECIAL_USE[name];
  const child = allNames.some((n) => n.startsWith(`${name}/`)) ? '\\HasChildren' : '\\HasNoChildren';
  return use === undefined ? `(${child})` : `(${child} ${use})`;
}

interface FetchAtts {
  uid: boolean;
  flags: boolean;
  size: boolean;
  envelope: boolean;
  /** RFC822 / RFC822.HEADER / RFC822.TEXT — the legacy fetch items real clients still use. */
  rfc822: boolean;
  rfc822Header: boolean;
  rfc822Text: boolean;
  internalDate: boolean;
  /** Bare BODY (non-extensible MIME structure) / BODYSTRUCTURE (extensible). */
  body: boolean;
  bodyStructure: boolean;
  /** MODSEQ (RFC 7162) — the per-message mod-sequence. */
  modseq: boolean;
  bodySections: { section: string; partial?: { origin: number; count: number }; peek: boolean }[];
}

/**
 * Parse the text after the sequence-set of a FETCH into the requested atts. `ok` is false when the
 * spec names a data item we do not implement (RFC 9051 §6.4.5): the caller answers a tagged BAD
 * rather than silently degrading to FLAGS+UID, which would hand the client the wrong response for
 * the item it actually asked for. A mix of known and unknown items is also `ok: false`. The caller
 * strips any CONDSTORE (CHANGEDSINCE …) modifier before calling, so only true data items are here.
 */
function parseFetchAtts(spec: string): { atts: FetchAtts; ok: boolean } {
  let ok = true;
  // BINARY / BINARY.SIZE / BINARY.PEEK (RFC 3516) are deliberately out of scope. Reject their
  // syntax loudly rather than let a "BINARY[1]" leak through as an unrecognised BODY section that
  // silently serves the whole body — the client asked for decoded content and must be told no.
  if (/\bBINARY(\.SIZE|\.PEEK)?\s*\[/i.test(spec)) ok = false;
  const atts: FetchAtts = {
    uid: false,
    flags: false,
    size: false,
    envelope: false,
    rfc822: false,
    rfc822Header: false,
    rfc822Text: false,
    internalDate: false,
    body: false,
    bodyStructure: false,
    modseq: false,
    bodySections: [],
  };
  // Pull out BODY[..] / BODY.PEEK[..] first — brackets may contain spaces — with
  // an optional <origin.count> partial specifier (TB: BODY.PEEK[TEXT]<0.2048>).
  // DE-DUPLICATED and CAPPED, for exactly the reason `statusItems` is (see its comment).
  // §9's `fetch-att *(SP fetch-att)` puts no uniqueness constraint on the list, so a repeat is
  // legal and cannot be answered BAD — but every repeat here costs a FULL COPY of the message
  // body, and `#emitFetch` concatenates them all into ONE contiguous buffer before writing. A
  // 2 KB command repeating `BODY[]` 300 times against a 4 MiB message allocated 1.2 GB and took
  // the process to 2.5 GB RSS; at the 25 MiB APPEND ceiling the same shape is a 7.5 GB
  // allocation, i.e. an immediate OOM of a process serving every account. The write-backlog
  // shedder cannot help — it runs after the concatenation, and exempts this socket.
  //
  // The key distinguishes sections that genuinely differ (a different part, a different partial
  // range); it deliberately folds BODY[…] and BODY.PEEK[…] of the same section together, since
  // the emitted payload is identical and only the \Seen side effect differs, which is applied
  // once either way. Section names are compared case-insensitively because `#emitFetch`
  // upper-cases them before use.
  const sectionIndex = new Map<string, number>();
  const rest = spec.replace(/BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gi, (_m, peek: string | undefined, section: string, origin?: string, count?: string) => {
    const isPeek = peek !== undefined;
    const trimmed = section.trim();
    const key = `${trimmed.toUpperCase()}|${origin ?? ''}.${count ?? ''}`;
    const already = sectionIndex.get(key);
    if (already !== undefined) {
      // Same bytes requested twice. Emit once — but a non-peek request still marks \Seen, so
      // the side effect is the OR across the duplicates, never silently downgraded to PEEK.
      if (!isPeek) atts.bodySections[already]!.peek = false;
      return ' ';
    }
    if (sectionIndex.size >= MAX_BODY_SECTIONS) {
      ok = false;
      return ' ';
    }
    sectionIndex.set(key, atts.bodySections.length);
    atts.bodySections.push(
      origin !== undefined && count !== undefined
        ? { section: trimmed, partial: { origin: Number(origin), count: Number(count) }, peek: isPeek }
        : { section: trimmed, peek: isPeek },
    );
    return ' ';
  });
  for (const tok of rest.split(/[()\s]+/)) {
    const t = tok.toUpperCase();
    if (t === 'UID') atts.uid = true;
    else if (t === 'FLAGS') atts.flags = true;
    else if (t === 'INTERNALDATE') atts.internalDate = true;
    // A bare BODY (the bracketed BODY[...] forms were already pulled out above) is the
    // non-extensible MIME structure; BODYSTRUCTURE is the extensible form.
    else if (t === 'BODY') atts.body = true;
    else if (t === 'BODYSTRUCTURE') atts.bodyStructure = true;
    else if (t === 'MODSEQ') atts.modseq = true;
    else if (t === 'RFC822.SIZE') atts.size = true;
    else if (t === 'ENVELOPE') atts.envelope = true;
    else if (t === 'RFC822.HEADER') atts.rfc822Header = true;
    else if (t === 'RFC822.TEXT') atts.rfc822Text = true;
    else if (t === 'RFC822' || t === 'RFC822.PEEK') atts.rfc822 = true;
    // The fetch macros (RFC 9051 §6.4.5). FAST/ALL/FULL are how clients populate a
    // message list in one round-trip; each includes INTERNALDATE. (BODYSTRUCTURE, the
    // BODY item in FULL, is a separate unimplemented item — we expand FULL like ALL.)
    else if (t === 'ALL' || t === 'FAST' || t === 'FULL') {
      atts.flags = true;
      atts.internalDate = true;
      atts.size = true;
      if (t !== 'FAST') atts.envelope = true;
      if (t === 'FULL') atts.body = true; // FULL = ALL + BODY (non-extensible)
    }
    // An empty token (from the () wrapping or the BODY[...] placeholder space) is not a data item;
    // anything else is a FETCH att we do not implement — reject the whole FETCH (§6.4.5).
    else if (t !== '') ok = false;
  }
  return { atts, ok };
}

/** The header block of a message (up to and including the blank separator line). */
function headerBlock(raw: Buffer): Buffer {
  const end = raw.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
  return end === -1 ? raw : raw.subarray(0, end + 4);
}

/** The body of a message (after the header separator). */
function bodyBlock(raw: Buffer): Buffer {
  const end = raw.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
  return end === -1 ? Buffer.alloc(0) : raw.subarray(end + 4);
}

/**
 * Extract header fields as bytes: HEADER.FIELDS returns the listed fields;
 * HEADER.FIELDS.NOT (`exclude`) returns every field EXCEPT the listed ones. Getting
 * the sense wrong hands the client the opposite set of headers.
 */
function headerFields(raw: Buffer, names: readonly string[], exclude = false): Buffer {
  const named = new Set(names.map((n) => n.toLowerCase()));
  const lines: Buffer[] = [];
  for (const h of parseMessage(raw).headers) {
    const isNamed = named.has(h.name.toString('latin1').trim().toLowerCase());
    if (isNamed !== exclude) {
      lines.push(Buffer.from(`${h.name.toString('latin1').trim()}: ${h.value.toString('latin1').trim()}\r\n`, 'latin1'));
    }
  }
  lines.push(Buffer.from('\r\n', 'latin1'));
  return Buffer.concat(lines);
}

/** A pending APPEND waiting for its literal octets. */
interface PendingAppend {
  readonly tag: string;
  readonly mailboxName: string;
  readonly flags: readonly string[];
  readonly internalDate: number;
  readonly size: number;
}

export class ImapServer {
  readonly port: number;
  /** Live connection count — for observability / leak diagnostics (must return to baseline after churn). */
  get connectionCount(): number {
    return this.#sockets.size;
  }
  /** Bytes currently reserved for in-flight APPEND literals — must return to 0 when no upload is active. */
  get appendReservedBytes(): number {
    return this.#appendInflight;
  }
  readonly #server: net.Server;
  readonly #catalog: ServableCatalog;
  readonly #sockets = new Set<net.Socket>();
  readonly #authenticate: ((user: string, pass: string) => boolean) | undefined;
  readonly #notifier: MailboxNotifier | undefined;
  readonly #resolveAccount: ((login: string) => { catalog: ServableCatalog; notifier?: MailboxNotifier } | undefined) | undefined;
  readonly #isEnabled: ((login: string) => boolean) | undefined;
  readonly #autologoutMs: number;
  readonly #throttle: AuthThrottle | undefined;
  readonly #maxWriteBacklog: number;
  readonly #maxAppendInflight: number;
  readonly #maxAppendLiteral: number;
  readonly #log: ((line: string) => void) | undefined;
  /** Bytes reserved for in-flight APPEND literals, per connection, and the running total. */
  readonly #appendReserved = new Map<net.Socket, { size: number; login: string }>();
  /** Reserved bytes per login, so one account cannot take the whole budget. */
  readonly #appendByLogin = new Map<string, number>();
  #appendInflight = 0;
  readonly #credentialTag: ((login: string) => string | null) | undefined;
  /**
   * Every authenticated session, with the login and the credential fingerprint it authenticated
   * with. Revocation is swept over this rather than checked when a command arrives: a session
   * that never completes another command line — an IDLE client, or one dribbling bytes with no
   * CRLF — would otherwise never be re-examined at all.
   */
  readonly #authedSessions = new Map<net.Socket, { login: string; tag: string | null }>();
  #revocationTimer: NodeJS.Timeout | undefined;

  private constructor(
    server: net.Server,
    port: number,
    catalog: ServableCatalog,
    authenticate?: (user: string, pass: string) => boolean,
    notifier?: MailboxNotifier,
    autologoutMs = AUTOLOGOUT_MS,
    resolveAccount?: (login: string) => { catalog: ServableCatalog; notifier?: MailboxNotifier } | undefined,
    throttle?: AuthThrottle,
    maxWriteBacklog = MAX_WRITE_BACKLOG,
    maxAppendInflight = MAX_APPEND_INFLIGHT,
    log?: (line: string) => void,
    maxAppendLiteral = MAX_APPEND_LITERAL,
    isEnabled?: (login: string) => boolean,
    credentialTag?: (login: string) => string | null,
    revocationSweepMs = REVOCATION_SWEEP_MS,
  ) {
    this.#server = server;
    this.port = port;
    this.#revocationTimer = setInterval(() => this.#sweepRevoked(), revocationSweepMs);
    this.#revocationTimer.unref(); // never hold the process open for this
    this.#catalog = catalog;
    this.#authenticate = authenticate;
    this.#notifier = notifier;
    this.#resolveAccount = resolveAccount;
    this.#isEnabled = isEnabled;
    this.#credentialTag = credentialTag;
    this.#autologoutMs = autologoutMs;
    this.#throttle = throttle;
    this.#maxWriteBacklog = maxWriteBacklog;
    this.#maxAppendInflight = maxAppendInflight;
    this.#log = log;
    this.#maxAppendLiteral = maxAppendLiteral;
  }

  /**
   * Reserve `size` octets against the in-flight-APPEND budget. Returns false (reserving nothing)
   * when accepting the upload would exceed it — the caller then refuses the APPEND. A connection
   * holds at most one reservation at a time (one pending APPEND).
   *
   * The budget bounds memory, but as a single server-wide counter it was also a lock any one
   * account could take: the reservation is charged on the DECLARED size, before a byte of the
   * literal arrives, so eleven connections declaring maximal literals and sending nothing pinned
   * the whole 256 MiB. Every other account's APPEND then failed — Sent copies, drafts, imapsync
   * imports — for as long as the attacker kept the sockets alive, which costs one byte per
   * connection per autologout period. So the budget is also shared per principal: no login may
   * hold more than its slice, and one maximal literal always fits so a legitimate upload is never
   * refused on its own account's behalf.
   */
  #reserveAppend(sock: net.Socket, login: string | null, size: number): boolean {
    const perLogin = Math.max(this.#maxAppendLiteral, Math.floor(this.#maxAppendInflight / APPEND_ACCOUNT_SHARES));
    // Case-folded, because the principal is. Authentication resolves on `lower(login)` and
    // `MailStores` keys its cache on the lower-cased login, so ALICE and alice are one account
    // sharing one catalog and one mail database — but keyed on the wire spelling they were two
    // principals, and a handful of sessions varying the case took the whole server-wide budget and
    // locked every OTHER account out of APPEND. That is the exact failure the per-principal slice
    // above exists to prevent.
    const key = (login ?? '').toLowerCase();
    if ((this.#appendByLogin.get(key) ?? 0) + size > perLogin) return false;
    if (this.#appendInflight + size > this.#maxAppendInflight) return false;
    this.#appendInflight += size;
    this.#appendReserved.set(sock, { size, login: key });
    this.#appendByLogin.set(key, (this.#appendByLogin.get(key) ?? 0) + size);
    return true;
  }

  /** Release a connection's APPEND reservation (on completion, error, or disconnect). Idempotent. */
  #releaseAppend(sock: net.Socket): void {
    const held = this.#appendReserved.get(sock);
    if (held === undefined) return;
    this.#appendInflight -= held.size;
    this.#appendReserved.delete(sock);
    const remaining = (this.#appendByLogin.get(held.login) ?? 0) - held.size;
    if (remaining > 0) this.#appendByLogin.set(held.login, remaining);
    else this.#appendByLogin.delete(held.login);
  }

  /**
   * Cap total memory held for slow-reading clients. When the summed socket write backlog exceeds
   * the budget, drop the biggest-backlog (slowest-draining) connections until back under it — a
   * client reading promptly holds ~0 bytes and is never chosen. Called after each big (FETCH-body)
   * write. This is the backstop against the read-slowloris OOM; the connections it drops are, by
   * construction, ones not consuming their data.
   */
  #shedIfOverBudget(exempt?: net.Socket): void {
    shedToBudget(this.#sockets, this.#maxWriteBacklog, exempt);
  }

  /**
   * Start the server. `target` is a bare mailbox (served as INBOX only) or a
   * catalog of named mailboxes. With `options.tls` it serves implicit TLS
   * (IMAPS, port 993 in production); otherwise plaintext. With
   * `options.authenticate`, LOGIN is verified against it (else any LOGIN succeeds).
   *
   * `options.resolveAccount` turns on multi-account mode (ADR 0009): after a successful
   * auth the returned `{catalog, notifier}` for that login is bound to the connection, so
   * each user is served their own store. Without it, the single `target` catalog serves
   * every session — the shape every existing test and single-account deploy uses.
   */
  static start(
    target: ServableMailbox | ServableCatalog,
    options: {
      tls?: { key: string; cert: string };
      host?: string;
      port?: number;
      authenticate?: (user: string, pass: string) => boolean;
      notifier?: MailboxNotifier;
      autologoutMs?: number;
      resolveAccount?: (login: string) => { catalog: ServableCatalog; notifier?: MailboxNotifier } | undefined;
      /**
       * Is this login still enabled? Consulted on every command of an already-authenticated
       * session (not just at LOGIN), so `account disable` cuts a live IMAP connection at its
       * next command instead of leaving a compromised credential in use until a daemon restart.
       * Cheap (an in-memory registry lookup). Absent = single-account/test mode, no recheck.
       */
      isEnabled?: (login: string) => boolean;
      credentialTag?: (login: string) => string | null;
      /** Sweep interval; tests shorten it. */
      revocationSweepMs?: number;
      throttle?: AuthThrottle;
      /** Server-wide slow-consumer write-backlog budget in bytes (default 256 MiB). Tests set it small. */
      maxWriteBacklog?: number;
      /** Server-wide in-flight-APPEND-literal budget in bytes (default 256 MiB). Tests set it small. */
      maxAppendInflight?: number;
      /** Operational log sink: auth failures + throttle engagement (fail2ban raw material). */
      log?: (line: string) => void;
      /**
       * Max APPEND literal in octets (default 25 MiB). The daemon passes the SAME
       * configured maxMessageSize as the SMTP listeners — a raised MAIL_MAX_SIZE must
       * raise the IMAP import path too, or an imapsync migration of a large legacy
       * message (Gmail accepts up to 50 MB) hits an invisible second ceiling.
       */
      maxAppendLiteral?: number;
      /** Per-listener concurrent-connection ceiling (default 512). Tests override it small. */
      maxConnections?: number;
      /**
       * TLS handshake deadline in ms (IMAPS only; default 10 s). A client that opens the TCP
       * connection but never completes the TLS handshake otherwise pins a slot for Node's 120 s
       * default — a handshake slowloris. Tests set it tiny to prove the drop.
       */
      handshakeTimeoutMs?: number;
    } = {},
  ): Promise<ImapServer> {
    const catalog: ServableCatalog = 'listNames' in target ? target : inboxOnly(target);
    // IMAPS: bound the TLS handshake explicitly (RFC-agnostic hardening). Node's default is 120 s,
    // long enough that a handful of half-open handshakes tie up connection slots; a tight deadline
    // drops a peer that starts but never finishes the handshake.
    const server = options.tls !== undefined
      ? tls.createServer({ key: options.tls.key, cert: options.tls.cert, handshakeTimeout: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS })
      : net.createServer();
    if (options.tls !== undefined) {
      // A handshakeTimeout emits 'tlsClientError' but, on its own, leaves the underlying TCP socket
      // OPEN and still counted against maxConnections — so a handshake slowloris (open, dribble one
      // byte, never finish) would pin listener slots for nothing. Destroy the socket on any
      // client-side TLS error (timeout or a malformed ClientHello) to actually reclaim the slot.
      (server as tls.Server).on('tlsClientError', (_err: Error, tlsSocket: tls.TLSSocket) => {
        tlsSocket?.destroy();
      });
    }
    // Bound concurrent connections so a pre-auth flood / slowloris (connections that dribble
    // bytes to dodge the inactivity timeout) cannot exhaust file descriptors or memory — the
    // single-threaded daemon has no per-IP accounting, so a global ceiling is the backstop.
    // Far above any real client fan-out (a few clients × a handful each).
    server.maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
    return new Promise((resolve, reject) => {
      // Reject cleanly on a bind failure (EADDRINUSE / EACCES on privileged 993 without
      // root/setcap) instead of letting an unhandled 'error' event crash the process while this
      // Promise hangs; hand error handling back to the app once we're listening.
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
        server.removeListener('error', reject);
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        const imap = new ImapServer(server, port, catalog, options.authenticate, options.notifier, options.autologoutMs, options.resolveAccount, options.throttle, options.maxWriteBacklog, options.maxAppendInflight, options.log, options.maxAppendLiteral, options.isEnabled, options.credentialTag, options.revocationSweepMs);
        const event = options.tls !== undefined ? 'secureConnection' : 'connection';
        server.on(event, (sock: net.Socket) => {
          imap.#sockets.add(sock);
          sock.on('close', () => {
            imap.#sockets.delete(sock);
            imap.#releaseAppend(sock); // free any reservation held by an APPEND cut off mid-upload
          });
          imap.#handle(sock);
        });
        resolve(imap);
      });
    });
  }

  /** Remember who a connection authenticated as, and with which credential. */
  #trackSession(sock: net.Socket, login: string): void {
    this.#authedSessions.set(sock, { login, tag: this.#credentialTag?.(login) ?? null });
  }

  /**
   * Cut every session whose account has been disabled or whose credential has been replaced.
   *
   * `account disable` is the only containment verb the product ships — there is deliberately no
   * `account remove` (ADR 0012) — and rotating the password is the other action an operator takes
   * on a compromise. Both used to be checked only when a command arrived, so neither reached the
   * state a hijacked session is most likely to be resting in: an IDLE client short-circuits
   * before the check, and any session can defeat the inactivity timer with a single byte that
   * never completes a line. The result was that disable, rotate, then re-enable left the original
   * session working, authenticated with a credential that no longer existed.
   */
  #sweepRevoked(): void {
    for (const [sock, session] of this.#authedSessions) {
      const disabled = this.#isEnabled !== undefined && !this.#isEnabled(session.login);
      const rotated = session.tag !== null && this.#credentialTag !== undefined && this.#credentialTag(session.login) !== session.tag;
      if (!disabled && !rotated) continue;
      try {
        write(sock, disabled ? '* BYE account disabled' : '* BYE credentials revoked');
      } catch {
        // best-effort: the socket is going away regardless
      }
      this.#authedSessions.delete(sock);
      sock.destroy(); // fires 'close', which unsubscribes any IDLE
    }
  }

  /**
   * Stop serving, telling connected clients why.
   *
   * RFC 9051 §7.1.5: a server closing a connection for its own reasons SHOULD send an untagged BYE
   * first. Without it a client sees a socket vanish mid-session, which is indistinguishable from a
   * network fault and is generally reported to the user as one — during a planned restart, and now
   * during an automatic version cutover (ADR 0025), that turns a clean handover into an error
   * message on somebody's phone.
   *
   * `end()` rather than `destroy()`, because destroy discards whatever is still queued and the BYE
   * is the last thing written. A client that then declines to close gets a bounded grace period and
   * is reclaimed, so one stalled session cannot hold the shutdown open.
   */
  close(): Promise<void> {
    if (this.#revocationTimer !== undefined) clearInterval(this.#revocationTimer);
    const open = [...this.#sockets];
    for (const s of open) {
      try {
        write(s, '* BYE Server shutting down');
        s.end();
      } catch {
        s.destroy(); // already broken: nothing to say goodbye to
      }
    }
    this.#sockets.clear();
    this.#authedSessions.clear();
    const forceClose = setTimeout(() => {
      for (const s of open) s.destroy();
    }, BYE_GRACE_MS);
    return new Promise((resolve) =>
      this.#server.close(() => {
        clearTimeout(forceClose);
        resolve();
      }),
    );
  }

  /**
   * Resolve a sequence-set against a mailbox. In UID mode the set denotes UIDs
   * ("*" = highest UID in use); otherwise message sequence numbers.
   */
  #resolveSet(mailbox: ServableMailbox, set: string, uidMode: boolean): { seq: number; meta: MessageMeta }[] {
    const msgs = mailbox.index();
    if (msgs.length === 0) return [];
    if (uidMode) {
      const largest = msgs[msgs.length - 1]!.uid;
      const uids = new Set(parseSequenceSet(set, largest));
      return msgs.map((meta, i) => ({ seq: i + 1, meta })).filter((e) => uids.has(e.meta.uid));
    }
    const seqs = parseSequenceSet(set, msgs.length);
    return seqs.filter((s) => s >= 1 && s <= msgs.length).map((s) => ({ seq: s, meta: msgs[s - 1]! }));
  }

  /** Emit one message's FETCH response for the requested atts. */
  /**
   * Verify a SASL PLAIN token ("[authzid]\0authcid\0password", base64) and return the
   * authenticated username on success, or null on failure — the username is needed to
   * resolve the account in multi-account mode.
   */
  #saslPlainUser(b64: string): string | null {
    const parts = Buffer.from(b64, 'base64').toString('latin1').split('\0');
    const user = parts[1] ?? '';
    const pass = parts[2] ?? '';
    // No authenticate callback configured = permissive (test servers); still requires
    // the client to actually authenticate, just accepts any credentials.
    return this.#authenticate === undefined || this.#authenticate(user, pass) ? user : null;
  }

  #emitFetch(sock: net.Socket, seq: number, meta: MessageMeta, atts: FetchAtts, uidMode: boolean, mailbox: ServableMailbox): void {
    const out: Buffer[] = [];
    let first = true;
    // The body bytes are fetched at most ONCE, and only if a body-bearing att is asked for:
    // a FETCH of FLAGS/UID/SIZE/INTERNALDATE/MODSEQ (the message-list sync clients do
    // constantly) never touches the BLOB. size comes from the metadata, not the body.
    let rawCache: Buffer | undefined;
    const raw = (): Buffer => (rawCache ??= mailbox.raw(meta.uid) ?? Buffer.alloc(0));
    const sep = (): void => {
      if (!first) out.push(Buffer.from(' ', 'latin1'));
      first = false;
    };
    const text = (s: string): void => {
      sep();
      out.push(Buffer.from(s, 'latin1'));
    };
    const literal = (name: string, payload: Buffer): void => {
      sep();
      out.push(Buffer.from(`${name} {${payload.length}}\r\n`, 'latin1'), payload);
    };
    // UID is mandatory in a UID FETCH response even when not requested.
    if (atts.uid || uidMode) text(`UID ${meta.uid}`);
    if (atts.flags) text(`FLAGS (${[...meta.flags].join(' ')})`);
    if (atts.internalDate) text(`INTERNALDATE "${formatImapDateTime(meta.internalDate)}"`);
    if (atts.size) text(`RFC822.SIZE ${meta.size}`);
    if (atts.modseq) text(`MODSEQ (${meta.modseq})`);
    if (atts.envelope) text(`ENVELOPE ${serializeEnvelope(buildEnvelope(parseMessage(raw()).headers))}`);
    if (atts.body) text(`BODY ${bodyResponse(raw())}`);
    if (atts.bodyStructure) text(`BODYSTRUCTURE ${bodyStructureResponse(raw())}`);
    // The legacy RFC822.* items — real Thunderbird fetches RFC822.HEADER for the list.
    if (atts.rfc822Header) literal('RFC822.HEADER', headerBlock(raw()));
    if (atts.rfc822Text) literal('RFC822.TEXT', bodyBlock(raw()));
    if (atts.rfc822) literal('RFC822', raw());
    for (const { section, partial } of atts.bodySections) {
      const up = section.toUpperCase();
      let name: string;
      let payload: Buffer;
      if (up === '') {
        name = 'BODY[]';
        payload = raw();
      } else if (up.startsWith('HEADER.FIELDS')) {
        const isNot = up.startsWith('HEADER.FIELDS.NOT');
        const fields = /\(([^)]*)\)/.exec(section)?.[1] ?? '';
        const names = fields.split(/\s+/).filter((f) => f.length > 0);
        name = `BODY[HEADER.FIELDS${isNot ? '.NOT' : ''} (${names.map((n) => n.toUpperCase()).join(' ')})]`;
        payload = headerFields(raw(), names, isNot);
      } else if (up === 'HEADER') {
        name = 'BODY[HEADER]';
        payload = headerBlock(raw());
      } else if (up === 'TEXT') {
        name = 'BODY[TEXT]';
        payload = bodyBlock(raw());
      } else if (/^\d/.test(up)) {
        // A part specifier: "1", "2.1" (nested), "1.MIME"/"1.HEADER" (the part's
        // headers), "1.TEXT" (its body). Navigate the MIME tree so a client can fetch
        // one attachment (BODY[2]) rather than the whole message.
        const parsed = /^([\d.]+?)(?:\.(MIME|HEADER|TEXT))?$/.exec(up);
        const path = parsed ? parsed[1]!.split('.').map(Number) : [];
        const spec = parsed?.[2];
        const entity = path.length > 0 && !path.some(Number.isNaN) ? resolvePart(raw(), path) : null;
        name = `BODY[${up}]`;
        payload = entity === null ? Buffer.alloc(0) : spec === 'MIME' || spec === 'HEADER' ? headerBlock(entity) : bodyBlock(entity);
      } else {
        // Truly unrecognised section — serve the whole body rather than lie with an
        // empty literal.
        name = 'BODY[]';
        payload = raw();
      }
      if (partial !== undefined) {
        // RFC 9051 §6.4.5: <origin.count> slices the section; the response is
        // tagged with the origin only: BODY[TEXT]<0> {n}.
        payload = payload.subarray(partial.origin, partial.origin + partial.count);
        name = `${name}<${partial.origin}>`;
      }
      literal(name, payload);
    }
    if (first) {
      // A FETCH that named nothing we recognise still answers with FLAGS+UID.
      text(`FLAGS (${[...meta.flags].join(' ')})`);
      text(`UID ${meta.uid}`);
    }
    sock.write(Buffer.concat([Buffer.from(`* ${seq} FETCH (`, 'latin1'), ...out, Buffer.from(')\r\n', 'latin1')]));
    // A body response can be large; if slow readers have let the server-wide queue exceed budget,
    // shed the slowest so many stalled fetchers cannot OOM the process (docs/PERFORMANCE.md).
    // Exempt THIS socket: its writableLength is at a same-tick pre-drain peak from the write above,
    // not a stall, so it must not be the one dropped.
    this.#shedIfOverBudget(sock);
  }

  #handle(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
    const ip = sock.remoteAddress ?? '';
    // Brute-force throttle helpers (no-ops when no throttle is configured). Every failure
    // is logged with the source IP — without this line an operator cannot see a
    // credential-stuffing run at all, let alone feed fail2ban. The attempted login is
    // attacker-controlled, so it is JSON-escaped (no raw control bytes into the log).
    const authBlocked = (): boolean => this.#throttle?.isBlocked(ip) === true;
    const noteAuthFailure = (user?: string): void => {
      this.#throttle?.recordFailure(ip);
      // JSON.stringify escapes C0, `"` and `\` — but NOT DEL (0x7f) or the C1 range
      // (0x80-0x9f), which is exactly the 33-byte set sanitizeForTerminal strips and which some
      // terminals treat as 8-bit escape introducers. JSON-escaping is not a terminal sanitiser,
      // and this line is documented as the fail2ban feed.
      this.#log?.(sanitizeForTerminalLine(`imap auth failed${user !== undefined ? ` for ${JSON.stringify(user)}` : ''} from ${ip}`));
      if (this.#throttle?.isBlocked(ip) === true) this.#log?.(`auth throttle engaged for ${ip} (imap), refusing further attempts while the window drains`);
    };
    const noteAuthSuccess = (): void => this.#throttle?.recordSuccess(ip);
    let selected: ServableMailbox | null = null;
    let selectedName: string | null = null;
    let pendingAppend: PendingAppend | null = null;
    let idle: { tag: string; unsub: () => void } | null = null;
    // This connection's view of the selected mailbox: the UIDs in sequence order the
    // client has been told about, and the flag set last reported for each. Comparing
    // them to the live mailbox is how we detect what another connection expunged,
    // delivered, or re-flagged, to relay it to this one.
    let knownUids: number[] = [];
    let knownFlags = new Map<number, string>();
    // CONDSTORE (RFC 7162) is enabled for the session by SELECT/EXAMINE (CONDSTORE),
    // ENABLE CONDSTORE/QRESYNC, or any command that uses MODSEQ/CHANGEDSINCE/
    // UNCHANGEDSINCE. Once enabled, every FETCH response carries MODSEQ.
    let condstore = false;
    // QRESYNC (RFC 7162) — enabled by ENABLE QRESYNC. Unlocks SELECT (QRESYNC ...) fast
    // reconnect and the VANISHED FETCH modifier. Implies CONDSTORE.
    let qresync = false;
    // IMAP4rev2 (RFC 9051) enabled for the session by ENABLE IMAP4REV2. Once enabled, a plain
    // SEARCH answers with the ESEARCH form instead of the legacy `* SEARCH` (§6.4.4). Not enabled
    // by default: an un-ENABLEd session keeps the rev1-shaped `* SEARCH` reply as a deliberate
    // compatibility position (a rev2 server MAY speak rev1 shapes until the client opts in).
    let imap4rev2 = false;

    /** A flag set in a canonical, order-independent form, for change detection. */
    const flagKey = (flags: Iterable<string>): string => [...flags].sort().join(' ');

    /**
     * Bring the client's view in line with the mailbox: an untagged EXPUNGE for each
     * message that disappeared (descending sequence, so earlier numbers stay valid),
     * a single EXISTS if new messages arrived, and an untagged FETCH for any surviving
     * message whose flags another connection changed (RFC 9051 §7.4.1). Called at safe
     * boundaries — NOOP/CHECK/IDLE and the start of EXPUNGE/COPY/MOVE — never during a
     * FETCH/STORE/SEARCH response, where §7.4.1 forbids renumbering.
     *
     * The companion to this is `resolveForConn`: between a peer's EXPUNGE and this
     * connection's next boundary, sequence-numbered FETCH/STORE/SEARCH resolve against
     * this same client view (`knownUids`), NOT the live mailbox — so a bare-sequence
     * command in that window cannot be silently renumbered onto a different message
     * (RFC 9051 §7.4.1). §7.4.1 bars sending the EXPUNGE earlier (during those exact
     * commands), so we hold the client's numbering stable until it reaches a boundary
     * here. Verified against Dovecot's imaptest (see reference-servers/CALIBRATION-imaptest.md).
     */
    // Report removed messages: once QRESYNC is enabled the server MUST use a single
    // VANISHED (no EARLIER) instead of per-message EXPUNGE (RFC 7162 §3.2.10); otherwise
    // classic EXPUNGE by descending sequence so the client's numbering stays valid.
    const emitExpunged = (uids: readonly number[], descendingPositions: readonly number[]): void => {
      if (qresync) {
        if (uids.length > 0) write(sock, `* VANISHED ${compressSequenceSet([...uids].sort((a, b) => a - b))}`);
      } else {
        for (const pos of descendingPositions) write(sock, `* ${pos} EXPUNGE`);
      }
    };

    const syncSelected = (): void => {
      if (selected === null) return;
      const live = selected.index();
      const current = live.map((m) => m.uid);
      const present = new Set(current);
      const removedPositions: number[] = []; // 1-based positions in the client's current view
      const removedUids: number[] = [];
      knownUids.forEach((uid, i) => {
        if (!present.has(uid)) {
          removedPositions.push(i + 1);
          removedUids.push(uid);
        }
      });
      emitExpunged(removedUids, [...removedPositions].reverse());
      knownUids = knownUids.filter((uid) => present.has(uid));
      const knownSet = new Set(knownUids);
      if (current.some((uid) => !knownSet.has(uid))) {
        knownUids = current.slice();
        write(sock, `* ${knownUids.length} EXISTS`);
      }
      // Flag changes made elsewhere. Sequence numbers are the client's post-EXPUNGE
      // view, which now matches the mailbox order (append-only + in-place remove).
      live.forEach((m, i) => {
        const cur = flagKey(m.flags);
        const prev = knownFlags.get(m.uid);
        if (prev !== undefined && prev !== cur) {
          const mod = condstore ? `MODSEQ (${m.modseq}) ` : '';
          write(sock, `* ${i + 1} FETCH (FLAGS (${[...m.flags].join(' ')}) ${mod}UID ${m.uid})`);
        }
        knownFlags.set(m.uid, cur);
      });
      for (const uid of [...knownFlags.keys()]) if (!present.has(uid)) knownFlags.delete(uid);
    };

    /**
     * Resolve a sequence-set against THIS connection's view of the mailbox, not the
     * live message list. Sequence numbers address the numbering the client last saw
     * (`knownUids`), so a peer's EXPUNGE cannot silently renumber a bare-sequence
     * FETCH/STORE/SEARCH before this connection has been sent the EXPUNGE — the
     * RFC 9051 §7.4.1 rule that #resolveSet (which reads the live list) violated. A
     * message the client still knows about that a peer expunged (gone from storage,
     * not yet acknowledged here) is OMITTED, never replaced by whatever message slid
     * into its position. UID mode still addresses by UID (immune to renumbering) but
     * reports each message at its client-view sequence number for the same reason;
     * a message not yet in the client's view (e.g. one it just APPENDed) keeps its
     * live position so a self-append-then-fetch still works.
     */
    const resolveForConn = (set: string, uidMode: boolean): { seq: number; meta: MessageMeta }[] => {
      if (selected === null) return [];
      const live = selected.index();
      if (uidMode) {
        if (live.length === 0) return [];
        const largest = live[live.length - 1]!.uid;
        const wanted = new Set(parseSequenceSet(set, largest));
        const viewIndex = new Map(knownUids.map((uid, i) => [uid, i + 1]));
        return live.map((meta, i) => ({ seq: viewIndex.get(meta.uid) ?? i + 1, meta })).filter((e) => wanted.has(e.meta.uid));
      }
      const byUid = new Map(live.map((m) => [m.uid, m]));
      const out: { seq: number; meta: MessageMeta }[] = [];
      for (const s of parseSequenceSet(set, knownUids.length)) {
        if (s < 1 || s > knownUids.length) continue;
        const meta = byUid.get(knownUids[s - 1]!);
        if (meta !== undefined) out.push({ seq: s, meta });
      }
      return out;
    };
    // IMAP has three states (RFC 9051 §3); everything except the pre-auth commands
    // requires Authenticated. Without this gate a client could SELECT and FETCH mail
    // with no LOGIN at all. `pendingAuth` holds the tag of an AUTHENTICATE PLAIN that
    // is awaiting its base64 SASL response on the next line.
    let authenticated = false;
    let authedLogin: string | null = null; // the login bound on success, for the mid-session disable recheck
    let pendingAuth: string | null = null;
    /**
     * Protocol errors on this connection. Mirrors smtp-receiver.ts's MAX_HARD_ERRORS, whose
     * comment applies verbatim: a peer streaming junk commands holds its connection slot
     * indefinitely and is otherwise bounded only by MAX_CONNECTIONS. Both refusal paths count —
     * an unknown verb and a command issued before authenticating — because a peer occupying a
     * slot can reach either, and the inactivity timer is reset by whatever it sends.
     */
    let badCommands = 0;
    const tooManyBadCommands = (): boolean => {
      badCommands += 1;
      if (badCommands < (authenticated ? MAX_BAD_COMMANDS : MAX_BAD_COMMANDS_PREAUTH)) return false;
      write(sock, '* BYE too many invalid commands');
      sock.destroy();
      return true;
    };
    let readOnly = false; // set when the mailbox was opened with EXAMINE, not SELECT
    // The catalog + notifier THIS connection serves. Without a resolver they stay the
    // server's shared instances (single-account mode); with one (ADR 0009), a successful
    // auth rebinds them to the authenticated user's own store, so every mailbox command
    // below runs against that user's data and never another user's.
    let connCatalog = this.#catalog;
    let connNotifier = this.#notifier;
    const bindAccount = (login: string): boolean => {
      if (this.#resolveAccount === undefined) {
        authedLogin = login; // single-account mode: nothing to rebind, but remember who for the disable recheck
        this.#trackSession(sock, login);
        return true;
      }
      const acct = this.#resolveAccount(login);
      if (acct === undefined) return false; // credentials verified but account unknown/disabled
      connCatalog = acct.catalog;
      connNotifier = acct.notifier;
      authedLogin = login;
      this.#trackSession(sock, login);
      return true;
    };
    sock.on('error', () => {});
    sock.on('close', () => {
      idle?.unsub();
      this.#authedSessions.delete(sock);
    });
    // RFC 9051 §5.4: autologout an inactive connection (timer ≥ 30 min). An IDLE
    // client re-issues within ~29 min, so this fires only on genuine inactivity and
    // stops idle/slowloris connections holding resources forever.
    sock.setTimeout(this.#autologoutMs);
    sock.on('timeout', () => {
      idle?.unsub();
      try {
        write(sock, '* BYE autologout; idle for too long');
      } catch {
        // best-effort
      }
      sock.destroy();
    });
    write(sock, `* OK [CAPABILITY ${CAPABILITIES}] server ready`);

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      for (;;) {
        // A pending APPEND literal consumes raw octets before any line parsing.
        if (pendingAppend !== null) {
          if (buf.length < pendingAppend.size + 2) break;
          const raw = Buffer.from(buf.subarray(0, pendingAppend.size));
          // The command's terminating CRLF follows the literal octets.
          buf = buf.subarray(pendingAppend.size + 2);
          const box = connCatalog.get(pendingAppend.mailboxName);
          if (box === undefined) {
            write(sock, `${pendingAppend.tag} NO [TRYCREATE] no such mailbox`);
          } else {
            // UIDPLUS (RFC 4315): tell the client the UID it just created, so it
            // needn't re-search for the message it filed (e.g. a Sent copy).
            const uid = box.append(raw, pendingAppend.flags, pendingAppend.internalDate);
            // If we appended to our OWN selected mailbox, bring this connection's view
            // in step now (untagged EXISTS + knownUids update) so a following
            // sequence-number command can address the message the client just filed —
            // a server SHOULD send EXISTS after such an APPEND (RFC 9051 §6.3.12).
            // Without this, sequence resolution (which now honours the client's view,
            // not the live list) would omit the just-appended message until the next
            // boundary.
            if (selected !== null && selectedName !== null && canonicalMailboxName(pendingAppend.mailboxName) === selectedName) syncSelected();
            write(sock, `${pendingAppend.tag} OK [APPENDUID ${box.uidValidity} ${uid}] APPEND completed`);
            // Wake connections idling on this mailbox so the new message shows up.
            connNotifier?.notify(canonicalMailboxName(pendingAppend.mailboxName));
          }
          this.#releaseAppend(sock); // literal received and stored — free its budget reservation
          pendingAppend = null;
          continue;
        }

        const nl = buf.indexOf(Buffer.from([0x0d, 0x0a]));
        if (nl === -1) {
          // An unterminated command line must not buffer without bound. (Large
          // payloads use APPEND literals, which are separately capped.)
          if (buf.length > 65536) {
            write(sock, '* BAD command line too long, closing connection');
            sock.end();
          }
          break;
        }
        const line = buf.subarray(0, nl).toString('latin1');
        buf = buf.subarray(nl + 2);
        // If we are awaiting an AUTHENTICATE base64 response, this line IS the credential —
        // redact it wholesale (the LOGIN/AUTHENTICATE regexes don't match a bare base64).
        debugLog(line, pendingAuth !== null);

        // While idling, the only expected client input is DONE (RFC 2177).
        if (idle !== null) {
          if (line.trim().toUpperCase() === 'DONE') {
            idle.unsub();
            write(sock, `${idle.tag} OK IDLE terminated`);
            idle = null;
          }
          continue; // ignore any other stray input during IDLE
        }

        // The base64 response line of an AUTHENTICATE PLAIN continuation.
        if (pendingAuth !== null) {
          const authTag = pendingAuth;
          pendingAuth = null;
          if (line.trim() === '*') {
            write(sock, `${authTag} BAD authentication cancelled`);
          } else if (!isValidBase64(line.trim())) {
            // RFC 9051 §6.2.2 MUST: an invalid base64 response is a tagged BAD, not a NO. The
            // difference is what a client does next — NO sends it back to the user for another
            // password, BAD tells it that its own encoding is broken and retrying will not help,
            // so answering NO puts a client with a SASL bug into a re-prompt loop against a user
            // whose password is fine.
            //
            // Checked before authBlocked(), and it costs the throttle nothing: this path never
            // examines a credential, so there is no guess here to give away for free. It counts
            // as a protocol error instead, which is the bound that actually applies — otherwise a
            // peer could hold a connection slot open indefinitely on malformed continuations,
            // none of which the credential throttle would ever see.
            if (tooManyBadCommands()) return;
            write(sock, `${authTag} BAD invalid base64 in AUTHENTICATE response`);
          } else if (authBlocked()) {
            // Re-check the throttle on the continuation too (consistent with the LOGIN and
            // AUTHENTICATE-initiation gates): refuse a blocked IP WITHOUT checking the
            // password, so an IP that crossed the threshold on another connection between
            // the command and its continuation gets no free guess here.
            write(sock, `${authTag} NO [AUTHENTICATIONFAILED] too many attempts, try later`);
          } else {
            const authedUser = this.#saslPlainUser(line.trim());
            if (authedUser !== null && bindAccount(authedUser)) {
              noteAuthSuccess();
              authenticated = true;
              write(sock, `${authTag} OK [CAPABILITY ${CAPABILITIES}] authenticated`);
            } else {
              noteAuthFailure();
              write(sock, `${authTag} NO [AUTHENTICATIONFAILED] invalid credentials`);
            }
          }
          continue;
        }

        const parts = line.split(' ');
        const tag = parts[0] ?? '';

        // The UID prefix runs FETCH/STORE/SEARCH/COPY/MOVE addressed by UID
        // instead of sequence number (RFC 9051 §6.4.9). Normalise, dispatch once.
        let uidMode = false;
        let cmdIndex = 1;
        if ((parts[1] ?? '').toUpperCase() === 'UID') {
          uidMode = true;
          cmdIndex = 2;
        }
        const cmd = (parts[cmdIndex] ?? '').toUpperCase();
        const arg = (n: number): string => parts[cmdIndex + n] ?? '';
        // Quote-aware argument tokens — for mailbox names that may contain spaces
        // ("Sent Items", "Deleted Items"). A plain split(' ') truncates them.
        const afterTag = line.slice(tag.length).trimStart();
        const afterUid = uidMode ? afterTag.replace(/^\S+\s+/, '') : afterTag;
        const qargs = imapTokens(afterUid.slice(cmd.length).trimStart());
        const qarg = (n: number): string => qargs[n - 1] ?? '';

        // RFC 9051 §3: reject any command that needs Authenticated state before LOGIN
        // succeeds. This is the gate that stops unauthenticated mailbox access.
        if (!authenticated && !PREAUTH_COMMANDS.has(cmd)) {
          if (tooManyBadCommands()) return;
          write(sock, `${tag} NO not authenticated, LOGIN or AUTHENTICATE first`);
          continue;
        }

        // …and the other half of that gate: §9's `command-nonauth = login / authenticate /
        // "STARTTLS"` is annotated "Valid only when in Not Authenticated state", so these are
        // out of grammar once authenticated. Two things went wrong without this.
        //
        // `bindAccount` rebinds the connection's catalog but does NOT clear `selected`, and
        // `selected` is a mailbox HANDLE captured at SELECT that FETCH/STORE/EXPUNGE reuse
        // without re-deriving. So logging in as a second account kept the FIRST account's
        // mailbox open while the revocation sweep and the per-command recheck both started
        // evaluating the new login — `account disable` and a password rotation, the only two
        // containment verbs this server has (ADR 0012), stopped reaching the session, and it
        // could still read and expunge the victim's mail.
        //
        // It also removed the only bound on how much key derivation one connection can buy:
        // verification is a deliberately expensive PBKDF2 and a SUCCESSFUL auth costs no
        // throttle budget (auth-throttle.ts, correctly — charging successes would let an
        // attacker lock out legitimate users), so an unlimited LOGIN loop was an unlimited
        // supply of work on the only thread. Dovecot answers `BAD Already authenticated`.
        if (authenticated && (cmd === 'LOGIN' || cmd === 'AUTHENTICATE')) {
          if (tooManyBadCommands()) return;
          write(sock, `${tag} BAD already authenticated`);
          continue;
        }

        // Containment for a disabled/compromised account: `account disable` must cut a session
        // that is ALREADY authenticated, not only refuse the next LOGIN. Re-check enabled status
        // on every authenticated command (a cheap in-memory registry lookup) and drop the
        // connection with BYE the moment the account is disabled.
        if (authenticated && authedLogin !== null && this.#isEnabled !== undefined && !this.#isEnabled(authedLogin)) {
          write(sock, '* BYE account disabled');
          sock.destroy(); // fires the socket 'close' handler, which unsubscribes any IDLE
          return;
        }

        // Never let a malformed command crash the connection or the process —
        // an internet-facing parser must degrade to a protocol error, not throw.
        try {
        switch (cmd) {
          case 'CAPABILITY':
            write(sock, `* CAPABILITY ${CAPABILITIES}`);
            write(sock, `${tag} OK CAPABILITY completed`);
            break;
          case 'ID':
            // RFC 2971: we have no interesting identity to declare.
            write(sock, '* ID NIL');
            write(sock, `${tag} OK ID completed`);
            break;
          case 'NAMESPACE':
            // One personal namespace, no shared/other namespaces (RFC 9051 §6.3.10).
            write(sock, '* NAMESPACE (("" "/")) NIL NIL');
            write(sock, `${tag} OK NAMESPACE completed`);
            break;
          case 'LIST': {
            // Extended LIST (RFC 9051 §6.3.9): [ (selection-options) ] reference pattern
            // [ RETURN (options) ].
            const parsedList = parseListCommand(afterUid.slice(cmd.length).trimStart());
            if (parsedList === null) {
              write(sock, `${tag} BAD LIST syntax`);
              break;
            }
            const { selection, ret, reference, pattern } = parsedList;
            // §6.3.9 MUST: an option we do not recognise is a BAD. Note the neighbouring rule
            // pulls the OTHER way and the two are easy to confuse — an unmatched PATTERN must be
            // silently ignored and still answer OK (see the pattern handling below), because a
            // client walking a hierarchy asks about names that may not exist. An unrecognised
            // OPTION is different in kind: the client sent it because it intends to rely on the
            // answer, so a server that ignores it returns a well-formed reply the client will
            // misread.
            const unrecognised = [
              ...selection.filter((o) => !LIST_SELECTION_OPTIONS.has(o)),
              ...ret.filter((o) => !LIST_RETURN_OPTIONS.has(o.name)).map((o) => o.name),
            ];
            if (unrecognised.length > 0) {
              write(sock, `${tag} BAD unrecognised LIST option: ${unrecognised.join(' ')}`);
              break;
            }
            // §6.3.9.2: RECURSIVEMATCH "MUST NOT occur as the only selection option" — on its own
            // it has no criterion to recurse against, so the command is meaningless rather than
            // merely unsupported.
            if (selection.includes('RECURSIVEMATCH') && selection.length === 1) {
              write(sock, `${tag} BAD RECURSIVEMATCH requires another selection option`);
              break;
            }
            // Subscription state is not tracked (single-user server), so every mailbox is
            // subscribed: the SUBSCRIBED selection option therefore selects everything, and either
            // spelling of the option adds \Subscribed to what is reported.
            const wantSubscribed = selection.includes('SUBSCRIBED') || ret.some((o) => o.name === 'SUBSCRIBED');
            // (SPECIAL-USE) selection (RFC 6154 §2): return only mailboxes that carry a
            // special-use attribute (\Sent, \Drafts, \Trash, \Junk, \Archive).
            const onlySpecialUse = selection.includes('SPECIAL-USE');
            // RETURN (STATUS (...)) (§6.3.9.5): each matched mailbox also draws the untagged
            // STATUS it would have answered to a STATUS command. CHILDREN and SPECIAL-USE need no
            // handling here — the attributes they ask for are on every LIST line already.
            const statusReturn = ret.find((o) => o.name === 'STATUS')?.args;
            if (pattern === '') {
              // A bare-root probe: the reference IS a valid mailbox reference.
              write(sock, '* LIST (\\Noselect) "/" ""');
            } else {
              const realNames = connCatalog.listNames();
              // CREATE "a/b/c" does not materialise the superior names "a" and "a/b" (RFC 9051
              // §6.3.4 leaves that a SHOULD). Without surfacing them, a %-walk (which matches
              // within one hierarchy level: matchNames %=[^/]*) never sees "a", so the child is
              // undiscoverable. Per §6.3.9 we list each such intermediate as (\NonExistent
              // \HasChildren): it names a level in the path that has children but is not itself a
              // selectable mailbox (SELECT/STATUS of it still return NO — it does not exist). We
              // do NOT auto-create the parents (that would mint phantom selectable mailboxes with
              // their own UIDVALIDITY); we merely make the hierarchy walkable.
              const phantoms = new Set<string>();
              for (const n of realNames) {
                const segs = n.split('/');
                for (let k = 1; k < segs.length; k++) {
                  const anc = segs.slice(0, k).join('/');
                  // Skip the empty ancestor a leading separator produces (`CREATE "/Sent"`), or
                  // LIST would describe the name "" as \NonExistent \HasChildren while the
                  // bare-root probe describes the same name as \Noselect — two contradictory
                  // answers for one name, and a nameless folder in the client.
                  if (anc !== '' && !realNames.includes(anc)) phantoms.add(anc);
                }
              }
              const allNames = [...realNames, ...phantoms];
              for (const name of matchNames(reference, pattern, allNames)) {
                if (onlySpecialUse && SPECIAL_USE[name] === undefined) continue;
                if (phantoms.has(name)) {
                  // A non-existent intermediate: never carries special-use or subscription state.
                  if (onlySpecialUse) continue;
                  write(sock, `* LIST (\\NonExistent \\HasChildren) "/" ${imapMailboxAstring(name)}`);
                  continue;
                }
                const attrs = wantSubscribed ? listAttributes(name, allNames).replace(/\)$/, ' \\Subscribed)') : listAttributes(name, allNames);
                write(sock, `* LIST ${attrs} "/" ${imapMailboxAstring(name)}`);
                // §6.3.9.5: the STATUS return option draws the same untagged STATUS a STATUS
                // command would. Phantoms are skipped above, so every name reaching here is a real
                // selectable mailbox — which is the rule: STATUS is not returned for a name that
                // does not exist.
                if (statusReturn !== undefined) {
                  const box = connCatalog.get(name);
                  if (box !== undefined) write(sock, `* STATUS ${imapMailboxAstring(name)} (${statusItems(box, statusReturn).join(' ')})`);
                }
              }
            }
            write(sock, `${tag} OK LIST completed`);
            break;
          }
          case 'LSUB': {
            // rev2 dropped LSUB; answered like LIST as a deliberate concession to
            // clients that still probe with it during setup.
            for (const name of matchNames(qarg(1), qarg(2), connCatalog.listNames())) {
              write(sock, `* LSUB () "/" ${imapMailboxAstring(name)}`);
            }
            write(sock, `${tag} OK LSUB completed`);
            break;
          }
          case 'SUBSCRIBE':
          case 'UNSUBSCRIBE':
            // Single-user server: subscription state is not tracked.
            write(sock, `${tag} OK ${cmd} completed`);
            break;
          case 'CREATE': {
            const name = qarg(1);
            if (canonicalMailboxName(name) === 'INBOX') {
              write(sock, `${tag} NO INBOX already exists`);
            } else if (!withinMailboxNameBounds(name)) {
              // §5.1 sets no length limit, so this is our own bound and it is a DoS one, not a
              // storage one. LIST rebuilds every ancestor prefix of every name, which is
              // quadratic in segment count: a single 64 KB CREATE of a 32,000-segment name made
              // every subsequent `LIST "" *` block the event loop for ~18 seconds — for every
              // account, not just the one that created it — and because the name is stored, the
              // cost recurred on every later LIST and survived restarts. Dovecot's own default
              // limit is 255 characters, so this is generous rather than restrictive.
              write(sock, `${tag} NO [CANNOT] mailbox name too long`);
            } else if (!isNetUnicode(name)) {
              // RFC 9051 §5.1: a server MUST prohibit creating an 8-bit mailbox name that is not
              // Net-Unicode (RFC 5198), which requires NFC. Names are stored as raw octets, so a
              // denormalised spelling would be a SECOND mailbox that renders identically to the
              // first in every client — mail filed into one is invisible in the other, and a
              // client that normalises its own input (macOS yields NFD) cannot SELECT the folder
              // it can see in LIST. We reject rather than silently rewriting, which keeps the
              // byte-transparent stance: what a client stores is what it gets back.
              write(sock, `${tag} NO [CANNOT] mailbox name must be Unicode NFC (RFC 9051 §5.1)`);
            } else if (connCatalog.create(name) === undefined) {
              write(sock, `${tag} NO mailbox already exists`);
            } else {
              write(sock, `${tag} OK CREATE completed`);
            }
            break;
          }
          case 'DELETE': {
            // RFC 9051 §6.3.4. INBOX cannot be deleted; a deleted mailbox must not be
            // the selected one silently — but we keep it simple and let a client that
            // deleted its selected mailbox carry on (SELECT elsewhere).
            const name = qarg(1);
            if (connCatalog.delete === undefined || !connCatalog.delete(name)) {
              write(sock, `${tag} NO cannot delete mailbox (absent, or it is INBOX)`);
            } else {
              if (selectedName === canonicalMailboxName(name)) {
                selected = null;
                selectedName = null;
              }
              write(sock, `${tag} OK DELETE completed`);
            }
            break;
          }
          case 'RENAME': {
            // RFC 9051 §6.3.5. qarg(1)=existing name, qarg(2)=new name (quote-aware).
            // The §5.1 Net-Unicode rule is about what names may EXIST, so it gates both doors that
            // create one — guarding CREATE alone would let RENAME put a denormalised name in the
            // catalog by the back door.
            if (!isNetUnicode(qarg(2))) {
              write(sock, `${tag} NO [CANNOT] mailbox name must be Unicode NFC (RFC 9051 §5.1)`);
              break;
            }
            // Same argument, same door: the length/depth bound is about what names may EXIST,
            // so RENAME has to enforce it too or it is the back way in.
            if (!withinMailboxNameBounds(qarg(2))) {
              write(sock, `${tag} NO [CANNOT] mailbox name too long`);
              break;
            }
            const outcome = connCatalog.rename === undefined ? 'notfound' : connCatalog.rename(qarg(1), qarg(2));
            if (outcome === 'ok') write(sock, `${tag} OK RENAME completed`);
            else if (outcome === 'exists') write(sock, `${tag} NO target mailbox already exists`);
            else write(sock, `${tag} NO no such mailbox`);
            break;
          }
          case 'STATUS': {
            const name = qarg(1);
            const box = connCatalog.get(name);
            if (box === undefined) {
              write(sock, `${tag} NO no such mailbox`);
              break;
            }
            const wanted = line
              .slice(line.indexOf('(') + 1, line.lastIndexOf(')'))
              .split(/\s+/)
              .map((w) => w.toUpperCase())
              .filter((w) => w.length > 0);
            // Canonical name, for the same reason as SELECT's untagged LIST above.
            write(sock, `* STATUS ${imapMailboxAstring(canonicalMailboxName(name))} (${statusItems(box, wanted).join(' ')})`);
            write(sock, `${tag} OK STATUS completed`);
            break;
          }
          case 'APPEND': {
            // APPEND "name" [(\Flags)] ["date"] {n} — the literal octets follow.
            //
            // Each separator is ONE literal space, not `\s+`/`\s*`, and that is load-bearing
            // rather than pedantic. §6.3.12's grammar is
            //   append = "APPEND" SP mailbox [SP flag-list] [SP date-time] SP literal
            // i.e. exactly one SP between components. The previous spelling had three
            // quantified whitespace runs separated by two OPTIONAL groups, so when the trailing
            // `{n}` failed to match, the engine tried every way of splitting the whitespace
            // across those boundaries — cubic backtracking. `APPEND x` + 6 KB of tabs + `Z`
            // took 42 seconds, and the 64 KiB command-line cap (which is calibrated for a
            // LINEAR parser) left room for hours of it, on the single event loop that also
            // serves SMTP, submission and every other IMAP session. A byte cap is not a guard
            // against a super-linear matcher; the matcher has to be linear.
            const m = /^APPEND ("[^"]*"|\S+)(?: \(([^)]*)\))?(?: "([^"]*)")? \{(\d+)(\+)?\}$/i.exec(line.slice(tag.length + 1));
            if (m === null) {
              write(sock, `${tag} BAD APPEND syntax`);
              break;
            }
            // Validate flag/keyword tokens against the flag ABNF (atom chars), matching STORE
            // (which uses /\\?[\w$.-]+/). Without this, APPEND accepted `"`/`(` in a flag; the
            // token is stored verbatim and later echoed into `* FETCH (FLAGS (…))` / the SELECT
            // `* FLAGS (…)` line, producing malformed atoms/unbalanced parens that desync a client.
            const flagTokens = (m[2] ?? '').split(/\s+/).filter((f) => f.length > 0);
            if (flagTokens.some((f) => !/^\\?[\w$.-]+$/.test(f))) {
              write(sock, `${tag} BAD APPEND flag syntax`);
              break;
            }
            const flags = flagTokens.map(canonicalFlag);
            // RFC 9051 §6.3.12: use the client-supplied date-time as INTERNALDATE when
            // present (mail restore/migration relies on it); otherwise stamp now.
            const appendDate = m[3] !== undefined ? parseImapDateTime(m[3]) : null;
            const internalDate = appendDate ?? Date.now();
            const size = Number(m[4]);
            // Cap the literal so an APPEND can't make the server buffer an
            // unbounded blob (a one-command OOM). A synchronizing literal waits
            // for our "+", so refusing it means the client never sends the data;
            // a non-synchronizing literal is already streaming, so drop the link.
            if (size > this.#maxAppendLiteral) {
              write(sock, `${tag} NO [LIMIT] APPEND literal exceeds the ${this.#maxAppendLiteral}-octet limit`);
              if (m[5] !== undefined) {
                sock.end();
                return;
              }
              break;
            }
            // Reserve the literal against the server-wide in-flight budget BEFORE the "+" go-ahead,
            // so many slow uploaders cannot pin memory without bound (docs/PERFORMANCE.md). A
            // synchronizing literal is refused with a transient NO (the client never sends the data
            // and may retry); a non-synchronizing literal is already streaming, so drop the link.
            if (!this.#reserveAppend(sock, authedLogin, size)) {
              write(sock, `${tag} NO [LIMIT] too much APPEND data in flight; retry shortly`);
              if (m[5] !== undefined) {
                sock.end();
                return;
              }
              break;
            }
            pendingAppend = { tag, mailboxName: unquote(m[1]!), flags, internalDate, size };
            // A synchronizing literal ({n}) waits for the go-ahead; {n+} does not.
            if (m[5] === undefined) write(sock, '+ Ready for literal data');
            break;
          }
          case 'LOGIN': {
            // Quote-aware: a username or (commonly) a passphrase may be a quoted string
            // containing spaces — a plain split(' ') would truncate the password.
            const user = qarg(1);
            const pass = qarg(2);
            if (authBlocked()) {
              // Too many recent failures from this IP — refuse without checking the password.
              write(sock, `${tag} NO [UNAVAILABLE] too many failed attempts, try again later`);
            } else if (this.#authenticate !== undefined && !this.#authenticate(user, pass)) {
              noteAuthFailure(user);
              write(sock, `${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
            } else if (!bindAccount(user)) {
              // Credentials verified but the account is unknown or disabled (multi-account mode).
              noteAuthFailure(user);
              write(sock, `${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
            } else {
              noteAuthSuccess();
              authenticated = true;
              write(sock, `${tag} OK [CAPABILITY ${CAPABILITIES}] LOGIN completed`);
            }
            break;
          }
          case 'AUTHENTICATE': {
            // SASL (RFC 9051 §6.2.2). We offer PLAIN only, and only sensibly over TLS
            // — which production is (IMAPS). PLAIN carries an optional initial response
            // (RFC 4959): "AUTHENTICATE PLAIN <base64>"; otherwise we send a "+"
            // challenge and read the base64 on the next line.
            if (arg(1).toUpperCase() !== 'PLAIN') {
              write(sock, `${tag} NO [CANNOT] unsupported SASL mechanism`);
              break;
            }
            if (authBlocked()) {
              write(sock, `${tag} NO [UNAVAILABLE] too many failed attempts, try again later`);
              break;
            }
            const ir = arg(2);
            if (ir === '') {
              pendingAuth = tag;
              write(sock, '+ ');
            } else if (!isValidBase64(ir)) {
              // The same §6.2.2 rule on the RFC 4959 initial-response form. Mirrored deliberately:
              // a gate on one path and not its structural sibling is this project's most-repeated
              // defect, and an inline `AUTHENTICATE PLAIN <garbage>` is the same protocol error as
              // a garbage continuation line.
              if (tooManyBadCommands()) return;
              write(sock, `${tag} BAD invalid base64 in AUTHENTICATE initial response`);
            } else {
              const authedUser = this.#saslPlainUser(ir);
              if (authedUser !== null && bindAccount(authedUser)) {
                noteAuthSuccess();
                authenticated = true;
                write(sock, `${tag} OK [CAPABILITY ${CAPABILITIES}] authenticated`);
              } else {
                noteAuthFailure();
                write(sock, `${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
              }
            }
            break;
          }
          case 'SELECT':
          case 'EXAMINE': {
            // RFC 7162 §3.2.5: a (QRESYNC …) select parameter is a tagged BAD unless the
            // client issued ENABLE QRESYNC first. Checked before anything is selected.
            if (/QRESYNC\s*\(/i.test(line) && !qresync) {
              write(sock, `${tag} BAD QRESYNC parameter used without ENABLE QRESYNC`);
              break;
            }
            // RFC 9051 §6.3.2 MUST: "When deselecting a selected mailbox, the server MUST return an
            // untagged OK with a [CLOSED] response code." SELECT/EXAMINE deselects whatever was
            // selected — even when the new SELECT then fails on a missing mailbox — so emit CLOSED
            // before any of the new mailbox's untagged responses. CLOSE/UNSELECT do NOT emit it
            // (their response is the tagged OK alone). A BAD (bad QRESYNC syntax, handled above)
            // does not deselect, so no CLOSED there either.
            if (selected !== null) write(sock, '* OK [CLOSED] previous mailbox closed');
            const name = qarg(1) || 'INBOX';
            const box = connCatalog.get(name);
            if (box === undefined) {
              // RFC 9051 §6.3.2: a failed SELECT/EXAMINE deselects — the client is left
              // with NO mailbox selected, not still holding the previous one.
              selected = null;
              selectedName = null;
              readOnly = false;
              knownUids = [];
              knownFlags = new Map();
              write(sock, `${tag} NO no such mailbox`);
              break;
            }
            selected = box;
            selectedName = canonicalMailboxName(name);
            // SELECT/EXAMINE (CONDSTORE) enables CONDSTORE for the rest of the session
            // (RFC 7162 §3.1.8). It stays enabled across later selects.
            if (/\(\s*CONDSTORE\s*\)/i.test(line)) condstore = true;
            // Snapshot the mailbox this connection now sees, so later NOOP/CHECK/IDLE
            // can tell it what other connections expunged, delivered, or re-flagged
            // (RFC 9051 §7.4.1).
            const selIdx = box.index();
            knownUids = selIdx.map((m) => m.uid);
            knownFlags = new Map(selIdx.map((m) => [m.uid, flagKey(m.flags)]));
            // EXAMINE opens read-only (RFC 9051 §6.3.2): no flag changes, no EXPUNGE.
            readOnly = cmd === 'EXAMINE';
            // RFC 9051 §6.3.2 REQUIRED: the SELECT/EXAMINE response set includes an untagged LIST
            // for the mailbox being opened (rev2 folded the old mailbox-identity responses into it).
            // Echo the CANONICAL name, not the client's spelling: `SELECT inbox` answering
            // `* LIST ... "inbox"` while LIST reports `INBOX` gives a client keying its folder
            // cache on the response two entries for one mailbox (RFC 9051 §6.3.2's examples echo
            // INBOX). The attributes were already computed from the canonical name.
            write(sock, `* LIST ${listAttributes(selectedName, connCatalog.listNames())} "/" ${imapMailboxAstring(selectedName)}`);
            write(sock, `* ${selIdx.length} EXISTS`);
            // FLAGS lists the system flags plus every keyword currently in use in this mailbox
            // (RFC 9051 §7.1) — a keyword is any flag without a leading backslash (Thunderbird
            // tags: $Label1, $Forwarded). Surfacing them tells a reconnecting client its tags are
            // real, live flags.
            const SYSTEM_FLAGS = '\\Seen \\Answered \\Flagged \\Deleted \\Draft';
            const keywords = [...new Set(selIdx.flatMap((m) => [...m.flags]).filter((f) => !f.startsWith('\\')))].sort();
            write(sock, `* FLAGS (${keywords.length > 0 ? `${SYSTEM_FLAGS} ${keywords.join(' ')}` : SYSTEM_FLAGS})`);
            // PERMANENTFLAGS (RFC 9051 §7.1): a read-write mailbox advertises the settable system
            // flags AND `\*`, the signal that the client MAY create new keywords and they persist —
            // the server does durably store arbitrary keywords, so without `\*` a conformant client
            // (Thunderbird tagging) concludes its keywords will be lost and never stores them.
            // A read-only (EXAMINE) mailbox advertises none: nothing can be changed.
            write(sock, `* OK [PERMANENTFLAGS (${readOnly ? '' : `${SYSTEM_FLAGS} \\*`})] flags stored`);
            write(sock, `* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid`);
            write(sock, `* OK [UIDNEXT ${box.uidNext}] Predicted next UID`);
            // RFC 7162 §3.1.2.2: a CONDSTORE server MUST send HIGHESTMODSEQ on EVERY
            // successful SELECT/EXAMINE (it is informational — it lets a client discover
            // mod-sequence support without enabling; the MODSEQ FETCH items stay gated on
            // the session having actually enabled CONDSTORE).
            write(sock, `* OK [HIGHESTMODSEQ ${box.highestModseq}] Highest mod-sequence`);
            // SELECT (QRESYNC (uidvalidity modseq [known-uids ...])) — RFC 7162 §3.2.5.1:
            // a reconnecting client hands back the UIDVALIDITY and mod-sequence it last
            // saw; the server replays what changed since, so the client resyncs in one
            // round-trip instead of refetching the mailbox. We use uidvalidity + modseq
            // (+ optional known-uid set); the seq-match optimisation is ignored.
            // Not anchored to a leading "(" so it also matches when QRESYNC follows another
            // select-param, e.g. SELECT INBOX (CONDSTORE QRESYNC (1 20)).
            const qm = /QRESYNC\s*\(\s*(\d+)\s+(\d+)(?:\s+([\d:,*]+))?/i.exec(line);
            if (qm !== null) {
              condstore = true;
              const clientValidity = Number(qm[1]);
              const clientModseq = Number(qm[2]);
              // Only replay if the client's UIDs are still valid; otherwise it must do a
              // full resync (it will, on seeing the unchanged UIDVALIDITY it expected).
              if (clientValidity === box.uidValidity) {
                const knownSet = qm[3] !== undefined ? new Set(parseSequenceSet(qm[3], box.uidNext > 1 ? box.uidNext - 1 : 0)) : undefined;
                const vanished = box.expungedSince(clientModseq, knownSet);
                if (vanished.length > 0) write(sock, `* VANISHED (EARLIER) ${compressSequenceSet(vanished)}`);
                // Flag changes since the client's mod-sequence, as untagged FETCH.
                selIdx.forEach((m, i) => {
                  if (m.modseq > clientModseq && (knownSet === undefined || knownSet.has(m.uid))) {
                    write(sock, `* ${i + 1} FETCH (UID ${m.uid} FLAGS (${[...m.flags].join(' ')}) MODSEQ (${m.modseq}))`);
                  }
                });
              }
            }
            write(sock, `${tag} OK [${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] ${cmd} completed`);
            break;
          }
          case 'FETCH': {
            if (selected === null) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            const set = arg(1);
            // The `$` search-result marker (SEARCHRES, RFC 5182) is a declined-scope extension
            // (ADR 0007): we never fill it, so a FETCH addressing it is a tagged BAD rather than a
            // silent empty result (the set parsed to NaN and matched nothing, lying to the client).
            if (set === '$') {
              write(sock, `${tag} BAD SEARCHRES ($) is not supported`);
              break;
            }
            // A malformed sequence-set ("FETCH abc") is a tagged BAD, not a silent empty OK
            // (RFC 9051 §9 grammar). The old code let parseSequenceSet return nothing and answered
            // OK with no data — indistinguishable from "no matches" to the client.
            if (!isSequenceSet(set)) {
              write(sock, `${tag} BAD FETCH: invalid sequence set`);
              break;
            }
            // Everything after the set is the att spec (may contain spaces).
            const specStart = line.indexOf(set, tag.length) + set.length;
            const spec = line.slice(specStart);
            // (CHANGEDSINCE n) (RFC 7162 §3.1.4.1): return only messages whose
            // mod-sequence exceeds n — a reconnecting client's "what changed?" query. It
            // both enables CONDSTORE and implies the MODSEQ data item.
            const csMatch = /\(\s*CHANGEDSINCE\s+(\d+)(?:\s+VANISHED)?\s*\)/i.exec(spec);
            const changedSince = csMatch ? Number(csMatch[1]) : null;
            // Validate the data items with the CONDSTORE modifier group removed, so CHANGEDSINCE/
            // VANISHED are not mistaken for unknown data items. An unimplemented att (or a mix of
            // known + unknown) is a tagged BAD (RFC 9051 §6.4.5), not a silent FLAGS+UID fallback.
            const attSpec = csMatch ? spec.replace(csMatch[0], ' ') : spec;
            const { atts, ok: attsOk } = parseFetchAtts(attSpec);
            if (!attsOk) {
              write(sock, `${tag} BAD FETCH: unsupported or unknown data item`);
              break;
            }
            if (changedSince !== null || atts.modseq) condstore = true;
            if (condstore) atts.modseq = true; // once enabled, every FETCH carries MODSEQ
            // (CHANGEDSINCE n VANISHED) (RFC 7162 §3.2.5.2): also report, as one
            // VANISHED (EARLIER), the UIDs in the set that were expunged since n — so a
            // reconnecting client learns removals in the same round-trip. The VANISHED
            // modifier is valid ONLY on a UID FETCH and ONLY with CHANGEDSINCE; misuse is
            // a tagged BAD (§3.2.6), not silently ignored.
            const wantsVanished = /\bVANISHED\b/i.test(spec);
            // RFC 7162 §3.2.6: the VANISHED FETCH modifier requires the session to have ENABLEd
            // QRESYNC (not merely CONDSTORE), AND a UID FETCH with CHANGEDSINCE. Any misuse — here
            // including a session that never enabled QRESYNC — is a tagged BAD, not silently ignored.
            if (wantsVanished && (!qresync || !uidMode || changedSince === null)) {
              write(sock, `${tag} BAD VANISHED requires ENABLE QRESYNC with a UID FETCH and CHANGEDSINCE`);
              break;
            }
            if (wantsVanished) {
              const setUids = new Set(parseSequenceSet(set, selected.uidNext > 1 ? selected.uidNext - 1 : 0));
              const vanished = selected.expungedSince(changedSince!, setUids);
              if (vanished.length > 0) write(sock, `* VANISHED (EARLIER) ${compressSequenceSet(vanished)}`);
            }
            // RFC 9051 §6.4.5: a BODY[...] fetch WITHOUT .PEEK sets \Seen as a side
            // effect; BODY.PEEK[...] does not. A client relying on the implicit mark
            // (rather than an explicit STORE) needs this to see the message as read.
            // A read-only (EXAMINE) mailbox never has its flags changed by a fetch.
            const marksSeen = !readOnly && atts.bodySections.some((s) => !s.peek);
            let markedSeen = false;
            for (const { seq, meta } of resolveForConn(set, uidMode)) {
              if (changedSince !== null && meta.modseq <= changedSince) continue;
              this.#emitFetch(sock, seq, meta, atts, uidMode, selected);
              if (marksSeen && !meta.flags.has('\\Seen')) {
                const newFlags = [...meta.flags, '\\Seen'];
                selected.storeFlags(meta.uid, 'add', ['\\Seen']);
                // Tell the client about the flag its fetch just triggered, and record it
                // as our own change so syncSelected does not echo it back to us.
                knownFlags.set(meta.uid, flagKey(newFlags));
                markedSeen = true;
                // After storeFlags, highestModseq is exactly this message's new mod-seq.
                const parts = [`FLAGS (${newFlags.join(' ')})`];
                if (condstore) parts.push(`MODSEQ (${selected.highestModseq})`);
                if (uidMode) parts.push(`UID ${meta.uid}`);
                write(sock, `* ${seq} FETCH (${parts.join(' ')})`);
              }
            }
            // Wake peers so \Seen set by this read propagates (a phone opening a message
            // marks it read on the desktop). Fired after the FETCH, never mid-response.
            if (markedSeen && selectedName !== null) connNotifier?.notify(selectedName);
            write(sock, `${tag} OK FETCH completed`);
            break;
          }
          case 'SEARCH': {
            if (selected === null) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            // Extended SEARCH (RFC 9051 §6.4.4): an optional "RETURN (options)" before
            // the criteria switches the reply to an ESEARCH aggregate (MIN/MAX/ALL/COUNT).
            let criteria = line.slice(line.toUpperCase().indexOf('SEARCH') + 'SEARCH'.length).trim();
            const rm = /^RETURN\s*\(([^)]*)\)\s*/i.exec(criteria);
            let returnOpts: string[] | null = null;
            if (rm !== null) {
              returnOpts = (rm[1] ?? '').trim().split(/\s+/).filter((x) => x.length > 0).map((s) => s.toUpperCase());
              if (returnOpts.length === 0) returnOpts = ['ALL']; // RETURN () defaults to ALL
              // RFC 9051 §6.4.4: "Options that are not defined by extensions the server supports MUST
              // be rejected with a BAD response." We implement MIN/MAX/ALL/COUNT. SAVE (SEARCHRES,
              // the `$` marker) is a deliberate declined-scope decision (ADR 0007's curated-extension
              // stance) — so RETURN (SAVE) and any unknown option (RETURN (BOGUS)) are a BAD, never
              // silently ignored (which would leave a client waiting for a `$` we will never fill).
              const KNOWN_RETURN = new Set(['MIN', 'MAX', 'ALL', 'COUNT']);
              if (returnOpts.some((o) => !KNOWN_RETURN.has(o))) {
                write(sock, `${tag} BAD SEARCH: unsupported RETURN option`);
                break;
              }
              criteria = criteria.slice(rm[0].length);
            }
            const sel = selected;
            const msgs = sel.index();
            const largestUid = msgs.length > 0 ? msgs[msgs.length - 1]!.uid : 0;
            const keys = parseSearchKeys(imapTokens(criteria), { largestUid, count: knownUids.length });
            if (keys === null) {
              // An unsupported/malformed key: answer BAD rather than run a partial
              // search that would return wrong (or inverted) results.
              write(sock, `${tag} BAD SEARCH: unsupported or malformed search criteria`);
              break;
            }
            // Whether the criteria use the CONDSTORE MODSEQ key — it enables CONDSTORE
            // and makes the reply carry the highest mod-sequence among the matches
            // (RFC 7162 §3.1.5).
            const usesModseq = ((): boolean => {
              const chk = (k: SearchKey): boolean =>
                k.type === 'modseq' || (k.type === 'not' && chk(k.key)) || (k.type === 'or' && (chk(k.a) || chk(k.b)));
              return keys.some(chk);
            })();
            if (usesModseq) condstore = true;
            const hits: number[] = [];
            let highestHitModseq = 0;
            // Search the client's known view, so a reported sequence number is the
            // position the client holds — a peer's not-yet-acknowledged EXPUNGE must
            // not renumber results (RFC 9051 §7.4.1). A known message a peer expunged
            // is skipped; a live message the client hasn't been told about yet is not
            // searched until the next boundary announces it.
            const byUidSearch = new Map(msgs.map((m) => [m.uid, m]));
            knownUids.forEach((uid, i) => {
              const m = byUidSearch.get(uid);
              if (m === undefined) return;
              // The body is fetched (and parsed) lazily, and at most once: a metadata-only
              // query (UNSEEN, SINCE, UID, LARGER — size is in meta) never loads a BLOB, so
              // a big flag/date SEARCH stays cheap. Only HEADER/BODY/TEXT criteria pay to
              // stream a message, one row at a time — never the whole mailbox at once.
              let rawCache: Buffer | undefined;
              let headersCache: ReturnType<typeof parseMessage>['headers'] | undefined;
              const getRaw = (): Buffer => (rawCache ??= sel.raw(uid) ?? Buffer.alloc(0));
              const searchable: SearchableMessage = {
                get headers() {
                  return (headersCache ??= parseMessage(getRaw()).headers);
                },
                flags: m.flags,
                internalDate: m.internalDate,
                size: m.size,
                get raw() {
                  return getRaw();
                },
                uid: m.uid,
                seq: i + 1,
                modseq: m.modseq,
              };
              if (matchesSearch(searchable, keys)) {
                hits.push(uidMode ? m.uid : i + 1);
                if (m.modseq > highestHitModseq) highestHitModseq = m.modseq;
              }
            });
            // ESEARCH aggregate reply (RFC 9051 §7.3.4 / §6.4.4). Emitted for an explicit RETURN
            // search ALWAYS (even on zero hits — the correlator TAG is the whole point of ESEARCH),
            // and for a plain SEARCH once the session has ENABLEd IMAP4rev2 (its default result
            // option is ALL). An un-ENABLEd session still gets the legacy `* SEARCH`.
            const emitEsearch = (opts: readonly string[]): void => {
              const parts: string[] = [`(TAG "${tag}")`];
              if (uidMode) parts.push('UID');
              if (opts.includes('MIN') && hits.length > 0) parts.push(`MIN ${hits[0]}`);
              if (opts.includes('MAX') && hits.length > 0) parts.push(`MAX ${hits[hits.length - 1]}`);
              if (opts.includes('ALL') && hits.length > 0) parts.push(`ALL ${compressSequenceSet(hits)}`);
              if (opts.includes('COUNT')) parts.push(`COUNT ${hits.length}`);
              // RFC 7162 §3.1.5: a MODSEQ search returns the highest mod-seq among matches.
              if (usesModseq && hits.length > 0) parts.push(`MODSEQ ${highestHitModseq}`);
              write(sock, `* ESEARCH ${parts.join(' ')}`);
            };
            if (returnOpts !== null) {
              emitEsearch(returnOpts);
            } else if (imap4rev2) {
              emitEsearch(['ALL']);
            } else {
              const modseqSuffix = usesModseq && hits.length > 0 ? ` (MODSEQ ${highestHitModseq})` : '';
              write(sock, `* SEARCH${hits.length > 0 ? ' ' + hits.join(' ') : ''}${modseqSuffix}`);
            }
            write(sock, `${tag} OK SEARCH completed`);
            break;
          }
          case 'STORE': {
            if (selected === null) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            if (readOnly) {
              write(sock, `${tag} NO mailbox is read-only (opened with EXAMINE)`);
              break;
            }
            const set = arg(1);
            // Parse the command body after the seq-set so an optional (UNCHANGEDSINCE n)
            // modifier — which sits BETWEEN the set and the +FLAGS op — doesn't shift the
            // positional args (RFC 7162 §3.1.3).
            const body = line.slice(line.indexOf(set, tag.length) + set.length).trim();
            const usMatch = /^\(\s*UNCHANGEDSINCE\s+(\d+)\s*\)\s*/i.exec(body);
            const unchangedSince = usMatch ? Number(usMatch[1]) : null;
            if (unchangedSince !== null) condstore = true;
            const storeBody = usMatch ? body.slice(usMatch[0].length) : body;
            const opRaw = (storeBody.split(/\s+/)[0] ?? '').toUpperCase(); // +FLAGS[.SILENT] etc.
            const silent = opRaw.endsWith('.SILENT');
            const op = silent ? opRaw.slice(0, -'.SILENT'.length) : opRaw;
            // A flag is "\"system-flag or a keyword atom. Keyword atoms include the
            // "$" prefix clients use for tags ($Forwarded, $MDNSent, Thunderbird's
            // $label1..$label5) and chars like . - _ — matching only \w drops the "$"
            // and silently mangles the flag, so a client's tag never round-trips.
            const flagsPart = storeBody.slice(opRaw.length);
            const flags = (flagsPart.match(/\\?[\w$.-]+/g) ?? []).map((f) => canonicalFlag(f.startsWith('\\') ? `\\${f.slice(1)}` : f));
            // Only the three flag operations are defined (RFC 9051 §6.4.6). Anything else
            // — a typo'd op, or an empty set from malformed spacing — must be rejected, not
            // answered OK as if a store happened (silent-accept would lie to the client).
            if (op !== '+FLAGS' && op !== '-FLAGS' && op !== 'FLAGS') {
              write(sock, `${tag} BAD STORE: expected +FLAGS, -FLAGS, or FLAGS`);
              break;
            }
            let storeChanged = false;
            const failed: number[] = []; // seq/uid of messages that failed UNCHANGEDSINCE
            // One transaction for the whole set: a bulk STORE (mark a folder read) is N
            // flag updates, and without this each was its own fsync — ~37 s for a 20k folder
            // on the box, freezing the server (docs/PERFORMANCE.md). The per-message FETCH
            // responses are buffered writes, fast enough to emit inside the transaction.
            const selForStore = selected; // non-null (guarded at case entry); const so the closure keeps the narrowing
            selForStore.transaction(() => {
              const mode = op === '+FLAGS' ? 'add' : op === '-FLAGS' ? 'remove' : 'replace';
              for (const { seq, meta } of resolveForConn(set, uidMode)) {
                // UNCHANGEDSINCE: a message modified since `unchangedSince` is left
                // untouched and reported in the MODIFIED response (optimistic-concurrency
                // guard against a change another client made first).
                if (unchangedSince !== null && meta.modseq > unchangedSince) {
                  failed.push(uidMode ? meta.uid : seq);
                  continue;
                }
                selForStore.storeFlags(meta.uid, mode, flags);
                storeChanged = true;
                // After storeFlags, highestModseq is exactly this message's new mod-seq.
                const newModseq = selForStore.highestModseq;
                // Compute the resulting flag set from the pre-store snapshot rather
                // than re-reading the store — a re-read per message is O(n) each, so a
                // bulk STORE would be O(n²) and stall the single-threaded event loop for
                // seconds. storeFlags stores flags verbatim (dedup only), so this mirrors
                // the persisted result exactly.
                const now = new Set(mode === 'replace' ? [] : meta.flags);
                if (mode === 'remove') for (const f of flags) now.delete(f);
                else for (const f of flags) now.add(f);
                // Record our own change so syncSelected does not later echo it back to us
                // as if a peer had made it.
                knownFlags.set(meta.uid, flagKey(now));
                // A conditional STORE echoes the FETCH even under .SILENT, so the client
                // learns the new MODSEQ it needs for its next UNCHANGEDSINCE (RFC 7162
                // §3.1.3); an unconditional .SILENT store stays silent.
                if (!silent || unchangedSince !== null) {
                  const parts2 = [`FLAGS (${[...now].join(' ')})`];
                  if (condstore) parts2.push(`MODSEQ (${newModseq})`);
                  if (uidMode) parts2.push(`UID ${meta.uid}`);
                  write(sock, `* ${seq} FETCH (${parts2.join(' ')})`);
                }
              }
            });
            // Wake other connections on this mailbox so they pick up the flag change.
            if (storeChanged && selectedName !== null) connNotifier?.notify(selectedName);
            // MODIFIED lists the messages left unchanged because they failed UNCHANGEDSINCE.
            const modified = failed.length > 0 ? `[MODIFIED ${compressSequenceSet(failed)}] ` : '';
            write(sock, `${tag} OK ${modified}STORE completed`);
            break;
          }
          case 'COPY':
          case 'MOVE': {
            if (selected === null) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            // MOVE deletes from the (selected) source, so it is refused on a read-only
            // mailbox; COPY only reads the source and is allowed.
            if (cmd === 'MOVE' && readOnly) {
              write(sock, `${tag} NO mailbox is read-only (opened with EXAMINE)`);
              break;
            }
            const set = arg(1);
            const targetName = unquote(parts.slice(cmdIndex + 2).join(' '));
            const target = connCatalog.get(targetName);
            if (target === undefined) {
              write(sock, `${tag} NO [TRYCREATE] no such mailbox`);
              break;
            }
            // Resolve the set against THIS connection's view (resolveForConn), BEFORE announcing
            // peer changes — so a bare sequence number addresses the message the client meant,
            // and a message a peer expunged is OMITTED, never replaced by whatever slid into its
            // slot (RFC 9051 §7.4.1) — the same rule FETCH/STORE/SEARCH use. COPY/MOVE previously
            // resolved the LIVE list AFTER syncSelected renumbered it, so a concurrent peer
            // EXPUNGE made a sequence COPY/MOVE hit — and, for MOVE, destructively remove — the
            // wrong message.
            const entries = resolveForConn(set, uidMode);
            // Read each body being copied first (one row at a time, never the whole mailbox);
            // a message that vanished from under us is skipped entirely — not copied, and
            // (for MOVE) not expunged — keeping COPYUID's src/dst lists aligned.
            const toCopy: Array<{ uid: number; flags: string[]; internalDate: number; body: Buffer }> = [];
            for (const { meta } of entries) {
              const body = selected.raw(meta.uid);
              if (body === undefined) continue;
              toCopy.push({ uid: meta.uid, flags: [...meta.flags], internalDate: meta.internalDate, body });
            }
            // UIDPLUS COPYUID: report the source and destination UIDs, in order.
            const srcUids: number[] = [];
            const dstUids: number[] = [];
            // One transaction for all appends (and, for MOVE, one for all expunges): COPY/MOVE
            // 1:* was one fsync PER message — ~37 s to archive a 20k folder on the box
            // (docs/PERFORMANCE.md). RFC 9051 §6.4.7: a copy keeps flags AND internal date.
            target.transaction(() => {
              for (const c of toCopy) {
                srcUids.push(c.uid);
                dstUids.push(target.append(c.body, c.flags, c.internalDate));
              }
            });
            const copyuidCode = srcUids.length > 0 ? `[COPYUID ${target.uidValidity} ${srcUids.join(',')} ${dstUids.join(',')}]` : '';
            if (cmd === 'MOVE') {
              // RFC 9051 §6.4.8 (with RFC 6851): the untagged OK [COPYUID] MUST be sent BEFORE the
              // EXPUNGE/VANISHED responses that report the moved messages leaving the source — a
              // client needs the src→dst UID mapping while its cached source UIDs still exist, not
              // after they have been renumbered away. The old code ran syncSelected() (the
              // EXPUNGE/VANISHED) first and only then wrote COPYUID in the tagged OK, the wrong order.
              if (copyuidCode !== '') write(sock, `* OK ${copyuidCode} moved`);
              const selForMove = selected; // non-null (guarded at case entry)
              selForMove.transaction(() => {
                for (const uid of srcUids) selForMove.expunge(uid);
              });
              // Now announce the removals (our own + any peer's) in one consistent renumber against
              // the client's view (VANISHED under QRESYNC, else descending EXPUNGE).
              syncSelected();
              if (dstUids.length > 0) connNotifier?.notify(canonicalMailboxName(targetName));
              if (srcUids.length > 0 && selectedName !== null) connNotifier?.notify(selectedName);
              write(sock, `${tag} OK ${cmd} completed`);
            } else {
              // COPY leaves the source in place, so it has no EXPUNGEs of its own; UIDPLUS returns
              // COPYUID in the tagged OK (RFC 9051 §6.4.7). syncSelected() still relays any peer
              // change first.
              syncSelected();
              if (dstUids.length > 0) connNotifier?.notify(canonicalMailboxName(targetName));
              write(sock, `${tag} OK ${copyuidCode !== '' ? copyuidCode + ' ' : ''}${cmd} completed`);
            }
            break;
          }
          case 'EXPUNGE': {
            if (selected === null) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            if (readOnly) {
              write(sock, `${tag} NO mailbox is read-only (opened with EXAMINE)`);
              break;
            }
            // UID EXPUNGE (RFC 4315) REQUIRES a sequence set in its grammar. A bare `UID EXPUNGE`
            // (or one with a malformed set) must be a tagged BAD — the old code silently fell
            // through to a FULL EXPUNGE of every \Deleted message, a dangerous over-removal never
            // the client asked for. Plain (non-UID) EXPUNGE takes no set and is unaffected.
            if (uidMode && !isSequenceSet(arg(1))) {
              write(sock, `${tag} BAD UID EXPUNGE requires a sequence set`);
              break;
            }
            // Reconcile any peer changes FIRST (EXPUNGE responses are permitted during an
            // EXPUNGE command, RFC 9051 §7.4.1), so our own sequence numbers are computed
            // against a view the client agrees with and no peer removal is swallowed.
            syncSelected();
            const before = selected.index().map((m) => ({ uid: m.uid, deleted: m.flags.has('\\Deleted') }));
            // UID EXPUNGE <set> (RFC 4315): restrict to \Deleted messages within
            // the set; plain EXPUNGE removes every \Deleted message.
            let removedUids: Set<number>;
            if (uidMode && arg(1) !== '') {
              const inSet = new Set(this.#resolveSet(selected, arg(1), true).map((e) => e.meta.uid));
              removedUids = new Set(before.filter((m) => m.deleted && inSet.has(m.uid)).map((m) => m.uid));
              // One transaction for the whole UID EXPUNGE set (plain EXPUNGE is already batched
              // in expungeDeleted) — otherwise one fsync per removed message (docs/PERFORMANCE.md).
              const selForExpunge = selected; // non-null (guarded at case entry)
              selForExpunge.transaction(() => {
                for (const uid of removedUids) selForExpunge.expunge(uid);
              });
            } else {
              removedUids = new Set(selected.expungeDeleted());
            }
            // VANISHED (QRESYNC) or descending-sequence EXPUNGE so the client's numbering
            // stays consistent.
            const seqs = before.map((m, i) => ({ uid: m.uid, seq: i + 1 })).filter((e) => removedUids.has(e.uid));
            emitExpunged([...removedUids], seqs.reverse().map((e) => e.seq));
            // We just told this client about these removals; keep its view in step so a
            // later NOOP/CHECK does not re-announce them as if another connection acted.
            knownUids = selected.index().map((m) => m.uid);
            // Wake other connections idling on this mailbox so they drop the same messages.
            if (removedUids.size > 0 && selectedName !== null) connNotifier?.notify(selectedName);
            write(sock, `${tag} OK EXPUNGE completed`);
            break;
          }
          case 'IDLE': {
            // RFC 2177: hold the connection and push untagged EXISTS as the
            // mailbox changes, until the client sends DONE.
            if (selected === null || selectedName === null) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            if (connNotifier === undefined) {
              write(sock, `${tag} NO IDLE unavailable`);
              break;
            }
            const name = selectedName;
            // While idling, any change another connection makes to this mailbox
            // (delivery or expunge) reconciles this connection's view in real time,
            // emitting untagged EXPUNGE/EXISTS just as at a command boundary.
            const unsub = connNotifier.subscribe(name, () => {
              syncSelected();
            });
            idle = { tag, unsub };
            write(sock, '+ idling');
            break;
          }
          case 'CLOSE': {
            // Expunge silently and deselect (RFC 9051 §6.4.2) — but a read-only
            // (EXAMINE) mailbox is never expunged, just deselected.
            const closedName = selectedName;
            const removed = selected !== null && !readOnly ? selected.expungeDeleted() : [];
            // No EXPUNGE goes to us (we are deselecting), but peers on this mailbox must
            // still learn the messages vanished.
            if (removed.length > 0 && closedName !== null) connNotifier?.notify(closedName);
            selected = null;
            selectedName = null;
            readOnly = false;
            knownUids = [];
            knownFlags = new Map();
            write(sock, `${tag} OK CLOSE completed`);
            break;
          }
          case 'UNSELECT':
            // RFC 9051 §6.4.2: deselect WITHOUT expunging (the difference from CLOSE).
            selected = null;
            selectedName = null;
            readOnly = false;
            knownUids = [];
            knownFlags = new Map();
            write(sock, `${tag} OK UNSELECT completed`);
            break;
          case 'CHECK':
            // RFC 9051 §6.4.1: a mailbox checkpoint. We buffer nothing, so it is a no-op
            // beyond reconciling changes other connections made (a command boundary).
            if (selected === null) write(sock, `${tag} BAD no mailbox selected`);
            else {
              syncSelected();
              write(sock, `${tag} OK CHECK completed`);
            }
            break;
          case 'ENABLE': {
            // RFC 9051 §6.3.1: "The ENABLE command is only valid in the authenticated state, before
            // any mailbox is selected." Issued with a mailbox selected it is a tagged BAD — a client
            // that has already SELECTed cannot change the enabled-extension set mid-session.
            if (selected !== null) {
              write(sock, `${tag} BAD ENABLE not permitted with a mailbox selected`);
              break;
            }
            // Echo back the requested capabilities we support.
            const enabled: string[] = [];
            for (const a of qargs) {
              const u = a.toUpperCase();
              if (u === 'IMAP4REV2') { imap4rev2 = true; enabled.push('IMAP4rev2'); }
              else if (u === 'CONDSTORE') { condstore = true; enabled.push('CONDSTORE'); }
              // QRESYNC (RFC 7162 §3.2.4) implies CONDSTORE and unlocks SELECT (QRESYNC …)
              // plus the VANISHED FETCH modifier.
              else if (u === 'QRESYNC') { qresync = true; condstore = true; enabled.push('QRESYNC'); }
            }
            write(sock, `* ENABLED${enabled.length > 0 ? ' ' + enabled.join(' ') : ''}`);
            write(sock, `${tag} OK ENABLE completed`);
            break;
          }
          case 'LOGOUT':
            write(sock, '* BYE logging out');
            write(sock, `${tag} OK LOGOUT completed`);
            sock.end();
            return;
          case 'NOOP':
            // The client's poll for news: reconcile anything other connections changed
            // in the selected mailbox (RFC 9051 §6.4.1, §7.4.1 — a safe command boundary).
            syncSelected();
            write(sock, `${tag} OK NOOP completed`);
            break;
          default:
            // Mirrors smtp-receiver.ts's MAX_HARD_ERRORS, whose comment applies verbatim here: a
            // peer streaming junk commands holds its connection slot indefinitely and is
            // otherwise bounded only by MAX_CONNECTIONS. IMAP had no such limit, so 50,000
            // malformed commands were answered on one connection while the inactivity timer was
            // reset by every one of them. Pre-auth is stricter (Dovecot drops after 3): a client
            // that cannot even log in has no reason to be issuing unknown verbs.
            if (tooManyBadCommands()) return;
            write(sock, `${tag} BAD command unknown`);
        }
        } catch {
          write(sock, `${tag} BAD internal error handling command`);
        }
      }
    });
  }
}
