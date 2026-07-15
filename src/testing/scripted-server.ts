/**
 * A byte-exact scriptable TCP server, for testing THIS SUITE's machinery.
 *
 * Scope, stated loudly because getting it wrong would be corrosive: this is a
 * test double for our own unit tests. It is **not** a conformance target and
 * **not** a reference implementation. Nothing here should ever be used as an
 * oracle for what correct SMTP looks like.
 *
 * That distinction is why GreenMail is unusable for conformance work: it is a
 * fake server that itself violates the specs it would notionally test (it
 * permits DELETE INBOX and RENAME onto an existing mailbox, both explicit
 * RFC 3501 errors). A fake is fine for exercising a client; it is worthless as
 * ground truth. Ours is honest about being a fake — it does exactly what the
 * script says and has no opinion about SMTP at all.
 *
 * Real ground truth is Postfix and Exim, in containers, under task #13.
 */

import net from 'node:net';

export interface Session {
  /** Send exact bytes. Nothing is appended. */
  send(bytes: Buffer): void;
  /** Resolve once at least `n` bytes have arrived in total. */
  awaitBytes(n: number): Promise<Buffer>;
  /** Resolve once `needle` appears in the received stream. */
  awaitContaining(needle: Buffer): Promise<Buffer>;
  /** Orderly FIN. */
  end(): void;
  /** Abrupt RST. */
  reset(): void;
  /** Everything received so far. */
  received(): Buffer;
  delay(ms: number): Promise<void>;
}

export type Handler = (session: Session) => void | Promise<void>;

export class ScriptedServer {
  readonly port: number;
  #server: net.Server;
  #sockets: net.Socket[] = [];

  private constructor(server: net.Server, port: number) {
    this.#server = server;
    this.port = port;
  }

  static start(handler: Handler): Promise<ScriptedServer> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.on('error', () => {
          // A test that RSTs its own connection is normal here; swallow so the
          // process doesn't die mid-suite.
        });
        let received = Buffer.alloc(0);
        let wake: (() => void)[] = [];
        socket.on('data', (chunk) => {
          received = Buffer.concat([received, Buffer.from(chunk)]);
          const w = wake;
          wake = [];
          for (const f of w) f();
        });
        const until = (done: () => boolean): Promise<Buffer> =>
          new Promise((res) => {
            const check = (): void => {
              if (done()) res(Buffer.from(received));
              else wake.push(check);
            };
            check();
          });

        const session: Session = {
          send: (bytes) => void socket.write(bytes),
          awaitBytes: (n) => until(() => received.length >= n),
          awaitContaining: (needle) => until(() => received.includes(needle)),
          end: () => socket.end(),
          reset: () => socket.destroy(),
          received: () => Buffer.from(received),
          delay: (ms) =>
            new Promise((res) => {
              const t = setTimeout(res, ms);
              t.unref();
            }),
        };
        void Promise.resolve(handler(session)).catch(() => socket.destroy());
      });

      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('no port assigned'));
          return;
        }
        resolve(new ScriptedServer(server, addr.port));
      });
    });
  }

  close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

/** Run `fn` against a scripted server, always tearing it down. */
export async function withServer<T>(
  handler: Handler,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const server = await ScriptedServer.start(handler);
  try {
    return await fn(server.port);
  } finally {
    await server.close();
  }
}
