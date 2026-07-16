/**
 * A minimal, live IMAP4rev2 server — the read leg, assembled from the test bed.
 *
 * Serves a mailbox over a socket with the command surface a REAL client uses.
 * The original slice (LOGIN/SELECT/FETCH BODY[]/STORE/SEARCH/EXPUNGE) was enough
 * to prove the round-trip; probing the live deployment with Thunderbird's actual
 * account-setup sequence (2026-07-16) showed what a client additionally demands
 * before it will even show a mailbox:
 *
 *   - CAPABILITY as a command (the first thing every client sends)
 *   - LIST (mailbox discovery — fatal if missing), NAMESPACE (rev2 base)
 *   - the UID variants of FETCH/STORE/SEARCH (clients sync exclusively by UID)
 *   - sequence-sets ("1:*") and multi-att FETCH, including RFC822.SIZE and
 *     BODY.PEEK[HEADER.FIELDS (...)] for header-only sync
 *   - ID (answered NIL) and LSUB (rev2 dropped it; answered like LIST as a
 *     deliberate client-compat concession)
 *
 * One mailbox (INBOX) — the single-account scope. It takes any object exposing
 * the mailbox read surface, so it serves either the reference Mailbox or the
 * SQLite-backed one. INTERNALDATE is deliberately not implemented yet: the
 * store does not record receive time; if a real client turns out to need it,
 * that failure jumps the queue.
 */

import net from 'node:net';
import tls from 'node:tls';
import { parseMessage } from '../message/parse.ts';
import { buildEnvelope, serializeEnvelope } from '../imap/envelope.ts';
import { matchesSearch, type SearchKey } from '../imap/search.ts';
import { parseSequenceSet } from '../imap/sequence-set.ts';

export interface ServableMessage {
  readonly uid: number;
  readonly flags: ReadonlySet<string>;
  readonly raw: Buffer;
}

export interface ServableMailbox {
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly messages: readonly ServableMessage[];
  storeFlags(uid: number, mode: 'add' | 'remove' | 'replace', flags: readonly string[]): void;
  expungeDeleted(): readonly number[];
}

const CAPABILITIES = 'IMAP4rev2';

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

/** Does a LIST pattern match INBOX? ("*" and "%" match everything at our single level.) */
function patternMatchesInbox(pattern: string): boolean {
  const p = unquote(pattern);
  if (p === '*' || p === '%') return true;
  return p.toUpperCase() === 'INBOX';
}

/**
 * The FETCH items a request asks for. `bodySections` carries each requested
 * BODY[...]/BODY.PEEK[...] section verbatim (e.g. "HEADER.FIELDS (FROM TO)").
 */
interface FetchAtts {
  uid: boolean;
  flags: boolean;
  size: boolean;
  envelope: boolean;
  bodySections: string[];
}

/** Parse the text after the sequence-set of a FETCH into the requested atts. */
function parseFetchAtts(spec: string): FetchAtts {
  const atts: FetchAtts = { uid: false, flags: false, size: false, envelope: false, bodySections: [] };
  // Pull out BODY[..] / BODY.PEEK[..] first — their brackets may contain spaces.
  const rest = spec.replace(/BODY(?:\.PEEK)?\[([^\]]*)\]/gi, (_m, section: string) => {
    atts.bodySections.push(section.trim());
    return ' ';
  });
  for (const tok of rest.split(/[()\s]+/)) {
    const t = tok.toUpperCase();
    if (t === 'UID') atts.uid = true;
    else if (t === 'FLAGS') atts.flags = true;
    else if (t === 'RFC822.SIZE') atts.size = true;
    else if (t === 'ENVELOPE') atts.envelope = true;
    else if (t === 'RFC822') atts.bodySections.push('');
  }
  return atts;
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

export class ImapServer {
  readonly port: number;
  readonly #server: net.Server;
  readonly #mailbox: ServableMailbox;
  readonly #sockets = new Set<net.Socket>();
  readonly #authenticate: ((user: string, pass: string) => boolean) | undefined;

  private constructor(server: net.Server, port: number, mailbox: ServableMailbox, authenticate?: (user: string, pass: string) => boolean) {
    this.#server = server;
    this.port = port;
    this.#mailbox = mailbox;
    this.#authenticate = authenticate;
  }

  /**
   * Start the server. With `options.tls` it serves implicit TLS (IMAPS, port 993 in
   * production — what Thunderbird and Apple Mail use); otherwise plaintext. With
   * `options.authenticate`, LOGIN is verified against it (else any LOGIN succeeds).
   */
  static start(
    mailbox: ServableMailbox,
    options: { tls?: { key: string; cert: string }; host?: string; port?: number; authenticate?: (user: string, pass: string) => boolean } = {},
  ): Promise<ImapServer> {
    const server = options.tls !== undefined ? tls.createServer({ key: options.tls.key, cert: options.tls.cert }) : net.createServer();
    return new Promise((resolve) => {
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        const imap = new ImapServer(server, port, mailbox, options.authenticate);
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
   * Resolve a sequence-set to messages. In UID mode the set denotes UIDs
   * ("*" = highest UID in use); otherwise message sequence numbers.
   */
  #resolveSet(set: string, uidMode: boolean): { seq: number; msg: ServableMessage }[] {
    const msgs = this.#mailbox.messages;
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
    for (const section of atts.bodySections) {
      const up = section.toUpperCase();
      const headerEnd = msg.raw.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
      if (up === '') {
        literal('BODY[]', msg.raw);
      } else if (up.startsWith('HEADER.FIELDS')) {
        const fields = /\(([^)]*)\)/.exec(section)?.[1] ?? '';
        const names = fields.split(/\s+/).filter((f) => f.length > 0);
        literal(`BODY[HEADER.FIELDS (${names.map((n) => n.toUpperCase()).join(' ')})]`, headerFields(msg.raw, names));
      } else if (up === 'HEADER') {
        literal('BODY[HEADER]', headerEnd === -1 ? msg.raw : msg.raw.subarray(0, headerEnd + 4));
      } else if (up === 'TEXT') {
        literal('BODY[TEXT]', headerEnd === -1 ? Buffer.alloc(0) : msg.raw.subarray(headerEnd + 4));
      } else {
        // Unrecognised section (part numbers etc.) — serve the whole body
        // rather than lie with an empty literal.
        literal('BODY[]', msg.raw);
      }
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
    let selected = false;
    sock.on('error', () => {});
    write(sock, `* OK [CAPABILITY ${CAPABILITIES}] server ready`);

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      for (;;) {
        const nl = buf.indexOf(Buffer.from([0x0d, 0x0a]));
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString('latin1');
        buf = buf.subarray(nl + 2);
        debugLog(line);
        const parts = line.split(' ');
        const tag = parts[0] ?? '';

        // The UID prefix runs FETCH/STORE/SEARCH addressed by UID instead of
        // sequence number (RFC 9051 §6.4.9). Normalise, then dispatch once.
        let uidMode = false;
        let cmdIndex = 1;
        if ((parts[1] ?? '').toUpperCase() === 'UID') {
          uidMode = true;
          cmdIndex = 2;
        }
        const cmd = (parts[cmdIndex] ?? '').toUpperCase();
        const arg = (n: number): string => parts[cmdIndex + n] ?? '';

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
            } else if (patternMatchesInbox(pattern)) {
              write(sock, '* LIST (\\HasNoChildren) "/" INBOX');
            }
            write(sock, `${tag} OK LIST completed`);
            break;
          }
          case 'LSUB': {
            // rev2 dropped LSUB; answered like LIST as a deliberate concession to
            // clients that still probe with it during setup.
            if (patternMatchesInbox(arg(2))) write(sock, '* LSUB () "/" INBOX');
            write(sock, `${tag} OK LSUB completed`);
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
            const msgs = this.#mailbox.messages;
            write(sock, `* ${msgs.length} EXISTS`);
            write(sock, '* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
            write(sock, '* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)] flags stored');
            write(sock, `* OK [UIDVALIDITY ${this.#mailbox.uidValidity}] UIDs valid`);
            write(sock, `* OK [UIDNEXT ${this.#mailbox.uidNext}] Predicted next UID`);
            selected = true;
            write(sock, `${tag} OK [READ-WRITE] ${cmd} completed`);
            break;
          }
          case 'FETCH': {
            if (!selected) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            const set = arg(1);
            // Everything after the set is the att spec (may contain spaces).
            const specStart = line.indexOf(set) + set.length;
            const atts = parseFetchAtts(line.slice(specStart));
            for (const { seq, msg } of this.#resolveSet(set, uidMode)) {
              this.#emitFetch(sock, seq, msg, atts, uidMode);
            }
            write(sock, `${tag} OK FETCH completed`);
            break;
          }
          case 'SEARCH': {
            if (!selected) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            const keys = parseSearchKeys(parts.slice(cmdIndex + 1));
            const hits: number[] = [];
            this.#mailbox.messages.forEach((m, i) => {
              const searchable = { headers: parseMessage(m.raw).headers, flags: m.flags };
              if (matchesSearch(searchable, keys)) hits.push(uidMode ? m.uid : i + 1);
            });
            write(sock, `* SEARCH${hits.length > 0 ? ' ' + hits.join(' ') : ''}`);
            write(sock, `${tag} OK SEARCH completed`);
            break;
          }
          case 'STORE': {
            if (!selected) {
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
              for (const { seq, msg } of this.#resolveSet(set, uidMode)) {
                this.#mailbox.storeFlags(msg.uid, mode, flags);
                if (!silent) {
                  const now = this.#mailbox.messages.find((m) => m.uid === msg.uid);
                  const uidPart = uidMode ? ` UID ${msg.uid}` : '';
                  write(sock, `* ${seq} FETCH (FLAGS (${now ? [...now.flags].join(' ') : ''})${uidPart})`);
                }
              }
            }
            write(sock, `${tag} OK STORE completed`);
            break;
          }
          case 'EXPUNGE': {
            if (!selected) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            // Report EXPUNGE by descending sequence number so the client's numbering stays consistent.
            const before = this.#mailbox.messages.map((m) => m.uid);
            const removedUids = new Set(this.#mailbox.expungeDeleted());
            const seqs = before.map((uid, i) => ({ uid, seq: i + 1 })).filter((e) => removedUids.has(e.uid));
            for (const e of seqs.reverse()) write(sock, `* ${e.seq} EXPUNGE`);
            write(sock, `${tag} OK EXPUNGE completed`);
            break;
          }
          case 'CLOSE':
            // Expunge silently and deselect (RFC 9051 §6.4.2).
            if (selected) this.#mailbox.expungeDeleted();
            selected = false;
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
      }
    });
  }
}
