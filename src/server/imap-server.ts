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
import { matchesSearch, type SearchKey } from '../imap/search.ts';
import { parseSequenceSet } from '../imap/sequence-set.ts';
import { canonicalMailboxName } from '../store/mailbox-name.ts';
import type { MailboxNotifier } from './mailbox-notifier.ts';

export interface ServableMessage {
  readonly uid: number;
  readonly flags: ReadonlySet<string>;
  /** INTERNALDATE as epoch-millis (0 = unknown). Set by the receiver / APPEND. */
  readonly internalDate: number;
  readonly raw: Buffer;
  /** The per-message mod-sequence (RFC 7162 CONDSTORE); monotonic within a mailbox. */
  readonly modseq: number;
}

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
  readonly messages: readonly ServableMessage[];
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

const CAPABILITIES = 'IMAP4rev2 IDLE UIDPLUS SPECIAL-USE CONDSTORE QRESYNC AUTH=PLAIN';

/** Commands allowed before authentication (RFC 9051 §3, Not Authenticated state). */
const PREAUTH_COMMANDS = new Set(['CAPABILITY', 'NOOP', 'LOGOUT', 'LOGIN', 'AUTHENTICATE', 'ID', 'STARTTLS']);

/** Cap on an APPEND literal's declared size (octets) — bounds server memory. */
const MAX_APPEND_LITERAL = 26_214_400; // 25 MiB, matching the SMTP SIZE default

/** Inactivity autologout (RFC 9051 §5.4 requires a timer of at least 30 minutes). */
const AUTOLOGOUT_MS = 1_800_000;

/** Special-use attributes by conventional folder name (RFC 6154 / 9051 §7.3.1). */
const SPECIAL_USE: Record<string, string> = {
  Trash: '\\Trash',
  Sent: '\\Sent',
  Drafts: '\\Drafts',
  Junk: '\\Junk',
  Archive: '\\Archive',
};

/** MAIL_DEBUG=1 logs each received command line (credentials redacted) to stderr. */
const DEBUG = process.env.MAIL_DEBUG === '1';
function debugLog(line: string): void {
  if (!DEBUG) return;
  // Redact the password argument of LOGIN (tag LOGIN user pass).
  const safe = line.replace(/^(\S+\s+LOGIN\s+\S+\s+)\S+/i, '$1***');
  process.stderr.write(`[imap<] ${safe}\n`);
}

const write = (sock: net.Socket, line: string): void => {
  sock.write(Buffer.from(`${line}\r\n`, 'latin1'));
};

const unquote = (s: string): string => s.replace(/^"|"$/g, '');

/**
 * Tokenise an IMAP argument string, keeping a "quoted string" (which may contain
 * spaces) as ONE token — so SEARCH SUBJECT "annual report" searches for the whole
 * phrase, not just "annual". A plain split(' ') breaks quoted multi-word values.
 */
function imapTokens(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && s[i] === ' ') i += 1;
    if (i >= s.length) break;
    if (s[i] === '"') {
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
      i += 1; // skip closing quote
      tokens.push(value);
    } else {
      let j = i;
      while (j < s.length && s[j] !== ' ') j += 1;
      tokens.push(s.slice(i, j));
      i = j;
    }
  }
  return tokens;
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
  const parseOne = (): SearchKey | null => {
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
    const key = parseOne();
    if (key === null) return null;
    keys.push(key);
  }
  return keys;
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
function matchNames(reference: string, pattern: string, names: readonly string[]): readonly string[] {
  const pat = unquote(reference) + unquote(pattern);
  let rx = '';
  for (const ch of pat) {
    if (ch === '*') rx += '.*';
    else if (ch === '%') rx += '[^/]*';
    else rx += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const re = new RegExp(`^${rx}$`);
  return names.filter((n) => re.test(n));
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

/** Parse the text after the sequence-set of a FETCH into the requested atts. */
function parseFetchAtts(spec: string): FetchAtts {
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
  const rest = spec.replace(/BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gi, (_m, peek: string | undefined, section: string, origin?: string, count?: string) => {
    const isPeek = peek !== undefined;
    atts.bodySections.push(
      origin !== undefined && count !== undefined
        ? { section: section.trim(), partial: { origin: Number(origin), count: Number(count) }, peek: isPeek }
        : { section: section.trim(), peek: isPeek },
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
  }
  return atts;
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
  readonly #server: net.Server;
  readonly #catalog: ServableCatalog;
  readonly #sockets = new Set<net.Socket>();
  readonly #authenticate: ((user: string, pass: string) => boolean) | undefined;
  readonly #notifier: MailboxNotifier | undefined;
  readonly #autologoutMs: number;

  private constructor(server: net.Server, port: number, catalog: ServableCatalog, authenticate?: (user: string, pass: string) => boolean, notifier?: MailboxNotifier, autologoutMs = AUTOLOGOUT_MS) {
    this.#server = server;
    this.port = port;
    this.#catalog = catalog;
    this.#authenticate = authenticate;
    this.#notifier = notifier;
    this.#autologoutMs = autologoutMs;
  }

  /**
   * Start the server. `target` is a bare mailbox (served as INBOX only) or a
   * catalog of named mailboxes. With `options.tls` it serves implicit TLS
   * (IMAPS, port 993 in production); otherwise plaintext. With
   * `options.authenticate`, LOGIN is verified against it (else any LOGIN succeeds).
   */
  static start(
    target: ServableMailbox | ServableCatalog,
    options: { tls?: { key: string; cert: string }; host?: string; port?: number; authenticate?: (user: string, pass: string) => boolean; notifier?: MailboxNotifier; autologoutMs?: number } = {},
  ): Promise<ImapServer> {
    const catalog: ServableCatalog = 'listNames' in target ? target : inboxOnly(target);
    const server = options.tls !== undefined ? tls.createServer({ key: options.tls.key, cert: options.tls.cert }) : net.createServer();
    return new Promise((resolve) => {
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        const imap = new ImapServer(server, port, catalog, options.authenticate, options.notifier, options.autologoutMs);
        const event = options.tls !== undefined ? 'secureConnection' : 'connection';
        server.on(event, (sock: net.Socket) => {
          imap.#sockets.add(sock);
          sock.on('close', () => imap.#sockets.delete(sock));
          imap.#handle(sock);
        });
        resolve(imap);
      });
    });
  }

  close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  /**
   * Resolve a sequence-set against a mailbox. In UID mode the set denotes UIDs
   * ("*" = highest UID in use); otherwise message sequence numbers.
   */
  #resolveSet(mailbox: ServableMailbox, set: string, uidMode: boolean): { seq: number; msg: ServableMessage }[] {
    const msgs = mailbox.messages;
    if (msgs.length === 0) return [];
    if (uidMode) {
      const largest = msgs[msgs.length - 1]!.uid;
      const uids = new Set(parseSequenceSet(set, largest));
      return msgs.map((msg, i) => ({ seq: i + 1, msg })).filter((e) => uids.has(e.msg.uid));
    }
    const seqs = parseSequenceSet(set, msgs.length);
    return seqs.filter((s) => s >= 1 && s <= msgs.length).map((s) => ({ seq: s, msg: msgs[s - 1]! }));
  }

  /** Emit one message's FETCH response for the requested atts. */
  /** Verify a SASL PLAIN token ("[authzid]\0authcid\0password", base64). */
  #verifySaslPlain(b64: string): boolean {
    const parts = Buffer.from(b64, 'base64').toString('latin1').split('\0');
    const user = parts[1] ?? '';
    const pass = parts[2] ?? '';
    // No authenticate callback configured = permissive (test servers); still requires
    // the client to actually authenticate, just accepts any credentials.
    return this.#authenticate === undefined || this.#authenticate(user, pass);
  }

  #emitFetch(sock: net.Socket, seq: number, msg: ServableMessage, atts: FetchAtts, uidMode: boolean): void {
    const out: Buffer[] = [];
    let first = true;
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
    if (atts.uid || uidMode) text(`UID ${msg.uid}`);
    if (atts.flags) text(`FLAGS (${[...msg.flags].join(' ')})`);
    if (atts.internalDate) text(`INTERNALDATE "${formatImapDateTime(msg.internalDate)}"`);
    if (atts.size) text(`RFC822.SIZE ${msg.raw.length}`);
    if (atts.modseq) text(`MODSEQ (${msg.modseq})`);
    if (atts.envelope) text(`ENVELOPE ${serializeEnvelope(buildEnvelope(parseMessage(msg.raw).headers))}`);
    if (atts.body) text(`BODY ${bodyResponse(msg.raw)}`);
    if (atts.bodyStructure) text(`BODYSTRUCTURE ${bodyStructureResponse(msg.raw)}`);
    // The legacy RFC822.* items — real Thunderbird fetches RFC822.HEADER for the list.
    if (atts.rfc822Header) literal('RFC822.HEADER', headerBlock(msg.raw));
    if (atts.rfc822Text) literal('RFC822.TEXT', bodyBlock(msg.raw));
    if (atts.rfc822) literal('RFC822', msg.raw);
    for (const { section, partial } of atts.bodySections) {
      const up = section.toUpperCase();
      let name: string;
      let payload: Buffer;
      if (up === '') {
        name = 'BODY[]';
        payload = msg.raw;
      } else if (up.startsWith('HEADER.FIELDS')) {
        const isNot = up.startsWith('HEADER.FIELDS.NOT');
        const fields = /\(([^)]*)\)/.exec(section)?.[1] ?? '';
        const names = fields.split(/\s+/).filter((f) => f.length > 0);
        name = `BODY[HEADER.FIELDS${isNot ? '.NOT' : ''} (${names.map((n) => n.toUpperCase()).join(' ')})]`;
        payload = headerFields(msg.raw, names, isNot);
      } else if (up === 'HEADER') {
        name = 'BODY[HEADER]';
        payload = headerBlock(msg.raw);
      } else if (up === 'TEXT') {
        name = 'BODY[TEXT]';
        payload = bodyBlock(msg.raw);
      } else if (/^\d/.test(up)) {
        // A part specifier: "1", "2.1" (nested), "1.MIME"/"1.HEADER" (the part's
        // headers), "1.TEXT" (its body). Navigate the MIME tree so a client can fetch
        // one attachment (BODY[2]) rather than the whole message.
        const parsed = /^([\d.]+?)(?:\.(MIME|HEADER|TEXT))?$/.exec(up);
        const path = parsed ? parsed[1]!.split('.').map(Number) : [];
        const spec = parsed?.[2];
        const entity = path.length > 0 && !path.some(Number.isNaN) ? resolvePart(msg.raw, path) : null;
        name = `BODY[${up}]`;
        payload = entity === null ? Buffer.alloc(0) : spec === 'MIME' || spec === 'HEADER' ? headerBlock(entity) : bodyBlock(entity);
      } else {
        // Truly unrecognised section — serve the whole body rather than lie with an
        // empty literal.
        name = 'BODY[]';
        payload = msg.raw;
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
      text(`FLAGS (${[...msg.flags].join(' ')})`);
      text(`UID ${msg.uid}`);
    }
    sock.write(Buffer.concat([Buffer.from(`* ${seq} FETCH (`, 'latin1'), ...out, Buffer.from(')\r\n', 'latin1')]));
  }

  #handle(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
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
      const current = selected.messages.map((m) => m.uid);
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
      // view, which now matches selected.messages order (append-only + in-place remove).
      selected.messages.forEach((m, i) => {
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
    const resolveForConn = (set: string, uidMode: boolean): { seq: number; msg: ServableMessage }[] => {
      if (selected === null) return [];
      const live = selected.messages;
      if (uidMode) {
        if (live.length === 0) return [];
        const largest = live[live.length - 1]!.uid;
        const wanted = new Set(parseSequenceSet(set, largest));
        const viewIndex = new Map(knownUids.map((uid, i) => [uid, i + 1]));
        return live.map((msg, i) => ({ seq: viewIndex.get(msg.uid) ?? i + 1, msg })).filter((e) => wanted.has(e.msg.uid));
      }
      const byUid = new Map(live.map((m) => [m.uid, m]));
      const out: { seq: number; msg: ServableMessage }[] = [];
      for (const s of parseSequenceSet(set, knownUids.length)) {
        if (s < 1 || s > knownUids.length) continue;
        const msg = byUid.get(knownUids[s - 1]!);
        if (msg !== undefined) out.push({ seq: s, msg });
      }
      return out;
    };
    // IMAP has three states (RFC 9051 §3); everything except the pre-auth commands
    // requires Authenticated. Without this gate a client could SELECT and FETCH mail
    // with no LOGIN at all. `pendingAuth` holds the tag of an AUTHENTICATE PLAIN that
    // is awaiting its base64 SASL response on the next line.
    let authenticated = false;
    let pendingAuth: string | null = null;
    let readOnly = false; // set when the mailbox was opened with EXAMINE, not SELECT
    sock.on('error', () => {});
    sock.on('close', () => idle?.unsub());
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
          const box = this.#catalog.get(pendingAppend.mailboxName);
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
            this.#notifier?.notify(canonicalMailboxName(pendingAppend.mailboxName));
          }
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
        debugLog(line);

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
          } else if (this.#verifySaslPlain(line.trim())) {
            authenticated = true;
            write(sock, `${authTag} OK [CAPABILITY ${CAPABILITIES}] authenticated`);
          } else {
            write(sock, `${authTag} NO [AUTHENTICATIONFAILED] invalid credentials`);
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
          write(sock, `${tag} NO not authenticated — LOGIN or AUTHENTICATE first`);
          continue;
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
            // [ RETURN (options) ]. A leading "(...)" selection group shifts the
            // reference/pattern positions — parsing them positionally (qarg(2)) turned
            // "LIST (SUBSCRIBED) \"\" *" into an empty pattern and returned no folders.
            // We don't track subscriptions, so SUBSCRIBED lists everything (auto-
            // subscribed) and each match carries \Subscribed. RETURN options are ignored
            // (we always send the attributes anyway).
            let li = 0;
            const selectionOpts = (qargs[li] ?? '').startsWith('(') ? (qargs[li++] ?? '') : '';
            const wantSubscribed = selectionOpts.toUpperCase().includes('SUBSCRIBED');
            // (SPECIAL-USE) selection (RFC 6154 §2): return only mailboxes that carry a
            // special-use attribute (\Sent, \Drafts, \Trash, \Junk, \Archive).
            const onlySpecialUse = selectionOpts.toUpperCase().includes('SPECIAL-USE');
            const reference = qargs[li] ?? '';
            li += 1;
            const pattern = qargs[li] ?? '';
            if (pattern === '') {
              // A bare-root probe: the reference IS a valid mailbox reference.
              write(sock, '* LIST (\\Noselect) "/" ""');
            } else {
              const allNames = this.#catalog.listNames();
              for (const name of matchNames(reference, pattern, allNames)) {
                if (onlySpecialUse && SPECIAL_USE[name] === undefined) continue;
                const attrs = wantSubscribed ? listAttributes(name, allNames).replace(/\)$/, ' \\Subscribed)') : listAttributes(name, allNames);
                write(sock, `* LIST ${attrs} "/" ${name.includes(' ') ? `"${name}"` : name}`);
              }
            }
            write(sock, `${tag} OK LIST completed`);
            break;
          }
          case 'LSUB': {
            // rev2 dropped LSUB; answered like LIST as a deliberate concession to
            // clients that still probe with it during setup.
            for (const name of matchNames(qarg(1), qarg(2), this.#catalog.listNames())) {
              write(sock, `* LSUB () "/" ${name.includes(' ') ? `"${name}"` : name}`);
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
            } else if (this.#catalog.create(name) === undefined) {
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
            if (this.#catalog.delete === undefined || !this.#catalog.delete(name)) {
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
            const outcome = this.#catalog.rename === undefined ? 'notfound' : this.#catalog.rename(qarg(1), qarg(2));
            if (outcome === 'ok') write(sock, `${tag} OK RENAME completed`);
            else if (outcome === 'exists') write(sock, `${tag} NO target mailbox already exists`);
            else write(sock, `${tag} NO no such mailbox`);
            break;
          }
          case 'STATUS': {
            const name = qarg(1);
            const box = this.#catalog.get(name);
            if (box === undefined) {
              write(sock, `${tag} NO no such mailbox`);
              break;
            }
            const wanted = line
              .slice(line.indexOf('(') + 1, line.lastIndexOf(')'))
              .split(/\s+/)
              .map((w) => w.toUpperCase())
              .filter((w) => w.length > 0);
            const items: string[] = [];
            for (const w of wanted) {
              if (w === 'MESSAGES') items.push(`MESSAGES ${box.messages.length}`);
              else if (w === 'UIDNEXT') items.push(`UIDNEXT ${box.uidNext}`);
              else if (w === 'UIDVALIDITY') items.push(`UIDVALIDITY ${box.uidValidity}`);
              else if (w === 'UNSEEN') items.push(`UNSEEN ${box.messages.filter((m) => !m.flags.has('\\Seen')).length}`);
              else if (w === 'SIZE') items.push(`SIZE ${box.messages.reduce((n, m) => n + m.raw.length, 0)}`);
              else if (w === 'DELETED') items.push(`DELETED ${box.messages.filter((m) => m.flags.has('\\Deleted')).length}`);
              else if (w === 'HIGHESTMODSEQ') items.push(`HIGHESTMODSEQ ${box.highestModseq}`); // RFC 7162 §3.1.2.1
              else if (w === 'RECENT') items.push('RECENT 0');
            }
            write(sock, `* STATUS ${name.includes(' ') ? `"${name}"` : name} (${items.join(' ')})`);
            write(sock, `${tag} OK STATUS completed`);
            break;
          }
          case 'APPEND': {
            // APPEND "name" [(\Flags)] ["date"] {n} — the literal octets follow.
            const m = /^APPEND\s+("[^"]*"|\S+)\s*(?:\(([^)]*)\))?\s*(?:"([^"]*)")?\s*\{(\d+)(\+)?\}$/i.exec(line.slice(tag.length + 1));
            if (m === null) {
              write(sock, `${tag} BAD APPEND syntax`);
              break;
            }
            const flags = (m[2] ?? '').split(/\s+/).filter((f) => f.length > 0);
            // RFC 9051 §6.3.12: use the client-supplied date-time as INTERNALDATE when
            // present (mail restore/migration relies on it); otherwise stamp now.
            const appendDate = m[3] !== undefined ? parseImapDateTime(m[3]) : null;
            const internalDate = appendDate ?? Date.now();
            const size = Number(m[4]);
            // Cap the literal so an APPEND can't make the server buffer an
            // unbounded blob (a one-command OOM). A synchronizing literal waits
            // for our "+", so refusing it means the client never sends the data;
            // a non-synchronizing literal is already streaming, so drop the link.
            if (size > MAX_APPEND_LITERAL) {
              write(sock, `${tag} NO [LIMIT] APPEND literal exceeds the ${MAX_APPEND_LITERAL}-octet limit`);
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
            if (this.#authenticate !== undefined && !this.#authenticate(user, pass)) {
              write(sock, `${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
            } else {
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
            const ir = arg(2);
            if (ir === '') {
              pendingAuth = tag;
              write(sock, '+ ');
            } else if (this.#verifySaslPlain(ir)) {
              authenticated = true;
              write(sock, `${tag} OK [CAPABILITY ${CAPABILITIES}] authenticated`);
            } else {
              write(sock, `${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
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
            const name = qarg(1) || 'INBOX';
            const box = this.#catalog.get(name);
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
            knownUids = box.messages.map((m) => m.uid);
            knownFlags = new Map(box.messages.map((m) => [m.uid, flagKey(m.flags)]));
            // EXAMINE opens read-only (RFC 9051 §6.3.2): no flag changes, no EXPUNGE.
            readOnly = cmd === 'EXAMINE';
            write(sock, `* ${box.messages.length} EXISTS`);
            write(sock, '* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
            // Read-only advertises no settable permanent flags.
            write(sock, `* OK [PERMANENTFLAGS (${readOnly ? '' : '\\Seen \\Answered \\Flagged \\Deleted \\Draft'})] flags stored`);
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
                box.messages.forEach((m, i) => {
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
            // Everything after the set is the att spec (may contain spaces).
            const specStart = line.indexOf(set, tag.length) + set.length;
            const spec = line.slice(specStart);
            const atts = parseFetchAtts(spec);
            // (CHANGEDSINCE n) (RFC 7162 §3.1.4.1): return only messages whose
            // mod-sequence exceeds n — a reconnecting client's "what changed?" query. It
            // both enables CONDSTORE and implies the MODSEQ data item.
            const csMatch = /\(\s*CHANGEDSINCE\s+(\d+)(?:\s+VANISHED)?\s*\)/i.exec(spec);
            const changedSince = csMatch ? Number(csMatch[1]) : null;
            if (changedSince !== null || atts.modseq) condstore = true;
            if (condstore) atts.modseq = true; // once enabled, every FETCH carries MODSEQ
            // (CHANGEDSINCE n VANISHED) (RFC 7162 §3.2.5.2): also report, as one
            // VANISHED (EARLIER), the UIDs in the set that were expunged since n — so a
            // reconnecting client learns removals in the same round-trip. The VANISHED
            // modifier is valid ONLY on a UID FETCH and ONLY with CHANGEDSINCE; misuse is
            // a tagged BAD (§3.2.6), not silently ignored.
            const wantsVanished = /\bVANISHED\b/i.test(spec);
            if (wantsVanished && (!uidMode || changedSince === null)) {
              write(sock, `${tag} BAD VANISHED requires UID FETCH with CHANGEDSINCE`);
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
            for (const { seq, msg } of resolveForConn(set, uidMode)) {
              if (changedSince !== null && msg.modseq <= changedSince) continue;
              this.#emitFetch(sock, seq, msg, atts, uidMode);
              if (marksSeen && !msg.flags.has('\\Seen')) {
                const newFlags = [...msg.flags, '\\Seen'];
                selected.storeFlags(msg.uid, 'add', ['\\Seen']);
                // Tell the client about the flag its fetch just triggered, and record it
                // as our own change so syncSelected does not echo it back to us.
                knownFlags.set(msg.uid, flagKey(newFlags));
                markedSeen = true;
                // After storeFlags, highestModseq is exactly this message's new mod-seq.
                const parts = [`FLAGS (${newFlags.join(' ')})`];
                if (condstore) parts.push(`MODSEQ (${selected.highestModseq})`);
                if (uidMode) parts.push(`UID ${msg.uid}`);
                write(sock, `* ${seq} FETCH (${parts.join(' ')})`);
              }
            }
            // Wake peers so \Seen set by this read propagates (a phone opening a message
            // marks it read on the desktop). Fired after the FETCH, never mid-response.
            if (markedSeen && selectedName !== null) this.#notifier?.notify(selectedName);
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
              criteria = criteria.slice(rm[0].length);
            }
            const msgs = selected.messages;
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
              const searchable = { headers: parseMessage(m.raw).headers, flags: m.flags, internalDate: m.internalDate, raw: m.raw, uid: m.uid, seq: i + 1, modseq: m.modseq };
              if (matchesSearch(searchable, keys)) {
                hits.push(uidMode ? m.uid : i + 1);
                if (m.modseq > highestHitModseq) highestHitModseq = m.modseq;
              }
            });
            if (returnOpts !== null) {
              // ESEARCH aggregate reply (RFC 9051 §7.3.4).
              const parts: string[] = [`(TAG "${tag}")`];
              if (uidMode) parts.push('UID');
              if (returnOpts.includes('MIN') && hits.length > 0) parts.push(`MIN ${hits[0]}`);
              if (returnOpts.includes('MAX') && hits.length > 0) parts.push(`MAX ${hits[hits.length - 1]}`);
              if (returnOpts.includes('ALL') && hits.length > 0) parts.push(`ALL ${compressSequenceSet(hits)}`);
              if (returnOpts.includes('COUNT')) parts.push(`COUNT ${hits.length}`);
              // RFC 7162 §3.1.5: a MODSEQ search returns the highest mod-seq among matches.
              if (usesModseq && hits.length > 0) parts.push(`MODSEQ ${highestHitModseq}`);
              write(sock, `* ESEARCH ${parts.join(' ')}`);
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
            const flags = (flagsPart.match(/\\?[\w$.-]+/g) ?? []).map((f) => (f.startsWith('\\') ? `\\${f.slice(1)}` : f));
            // Only the three flag operations are defined (RFC 9051 §6.4.6). Anything else
            // — a typo'd op, or an empty set from malformed spacing — must be rejected, not
            // answered OK as if a store happened (silent-accept would lie to the client).
            if (op !== '+FLAGS' && op !== '-FLAGS' && op !== 'FLAGS') {
              write(sock, `${tag} BAD STORE: expected +FLAGS, -FLAGS, or FLAGS`);
              break;
            }
            let storeChanged = false;
            const failed: number[] = []; // seq/uid of messages that failed UNCHANGEDSINCE
            {
              const mode = op === '+FLAGS' ? 'add' : op === '-FLAGS' ? 'remove' : 'replace';
              for (const { seq, msg } of resolveForConn(set, uidMode)) {
                // UNCHANGEDSINCE: a message modified since `unchangedSince` is left
                // untouched and reported in the MODIFIED response (optimistic-concurrency
                // guard against a change another client made first).
                if (unchangedSince !== null && msg.modseq > unchangedSince) {
                  failed.push(uidMode ? msg.uid : seq);
                  continue;
                }
                selected.storeFlags(msg.uid, mode, flags);
                storeChanged = true;
                // After storeFlags, highestModseq is exactly this message's new mod-seq.
                const newModseq = selected.highestModseq;
                // Compute the resulting flag set from the pre-store snapshot rather
                // than re-reading the store — a re-read per message is O(n) each, so a
                // bulk STORE would be O(n²) and stall the single-threaded event loop for
                // seconds. storeFlags stores flags verbatim (dedup only), so this mirrors
                // the persisted result exactly.
                const now = new Set(mode === 'replace' ? [] : msg.flags);
                if (mode === 'remove') for (const f of flags) now.delete(f);
                else for (const f of flags) now.add(f);
                // Record our own change so syncSelected does not later echo it back to us
                // as if a peer had made it.
                knownFlags.set(msg.uid, flagKey(now));
                // A conditional STORE echoes the FETCH even under .SILENT, so the client
                // learns the new MODSEQ it needs for its next UNCHANGEDSINCE (RFC 7162
                // §3.1.3); an unconditional .SILENT store stays silent.
                if (!silent || unchangedSince !== null) {
                  const parts2 = [`FLAGS (${[...now].join(' ')})`];
                  if (condstore) parts2.push(`MODSEQ (${newModseq})`);
                  if (uidMode) parts2.push(`UID ${msg.uid}`);
                  write(sock, `* ${seq} FETCH (${parts2.join(' ')})`);
                }
              }
            }
            // Wake other connections on this mailbox so they pick up the flag change.
            if (storeChanged && selectedName !== null) this.#notifier?.notify(selectedName);
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
            const target = this.#catalog.get(targetName);
            if (target === undefined) {
              write(sock, `${tag} NO [TRYCREATE] no such mailbox`);
              break;
            }
            // Reconcile peer changes first (EXPUNGE is permitted during COPY/MOVE, RFC
            // 9051 §7.4.1) so the set resolves against, and MOVE's own EXPUNGE numbers
            // match, a view the client agrees with — and no peer removal is swallowed.
            syncSelected();
            const entries = this.#resolveSet(selected, set, uidMode);
            // UIDPLUS COPYUID: report the source and destination UIDs, in order.
            const srcUids: number[] = [];
            const dstUids: number[] = [];
            for (const { msg } of entries) {
              srcUids.push(msg.uid);
              // RFC 9051 §6.4.7: a copied message keeps its flags AND its internal date.
              dstUids.push(target.append(msg.raw, [...msg.flags], msg.internalDate));
            }
            if (cmd === 'MOVE') {
              // Remove from the source, reporting VANISHED (QRESYNC) or EXPUNGE by
              // descending sequence so the client's numbering stays consistent (§6.4.8).
              const descending = [...entries].sort((a, b) => b.seq - a.seq);
              for (const { msg } of descending) selected.expunge(msg.uid);
              emitExpunged(srcUids, descending.map((e) => e.seq));
              knownUids = selected.messages.map((m) => m.uid);
              if (selectedName !== null) this.#notifier?.notify(selectedName);
            }
            // Wake connections idling on the destination (and, for MOVE, the source).
            if (dstUids.length > 0) this.#notifier?.notify(canonicalMailboxName(targetName));
            const copyuid = srcUids.length > 0 ? `[COPYUID ${target.uidValidity} ${srcUids.join(',')} ${dstUids.join(',')}] ` : '';
            write(sock, `${tag} OK ${copyuid}${cmd} completed`);
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
            // Reconcile any peer changes FIRST (EXPUNGE responses are permitted during an
            // EXPUNGE command, RFC 9051 §7.4.1), so our own sequence numbers are computed
            // against a view the client agrees with and no peer removal is swallowed.
            syncSelected();
            const before = selected.messages.map((m) => ({ uid: m.uid, deleted: m.flags.has('\\Deleted') }));
            // UID EXPUNGE <set> (RFC 4315): restrict to \Deleted messages within
            // the set; plain EXPUNGE removes every \Deleted message.
            let removedUids: Set<number>;
            if (uidMode && arg(1) !== '') {
              const inSet = new Set(this.#resolveSet(selected, arg(1), true).map((e) => e.msg.uid));
              removedUids = new Set(before.filter((m) => m.deleted && inSet.has(m.uid)).map((m) => m.uid));
              for (const uid of removedUids) selected.expunge(uid);
            } else {
              removedUids = new Set(selected.expungeDeleted());
            }
            // VANISHED (QRESYNC) or descending-sequence EXPUNGE so the client's numbering
            // stays consistent.
            const seqs = before.map((m, i) => ({ uid: m.uid, seq: i + 1 })).filter((e) => removedUids.has(e.uid));
            emitExpunged([...removedUids], seqs.reverse().map((e) => e.seq));
            // We just told this client about these removals; keep its view in step so a
            // later NOOP/CHECK does not re-announce them as if another connection acted.
            knownUids = selected.messages.map((m) => m.uid);
            // Wake other connections idling on this mailbox so they drop the same messages.
            if (removedUids.size > 0 && selectedName !== null) this.#notifier?.notify(selectedName);
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
            if (this.#notifier === undefined) {
              write(sock, `${tag} NO IDLE unavailable`);
              break;
            }
            const name = selectedName;
            // While idling, any change another connection makes to this mailbox
            // (delivery or expunge) reconciles this connection's view in real time,
            // emitting untagged EXPUNGE/EXISTS just as at a command boundary.
            const unsub = this.#notifier.subscribe(name, () => {
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
            if (removed.length > 0 && closedName !== null) this.#notifier?.notify(closedName);
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
            // RFC 9051 §6.3.1: echo back the requested capabilities we support.
            const enabled: string[] = [];
            for (const a of qargs) {
              const u = a.toUpperCase();
              if (u === 'IMAP4REV2') enabled.push('IMAP4rev2');
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
            write(sock, `${tag} BAD command unknown`);
        }
        } catch {
          write(sock, `${tag} BAD internal error handling command`);
        }
      }
    });
  }
}
