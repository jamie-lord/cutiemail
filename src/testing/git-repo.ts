/**
 * A git repository and a smart-HTTP server for it, built in memory.
 *
 * The updater's transport is the one part of the project that talks to something outside the
 * machine, and a mock that returns canned buffers would only ever prove that the client can parse
 * what the test author already believed. So this is a real (small) server: it frames pkt-lines,
 * answers `ls-refs`, honours `deepen`, walks the object closure, builds an actual packfile, and
 * side-band-multiplexes it — over a real HTTP socket. The client under test does not know it is a
 * test.
 *
 * It can also misbehave on demand (`Misbehaviour` below), because the interesting cases for a
 * transport are the ones where the far end is broken, confused, or hostile.
 *
 * Not a git implementation: no deltas are emitted (every object is stored whole), packs are not
 * sorted the way git sorts them, and only the two commands the updater uses exist. That is the
 * point — it exercises OUR parser against the wire format, not the other way round.
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { objectId, parseCommit, parseTree, type GitObject } from '../update/objects.ts';
import { encodePkt, FLUSH_PKT, DELIM_PKT, decodeAll } from '../update/pkt-line.ts';

/** Builds objects and hands back their ids, so a test can describe a history in a few lines. */
export class RepoBuilder {
  readonly objects = new Map<string, GitObject>();

  #add(type: GitObject['type'], data: Buffer): string {
    const id = objectId(type, data);
    this.objects.set(id, { type, data });
    return id;
  }

  blob(content: string | Buffer): string {
    return this.#add('blob', typeof content === 'string' ? Buffer.from(content, 'latin1') : content);
  }

  tree(entries: ReadonlyArray<{ mode: string; name: string; id: string }>): string {
    const parts: Buffer[] = [];
    for (const e of entries) parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'latin1'), Buffer.from(e.id, 'hex'));
    return this.#add('tree', Buffer.concat(parts));
  }

  /** A commit. `committedAt` is in SECONDS, as git stores it. */
  commit(opts: { tree: string; parents?: readonly string[]; committedAt: number; message?: string }): string {
    const lines = [`tree ${opts.tree}`];
    for (const p of opts.parents ?? []) lines.push(`parent ${p}`);
    lines.push(`author Test <test@one.example> ${opts.committedAt} +0000`);
    lines.push(`committer Test <test@one.example> ${opts.committedAt} +0000`);
    lines.push('', opts.message ?? 'a commit', '');
    return this.#add('commit', Buffer.from(lines.join('\n'), 'latin1'));
  }

  /**
   * A linear history of `count` commits, each adding one file, oldest first.
   *
   * Every commit carries a complete tree (as git does), so any of them can be checked out on its
   * own — which is what makes a shallow fetch at depth 1 a usable working tree.
   */
  linear(count: number, opts: { firstCommittedAt: number; stepSeconds?: number } ): string[] {
    const step = opts.stepSeconds ?? 3600;
    const shas: string[] = [];
    const files: Array<{ mode: string; name: string; id: string }> = [];
    for (let i = 0; i < count; i++) {
      files.push({ mode: '100644', name: `f${i}.ts`, id: this.blob(`export const v${i} = ${i};\n`) });
      const tree = this.tree(files);
      const parents = shas.length > 0 ? [shas[shas.length - 1]!] : [];
      shas.push(this.commit({ tree, parents, committedAt: opts.firstCommittedAt + i * step, message: `commit ${i}` }));
    }
    return shas;
  }
}

/** Ways the server can be wrong, so the client's refusals have something to refuse. */
export interface Misbehaviour {
  /** Replace the advertised capability lines entirely. */
  readonly capabilities?: readonly string[];
  /** Send this instead of `version 2` as the first advertisement line. */
  readonly versionLine?: string;
  /**
   * Leave out the `# service=git-upload-pack` banner (and its flush) that every real server puts in
   * front of the v2 advertisement.
   *
   * The banner is emitted by DEFAULT here because that is what GitHub, GitLab and Codeberg all send
   * — and because this server not sending it is why the client's refusal of all three went
   * unnoticed. A test double is only evidence to the extent it is shaped like the thing it stands
   * in for; this one had been built from the same reading of the spec as the code it was testing,
   * so the two agreed with each other and not with reality.
   *
   * The no-banner shape stays reachable through this switch: it is what gitprotocol-v2 literally
   * shows, and the client accepts either.
   */
  readonly omitServiceBanner?: boolean;
  /** Send the banner but no flush after it — a frame boundary the client must insist on. */
  readonly bannerWithoutFlush?: boolean;
  /** Override the Content-Type on the advertisement or the command result. */
  readonly advertisementContentType?: string;
  readonly resultContentType?: string;
  /** Emit a `packfile-uris` section in the fetch response. */
  readonly packfileUris?: boolean;
  /** Emit no packfile section at all. */
  readonly omitPackfile?: boolean;
  /** Send this many bytes of band-2 progress noise before the pack, to exercise the size cap. */
  readonly progressBytes?: number;
  /** Answer every request with this HTTP status instead. */
  readonly httpStatus?: number;
  /** Return a ref the client did not ask about. */
  readonly extraRef?: { readonly name: string; readonly id: string };
  /** Send a fatal message on band 3 instead of a pack. */
  readonly fatal?: string;
}

export interface FakeGitServer {
  readonly url: string;
  /** Every command the client issued, in order — so a test can assert on the escalation it drove. */
  readonly commands: ReadonlyArray<{ readonly name: string; readonly args: readonly string[] }>;
  close(): Promise<void>;
}

/** Objects reachable from a commit: its tree, every subtree, and every blob. */
function closureOf(objects: ReadonlyMap<string, GitObject>, commitSha: string): Set<string> {
  const out = new Set<string>();
  const commit = objects.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return out;
  out.add(commitSha);
  const stack = [parseCommit(commit.data).tree];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    const obj = objects.get(id);
    if (obj === undefined) continue;
    out.add(id);
    if (obj.type === 'tree') for (const e of parseTree(obj.data)) stack.push(e.id);
  }
  return out;
}

const TYPE_CODE: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** The variable-length type+size header git puts in front of each packed object. */
function objectHeader(typeCode: number, size: number): Buffer {
  const out: number[] = [];
  let b = (typeCode << 4) | (size & 0b1111);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(b | 0x80);
    b = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(b);
  return Buffer.from(out);
}

/** A packfile containing exactly `ids`, every object stored whole. */
export function buildPack(objects: ReadonlyMap<string, GitObject>, ids: Iterable<string>): Buffer {
  const list = [...ids];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [head];
  for (const id of list) {
    const obj = objects.get(id)!;
    parts.push(objectHeader(TYPE_CODE[obj.type], obj.data.length), deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Split a buffer into side-band-64k data packets on band 1. */
function sideband(pack: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const chunk = 8192;
  for (let off = 0; off < pack.length; off += chunk) {
    out.push(encodePkt(Buffer.concat([Buffer.from([band]), pack.subarray(off, off + chunk)])));
  }
  return out;
}

export async function startGitServer(opts: {
  readonly objects: ReadonlyMap<string, GitObject>;
  readonly refs: Readonly<Record<string, string>>;
  readonly misbehave?: Misbehaviour;
}): Promise<FakeGitServer> {
  const bad = opts.misbehave ?? {};
  const commands: Array<{ name: string; args: string[] }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      if (bad.httpStatus !== undefined) {
        res.writeHead(bad.httpStatus, { 'Content-Type': 'text/plain' });
        res.end('nope');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname.endsWith('/info/refs')) {
        const caps = bad.capabilities ?? ['agent=fake-git/1', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
        // The smart-HTTP discovery banner, ahead of the v2 advertisement, exactly as every real
        // server sends it. See Misbehaviour.omitServiceBanner for why this is the default.
        const banner = bad.omitServiceBanner === true
          ? []
          : [encodePkt('# service=git-upload-pack\n'), ...(bad.bannerWithoutFlush === true ? [] : [FLUSH_PKT])];
        const body = Buffer.concat([
          ...banner,
          encodePkt(`${bad.versionLine ?? 'version 2'}\n`),
          ...caps.map((c) => encodePkt(`${c}\n`)),
          FLUSH_PKT,
        ]);
        res.writeHead(200, { 'Content-Type': bad.advertisementContentType ?? 'application/x-git-upload-pack-advertisement' });
        res.end(body);
        return;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/git-upload-pack')) {
        const lines: string[] = [];
        for (const p of decodeAll(Buffer.concat(chunks))) {
          if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
        }
        const commandLine = lines.find((l) => l.startsWith('command='));
        const name = commandLine === undefined ? '' : commandLine.slice('command='.length);
        const args = lines.filter((l) => !l.startsWith('command=') && !l.startsWith('agent=') && !l.startsWith('object-format='));
        commands.push({ name, args });
        const ctype = bad.resultContentType ?? 'application/x-git-upload-pack-result';
        res.writeHead(200, { 'Content-Type': ctype });
        res.end(name === 'ls-refs' ? handleLsRefs(args) : handleFetch(args));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
  });

  function handleLsRefs(args: readonly string[]): Buffer {
    const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
    const parts: Buffer[] = [];
    for (const [name, id] of Object.entries(opts.refs)) {
      if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) continue;
      parts.push(encodePkt(`${id} ${name}\n`));
    }
    if (bad.extraRef !== undefined) parts.push(encodePkt(`${bad.extraRef.id} ${bad.extraRef.name}\n`));
    parts.push(FLUSH_PKT);
    return Buffer.concat(parts);
  }

  function handleFetch(args: readonly string[]): Buffer {
    const wants = args.filter((a) => a.startsWith('want ')).map((a) => a.slice(5));
    const depthArg = args.find((a) => a.startsWith('deepen '));
    const depth = depthArg === undefined ? Number.MAX_SAFE_INTEGER : Number(depthArg.slice('deepen '.length));

    // Walk back `depth` commits from each want; the commits one step beyond are the shallow boundary.
    const include = new Set<string>();
    const boundary = new Set<string>();
    let frontier = [...wants];
    for (let level = 0; level < depth && frontier.length > 0; level++) {
      const next: string[] = [];
      for (const sha of frontier) {
        if (include.has(sha)) continue;
        include.add(sha);
        const obj = opts.objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') continue;
        next.push(...parseCommit(obj.data).parents);
      }
      frontier = next;
    }
    // Anything still on the frontier had a parent we did not send: its CHILD is the boundary.
    for (const sha of include) {
      const obj = opts.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.some((p) => !include.has(p))) boundary.add(sha);
    }

    const objectIds = new Set<string>();
    for (const sha of include) for (const id of closureOf(opts.objects, sha)) objectIds.add(id);

    const parts: Buffer[] = [];
    if (boundary.size > 0) {
      parts.push(encodePkt('shallow-info\n'));
      for (const sha of boundary) parts.push(encodePkt(`shallow ${sha}\n`));
      parts.push(DELIM_PKT);
    }
    if (bad.packfileUris === true) {
      parts.push(encodePkt('packfile-uris\n'), encodePkt('https://one.example/pack\n'), DELIM_PKT);
    }
    if (bad.omitPackfile !== true) {
      parts.push(encodePkt('packfile\n'));
      if (bad.fatal !== undefined) {
        parts.push(encodePkt(Buffer.concat([Buffer.from([3]), Buffer.from(bad.fatal, 'utf8')])));
      } else {
        if (bad.progressBytes !== undefined) {
          parts.push(...sideband(Buffer.alloc(bad.progressBytes, 0x2e), 2));
        }
        parts.push(...sideband(buildPack(opts.objects, objectIds)));
      }
    }
    parts.push(FLUSH_PKT);
    return Buffer.concat(parts);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port');
  return {
    url: `http://127.0.0.1:${address.port}/owner/repo.git`,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
