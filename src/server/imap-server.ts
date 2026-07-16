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

export interface ServableMessage {
  readonly uid: number;
  readonly flags: ReadonlySet<string>;
  readonly raw: Buffer;
}

export interface ServableMailbox {
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly messages: readonly ServableMessage[];
}

const write = (sock: net.Socket, line: string): void => {
  sock.write(Buffer.from(`${line}\r\n`, 'latin1'));
};

export class ImapServer {
  readonly port: number;
  readonly #server: net.Server;
  readonly #mailbox: ServableMailbox;

  private constructor(server: net.Server, port: number, mailbox: ServableMailbox) {
    this.#server = server;
    this.port = port;
    this.#mailbox = mailbox;
  }

  static start(mailbox: ServableMailbox): Promise<ImapServer> {
    const server = net.createServer();
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        const imap = new ImapServer(server, port, mailbox);
        server.on('connection', (sock) => imap.#handle(sock));
        resolve(imap);
      });
    });
  }

  close(): Promise<void> {
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
            } else {
              const flags = [...msg.flags].join(' ');
              write(sock, `* ${seq} FETCH (FLAGS (${flags}) UID ${msg.uid})`);
            }
            write(sock, `${tag} OK FETCH completed`);
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
