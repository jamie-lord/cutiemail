/**
 * A minimal, live IMAP4rev2 server — the read leg, assembled from the test bed.
 *
 * Serves a mailbox over a socket: greeting, LOGIN, SELECT, FETCH (FLAGS / BODY[]),
 * and LOGOUT — enough for a client to read what the SMTP receiver stored. It reuses
 * the semantics the bed specifies: the mailbox model's UID/UIDVALIDITY/sequence
 * numbers, byte-exact BODY[] via a literal. The full command surface (STORE, SEARCH,
 * IDLE, extensions) wires in as the server grows; this is the minimum a client needs
 * to fetch a delivered message.
 *
 * It takes any object exposing the mailbox read surface, so it serves either the
 * reference Mailbox or the SQLite-backed one.
 */

import net from 'node:net';
import tls from 'node:tls';
import { parseMessage } from '../message/parse.ts';
import { buildEnvelope, serializeEnvelope } from '../imap/envelope.ts';
import { matchesSearch, type SearchKey } from '../imap/search.ts';

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

export class ImapServer {
  readonly port: number;
  readonly #server: net.Server;
  readonly #mailbox: ServableMailbox;
  readonly #sockets = new Set<net.Socket>();

  private constructor(server: net.Server, port: number, mailbox: ServableMailbox) {
    this.#server = server;
    this.port = port;
    this.#mailbox = mailbox;
  }

  /**
   * Start the server. With `options.tls` it serves implicit TLS (IMAPS, port 993 in
   * production — what Thunderbird and Apple Mail use); otherwise plaintext.
   */
  static start(mailbox: ServableMailbox, options: { tls?: { key: string; cert: string } } = {}): Promise<ImapServer> {
    const server = options.tls !== undefined ? tls.createServer({ key: options.tls.key, cert: options.tls.cert }) : net.createServer();
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        const imap = new ImapServer(server, port, mailbox);
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

  #handle(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
    let selected = false;
    sock.on('error', () => {});
    write(sock, '* OK [CAPABILITY IMAP4rev2] server ready');

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      for (;;) {
        const nl = buf.indexOf(Buffer.from([0x0d, 0x0a]));
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString('latin1');
        buf = buf.subarray(nl + 2);
        const parts = line.split(' ');
        const tag = parts[0] ?? '';
        const cmd = (parts[1] ?? '').toUpperCase();

        switch (cmd) {
          case 'LOGIN':
            write(sock, `${tag} OK LOGIN completed`);
            break;
          case 'SELECT':
          case 'EXAMINE': {
            const msgs = this.#mailbox.messages;
            write(sock, `* ${msgs.length} EXISTS`);
            write(sock, '* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
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
            const seq = Number(parts[2]);
            const item = (parts.slice(3).join(' ') || '').toUpperCase();
            const msg = this.#mailbox.messages[seq - 1];
            if (msg === undefined) {
              write(sock, `${tag} OK FETCH completed`);
              break;
            }
            if (item.includes('BODY[]') || item.includes('BODY.PEEK[]') || item.includes('RFC822')) {
              // Byte-exact body via a literal.
              sock.write(Buffer.from(`* ${seq} FETCH (BODY[] {${msg.raw.length}}\r\n`, 'latin1'));
              sock.write(msg.raw);
              sock.write(Buffer.from(')\r\n', 'latin1'));
            } else if (item.includes('ENVELOPE')) {
              const env = serializeEnvelope(buildEnvelope(parseMessage(msg.raw).headers));
              write(sock, `* ${seq} FETCH (ENVELOPE ${env})`);
            } else {
              const flags = [...msg.flags].join(' ');
              write(sock, `* ${seq} FETCH (FLAGS (${flags}) UID ${msg.uid})`);
            }
            write(sock, `${tag} OK FETCH completed`);
            break;
          }
          case 'SEARCH': {
            if (!selected) {
              write(sock, `${tag} BAD no mailbox selected`);
              break;
            }
            const keys = parseSearchKeys(parts.slice(2));
            const hits: number[] = [];
            this.#mailbox.messages.forEach((m, i) => {
              const searchable = { headers: parseMessage(m.raw).headers, flags: m.flags };
              if (matchesSearch(searchable, keys)) hits.push(i + 1);
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
            const seq = Number(parts[2]);
            const op = (parts[3] ?? '').toUpperCase(); // +FLAGS / -FLAGS / FLAGS
            const flags = (parts.slice(4).join(' ').match(/\\?\w+/g) ?? []).map((f) => (f.startsWith('\\') ? `\\${f.slice(1)}` : f));
            const msg = this.#mailbox.messages[seq - 1];
            if (msg !== undefined && (op === '+FLAGS' || op === '-FLAGS' || op === 'FLAGS')) {
              const mode = op === '+FLAGS' ? 'add' : op === '-FLAGS' ? 'remove' : 'replace';
              this.#mailbox.storeFlags(msg.uid, mode, flags);
              const now = this.#mailbox.messages.find((m) => m.uid === msg.uid);
              write(sock, `* ${seq} FETCH (FLAGS (${now ? [...now.flags].join(' ') : ''}))`);
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
