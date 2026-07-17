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
 * multi-folder service. INTERNALDATE remains a recorded gap (the store keeps no
 * receive time); if a client visibly needs it, it jumps the queue.
 */

import net from 'node:net';
import tls from 'node:tls';
import { parseMessage } from '../message/parse.ts';
import { buildEnvelope, serializeEnvelope } from '../imap/envelope.ts';
import { matchesSearch, type SearchKey } from '../imap/search.ts';
import { parseSequenceSet } from '../imap/sequence-set.ts';
import { canonicalMailboxName } from '../store/mailbox-name.ts';
import type { MailboxNotifier } from './mailbox-notifier.ts';

export interface ServableMessage {
  readonly uid: number;
  readonly flags: ReadonlySet<string>;
  readonly raw: Buffer;
}

export interface ServableMailbox {
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly messages: readonly ServableMessage[];
  append(raw: Buffer, flags?: readonly string[]): number;
  expunge(uid: number): void;
  storeFlags(uid: number, mode: 'add' | 'remove' | 'replace', flags: readonly string[]): void;
  expungeDeleted(): readonly number[];
}

/** A catalog of named mailboxes (MemoryCatalog / SqliteCatalog satisfy this). */
export interface ServableCatalog {
  listNames(): readonly string[];
  get(name: string): ServableMailbox | undefined;
  /** Create a mailbox; undefined if the name already exists. */
  create(name: string): ServableMailbox | undefined;
}

/** Wrap a bare mailbox as an INBOX-only catalog (the single-mailbox test shape). */
function inboxOnly(mailbox: ServableMailbox): ServableCatalog {
  return {
    listNames: () => ['INBOX'],
    get: (name) => (canonicalMailboxName(name) === 'INBOX' ? mailbox : undefined),
    create: () => undefined,
  };
}

const CAPABILITIES = 'IMAP4rev2 IDLE UIDPLUS';

/** Cap on an APPEND literal's declared size (octets) — bounds server memory. */
const MAX_APPEND_LITERAL = 26_214_400; // 25 MiB, matching the SMTP SIZE default

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

/** Parse SEARCH criteria tokens into typed search keys (the common subset). */
function parseSearchKeys(tokens: readonly string[]): SearchKey[] {
  const keys: SearchKey[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const k = (tokens[i] ?? '').toUpperCase();
    if (k === 'FROM' || k === 'TO' || k === 'SUBJECT') {
      keys.push({ type: k.toLowerCase() as 'from' | 'to' | 'subject', value: unquote(tokens[++i] ?? '') });
    } else if (k === 'SEEN' || k === 'UNSEEN' || k === 'DELETED' || k === 'UNDELETED') {
      keys.push({ type: k.toLowerCase() as 'seen' | 'unseen' | 'deleted' | 'undeleted' });
    }
  }
  return keys;
}

/** Which catalog names a LIST/LSUB pattern matches ("*" / "%" match all at our single level). */
function matchNames(pattern: string, names: readonly string[]): readonly string[] {
  const p = unquote(pattern);
  if (p === '*' || p === '%') return names;
  return names.filter((n) => canonicalMailboxName(p) === n);
}

/** The LIST attribute list for a mailbox name (special-use where conventional). */
function listAttributes(name: string): string {
  const use = SPECIAL_USE[name];
  return use === undefined ? '(\\HasNoChildren)' : `(\\HasNoChildren ${use})`;
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
  bodySections: { section: string; partial?: { origin: number; count: number } }[];
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
    bodySections: [],
  };
  // Pull out BODY[..] / BODY.PEEK[..] first — brackets may contain spaces — with
  // an optional <origin.count> partial specifier (TB: BODY.PEEK[TEXT]<0.2048>).
  const rest = spec.replace(/BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gi, (_m, section: string, origin?: string, count?: string) => {
    atts.bodySections.push(
      origin !== undefined && count !== undefined
        ? { section: section.trim(), partial: { origin: Number(origin), count: Number(count) } }
        : { section: section.trim() },
    );
    return ' ';
  });
  for (const tok of rest.split(/[()\s]+/)) {
    const t = tok.toUpperCase();
    if (t === 'UID') atts.uid = true;
    else if (t === 'FLAGS') atts.flags = true;
    else if (t === 'RFC822.SIZE') atts.size = true;
    else if (t === 'ENVELOPE') atts.envelope = true;
    else if (t === 'RFC822.HEADER') atts.rfc822Header = true;
    else if (t === 'RFC822.TEXT') atts.rfc822Text = true;
    else if (t === 'RFC822' || t === 'RFC822.PEEK') atts.rfc822 = true;
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

/** Extract the named header fields of a message as bytes, per HEADER.FIELDS. */
function headerFields(raw: Buffer, names: readonly string[]): Buffer {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const lines: Buffer[] = [];
  for (const h of parseMessage(raw).headers) {
    if (want.has(h.name.toString('latin1').trim().toLowerCase())) {
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
  readonly size: number;
}

export class ImapServer {
  readonly port: number;
  readonly #server: net.Server;
  readonly #catalog: ServableCatalog;
  readonly #sockets = new Set<net.Socket>();
  readonly #authenticate: ((user: string, pass: string) => boolean) | undefined;
  readonly #notifier: MailboxNotifier | undefined;

  private constructor(server: net.Server, port: number, catalog: ServableCatalog, authenticate?: (user: string, pass: string) => boolean, notifier?: MailboxNotifier) {
    this.#server = server;
    this.port = port;
    this.#catalog = catalog;
    this.#authenticate = authenticate;
    this.#notifier = notifier;
  }

  /**
   * Start the server. `target` is a bare mailbox (served as INBOX only) or a
   * catalog of named mailboxes. With `options.tls` it serves implicit TLS
   * (IMAPS, port 993 in production); otherwise plaintext. With
   * `options.authenticate`, LOGIN is verified against it (else any LOGIN succeeds).
   */
  static start(
    target: ServableMailbox | ServableCatalog,
    options: { tls?: { key: string; cert: string }; host?: string; port?: number; authenticate?: (user: string, pass: string) => boolean; notifier?: MailboxNotifier } = {},
  ): Promise<ImapServer> {
    const catalog: ServableCatalog = 'listNames' in target ? target : inboxOnly(target);
    const server = options.tls !== undefined ? tls.createServer({ key: options.tls.key, cert: options.tls.cert }) : net.createServer();
    return new Promise((resolve) => {
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        const imap = new ImapServer(server, port, catalog, options.authenticate, options.notifier);
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
    if (atts.size) text(`RFC822.SIZE ${msg.raw.length}`);
    if (atts.envelope) text(`ENVELOPE ${serializeEnvelope(buildEnvelope(parseMessage(msg.raw).headers))}`);
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
        const fields = /\(([^)]*)\)/.exec(section)?.[1] ?? '';
        const names = fields.split(/\s+/).filter((f) => f.length > 0);
        name = `BODY[HEADER.FIELDS (${names.map((n) => n.toUpperCase()).join(' ')})]`;
        payload = headerFields(msg.raw, names);
      } else if (up === 'HEADER') {
        name = 'BODY[HEADER]';
        payload = headerBlock(msg.raw);
      } else if (up === 'TEXT') {
        name = 'BODY[TEXT]';
        payload = bodyBlock(msg.raw);
      } else {
        // Unrecognised section (part numbers etc.) — serve the whole body
        // rather than lie with an empty literal.
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
    sock.on('error', () => {});
    sock.on('close', () => idle?.unsub());
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
            const uid = box.append(raw, pendingAppend.flags);
            write(sock, `${pendingAppend.tag} OK [APPENDUID ${box.uidValidity} ${uid}] APPEND completed`);
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
            // LIST "" "" asks for the hierarchy delimiter (RFC 9051 §6.3.9.2).
            const pattern = arg(2);
            if (unquote(pattern) === '') {
              write(sock, '* LIST (\\Noselect) "/" ""');
            } else {
              for (const name of matchNames(pattern, this.#catalog.listNames())) {
                write(sock, `* LIST ${listAttributes(name)} "/" ${name.includes(' ') ? `"${name}"` : name}`);
              }
            }
            write(sock, `${tag} OK LIST completed`);
            break;
          }
          case 'LSUB': {
            // rev2 dropped LSUB; answered like LIST as a deliberate concession to
            // clients that still probe with it during setup.
            for (const name of matchNames(arg(2), this.#catalog.listNames())) {
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
              else if (w === 'RECENT') items.push('RECENT 0');
            }
            write(sock, `* STATUS ${name.includes(' ') ? `"${name}"` : name} (${items.join(' ')})`);
            write(sock, `${tag} OK STATUS completed`);
            break;
          }
          case 'APPEND': {
            // APPEND "name" [(\Flags)] ["date"] {n} — the literal octets follow.
            const m = /^APPEND\s+("[^"]*"|\S+)\s*(?:\(([^)]*)\))?\s*(?:"[^"]*")?\s*\{(\d+)(\+)?\}$/i.exec(line.slice(tag.length + 1));
            if (m === null) {
              write(sock, `${tag} BAD APPEND syntax`);
              break;
            }
            const flags = (m[2] ?? '').split(/\s+/).filter((f) => f.length > 0);
            const size = Number(m[3]);
            // Cap the literal so an APPEND can't make the server buffer an
            // unbounded blob (a one-command OOM). A synchronizing literal waits
            // for our "+", so refusing it means the client never sends the data;
            // a non-synchronizing literal is already streaming, so drop the link.
            if (size > MAX_APPEND_LITERAL) {
              write(sock, `${tag} NO [LIMIT] APPEND literal exceeds the ${MAX_APPEND_LITERAL}-octet limit`);
              if (m[4] !== undefined) {
                sock.end();
                return;
              }
              break;
            }
            pendingAppend = { tag, mailboxName: unquote(m[1]!), flags, size };
            // A synchronizing literal ({n}) waits for the go-ahead; {n+} does not.
            if (m[4] === undefined) write(sock, '+ Ready for literal data');
            break;
          }
          case 'LOGIN': {
            const user = unquote(arg(1));
            const pass = unquote(arg(2));
            if (this.#authenticate !== undefined && !this.#authenticate(user, pass)) {
              write(sock, `${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
            } else {
              write(sock, `${tag} OK [CAPABILITY ${CAPABILITIES}] LOGIN completed`);
            }
            break;
          }
          case 'SELECT':
          case 'EXAMINE': {
            const name = qarg(1) || 'INBOX';
            const box = this.#catalog.get(name);
            if (box === undefined) {
              write(sock, `${tag} NO no such mailbox`);
              break;
            }
            selected = box;
            selectedName = canonicalMailboxName(name);
            write(sock, `* ${box.messages.length} EXISTS`);
            write(sock, '* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
            write(sock, '* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)] flags stored');
            write(sock, `* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid`);
            write(sock, `* OK [UIDNEXT ${box.uidNext}] Predicted next UID`);
            write(sock, `${tag} OK [READ-WRITE] ${cmd} completed`);
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
            const atts = parseFetchAtts(line.slice(specStart));
            for (const { seq, msg } of this.#resolveSet(selected, set, uidMode)) {
              this.#emitFetch(sock, seq, msg, atts, uidMode);
            }
            write(sock, `${tag} OK FETCH completed`);
            break;
          }
          case 'SEARCH': {
            if (selected === null) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            // Tokenise the raw criteria (after the SEARCH verb) respecting quotes,
            // so a quoted multi-word value stays whole.
            const critAt = line.toUpperCase().indexOf('SEARCH') + 'SEARCH'.length;
            const keys = parseSearchKeys(imapTokens(line.slice(critAt)));
            const hits: number[] = [];
            selected.messages.forEach((m, i) => {
              const searchable = { headers: parseMessage(m.raw).headers, flags: m.flags };
              if (matchesSearch(searchable, keys)) hits.push(uidMode ? m.uid : i + 1);
            });
            write(sock, `* SEARCH${hits.length > 0 ? ' ' + hits.join(' ') : ''}`);
            write(sock, `${tag} OK SEARCH completed`);
            break;
          }
          case 'STORE': {
            if (selected === null) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            const set = arg(1);
            const opRaw = arg(2).toUpperCase(); // +FLAGS[.SILENT] / -FLAGS[.SILENT] / FLAGS[.SILENT]
            const silent = opRaw.endsWith('.SILENT');
            const op = silent ? opRaw.slice(0, -'.SILENT'.length) : opRaw;
            const flags = (parts.slice(cmdIndex + 3).join(' ').match(/\\?\w+/g) ?? []).map((f) => (f.startsWith('\\') ? `\\${f.slice(1)}` : f));
            if (op === '+FLAGS' || op === '-FLAGS' || op === 'FLAGS') {
              const mode = op === '+FLAGS' ? 'add' : op === '-FLAGS' ? 'remove' : 'replace';
              for (const { seq, msg } of this.#resolveSet(selected, set, uidMode)) {
                selected.storeFlags(msg.uid, mode, flags);
                if (!silent) {
                  const now = selected.messages.find((m) => m.uid === msg.uid);
                  const uidPart = uidMode ? ` UID ${msg.uid}` : '';
                  write(sock, `* ${seq} FETCH (FLAGS (${now ? [...now.flags].join(' ') : ''})${uidPart})`);
                }
              }
            }
            write(sock, `${tag} OK STORE completed`);
            break;
          }
          case 'COPY':
          case 'MOVE': {
            if (selected === null) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            const set = arg(1);
            const target = this.#catalog.get(unquote(parts.slice(cmdIndex + 2).join(' ')));
            if (target === undefined) {
              write(sock, `${tag} NO [TRYCREATE] no such mailbox`);
              break;
            }
            const entries = this.#resolveSet(selected, set, uidMode);
            // UIDPLUS COPYUID: report the source and destination UIDs, in order.
            const srcUids: number[] = [];
            const dstUids: number[] = [];
            for (const { msg } of entries) {
              srcUids.push(msg.uid);
              dstUids.push(target.append(msg.raw, [...msg.flags]));
            }
            if (cmd === 'MOVE') {
              // Remove from the source, reporting EXPUNGE by descending sequence
              // number so the client's numbering stays consistent (RFC 9051 §6.4.8).
              for (const { seq, msg } of [...entries].sort((a, b) => b.seq - a.seq)) {
                selected.expunge(msg.uid);
                write(sock, `* ${seq} EXPUNGE`);
              }
            }
            const copyuid = srcUids.length > 0 ? `[COPYUID ${target.uidValidity} ${srcUids.join(',')} ${dstUids.join(',')}] ` : '';
            write(sock, `${tag} OK ${copyuid}${cmd} completed`);
            break;
          }
          case 'EXPUNGE': {
            if (selected === null) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
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
            // Report by descending sequence number so the client's numbering stays consistent.
            const seqs = before.map((m, i) => ({ uid: m.uid, seq: i + 1 })).filter((e) => removedUids.has(e.uid));
            for (const e of seqs.reverse()) write(sock, `* ${e.seq} EXPUNGE`);
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
            let lastExists = selected.messages.length;
            const unsub = this.#notifier.subscribe(name, () => {
              const box = this.#catalog.get(name);
              const n = box?.messages.length ?? 0;
              if (n !== lastExists) {
                write(sock, `* ${n} EXISTS`);
                lastExists = n;
              }
            });
            idle = { tag, unsub };
            write(sock, '+ idling');
            break;
          }
          case 'CLOSE':
            // Expunge silently and deselect (RFC 9051 §6.4.2).
            if (selected !== null) selected.expungeDeleted();
            selected = null;
            selectedName = null;
            write(sock, `${tag} OK CLOSE completed`);
            break;
          case 'LOGOUT':
            write(sock, '* BYE logging out');
            write(sock, `${tag} OK LOGOUT completed`);
            sock.end();
            return;
          case 'NOOP':
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
