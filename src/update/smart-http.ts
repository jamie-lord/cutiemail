/**
 * Git's smart HTTP transport, protocol v2, spoken directly.
 *
 * Two requests are all an updater needs:
 *
 *   GET  <url>/info/refs?service=git-upload-pack   what the server can do
 *   POST <url>/git-upload-pack                     command=ls-refs, then command=fetch
 *
 * with `Git-Protocol: version=2` on both. Everything travels in pkt-lines (pkt-line.ts) and the
 * packfile section is side-band multiplexed, so a server that wants to say "no such object" says it
 * on band 3 rather than sending a short pack — which is why `demuxSideband` raises instead of
 * returning what it has.
 *
 * WHY SHALLOW-BY-DEPTH. The fetch asks for `deepen <n>`: the candidate commit plus up to n
 * ancestors. That is enough for both jobs at once — the tip's complete tree, which is what gets
 * checked out, and the commit chain back to the version we are running, which is what proves the
 * descendant rule (ADR 0025). It costs almost nothing beyond a single-commit fetch, because
 * consecutive commits in a repository share their trees and blobs and the extra history is a
 * handful of small deltas. `deepen` is also the oldest and most universally implemented shallow
 * form; `deepen-not <oid>` would express the intent more directly but puts the whole update path at
 * the mercy of one less-travelled server feature.
 *
 * BOUNDS. Everything a remote controls is bounded before it is believed: the response size (checked
 * both from `content-length` and while streaming, because the header is a claim), a wall-clock
 * deadline on the whole exchange, the pkt-line payload length, and — downstream, in packfile.ts —
 * the object count, inflated sizes and delta depth. The failure mode of every one of them is "no
 * update available", never a partial result.
 */

import { decodeAll, demuxSideband, encodePkt, FLUSH_PKT, DELIM_PKT, type Pkt } from './pkt-line.ts';

export class GitTransportError extends Error {}

/** A `fetch` implementation, injected so tests drive a local server or a scripted response. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitRemoteOptions {
  readonly fetchImpl?: FetchLike;
  /** Wall-clock budget for one request, headers and body together. */
  readonly timeoutMs?: number;
  /** Cap on a packfile response. Beyond this the fetch is abandoned, not truncated. */
  readonly maxPackBytes?: number;
  /** Cap on a control response (the advertisement, an ls-refs reply). */
  readonly maxControlBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PACK_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CONTROL_BYTES = 4 * 1024 * 1024;
const AGENT = 'cutiemail-updater/1';

/** What the server said it can do, from the v2 advertisement. */
export interface ServerCapabilities {
  /** Capability name to its value ('' when the capability has no `=value`). */
  readonly values: ReadonlyMap<string, string>;
  has(name: string): boolean;
}

export interface FetchedPack {
  readonly pack: Buffer;
  /** Commits whose parents were NOT sent, because the depth bound cut the history here. */
  readonly shallow: readonly string[];
}

/**
 * Whether an `http:` remote is acceptable — only for loopback, only so the client can be exercised
 * against a real local server in tests. Mirrors the carve-out in config.ts, restated here so the
 * transport refuses on its own rather than trusting a caller to have validated the URL.
 */
function transportIsSafe(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost', '[::1]'].includes(url.hostname);
}

/**
 * Read a response body with a hard byte cap, streaming.
 *
 * The `content-length` header is a claim by the remote, so it is used as an early refusal and never
 * as a reason to stop counting: a server that omits it, or lies, still cannot make us buffer more
 * than the cap. Over-cap is a refusal rather than a truncation, because half a packfile that parses
 * is more dangerous than one that does not.
 */
async function readBounded(res: Response, maxBytes: number, what: string): Promise<Buffer> {
  const claimed = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(claimed) && claimed > maxBytes) {
    throw new GitTransportError(`${what}: server claims ${claimed} bytes, over the ${maxBytes} cap`);
  }
  const body = res.body;
  if (body === null) throw new GitTransportError(`${what}: response had no body`);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new GitTransportError(`${what}: response exceeded the ${maxBytes} byte cap`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export class GitRemote {
  readonly #base: URL;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxPackBytes: number;
  readonly #maxControlBytes: number;
  #caps: ServerCapabilities | null = null;

  constructor(url: string, opts: GitRemoteOptions = {}) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new GitTransportError(`not a URL: ${JSON.stringify(url)}`);
    }
    if (!transportIsSafe(parsed)) {
      throw new GitTransportError(
        `refusing ${parsed.protocol}// for ${parsed.hostname}: TLS to the remote is the only thing authenticating the code this machine will run.`,
      );
    }
    // `https://host/owner/repo.git` and `.../repo` both work; normalise away a trailing slash so
    // the endpoint paths below never produce a double one.
    this.#base = new URL(parsed.href.replace(/\/+$/, ''));
    this.#fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxPackBytes = opts.maxPackBytes ?? DEFAULT_MAX_PACK_BYTES;
    this.#maxControlBytes = opts.maxControlBytes ?? DEFAULT_MAX_CONTROL_BYTES;
  }

  /**
   * Read the v2 capability advertisement, once per remote.
   *
   * Two things here are real gates rather than bookkeeping. If the server does not answer version 2
   * we stop, because the v1 dialect is a different protocol and half-speaking it would be a second
   * parser nobody reviews. And if it announces `object-format=sha256` we stop, because every object
   * id in this tree is computed as SHA-1 — continuing would mean verifying every object against the
   * wrong hash and, since a mismatch throws, failing in a way that looks like corruption instead of
   * like an unsupported repository.
   */
  async capabilities(): Promise<ServerCapabilities> {
    if (this.#caps !== null) return this.#caps;
    const url = `${this.#base.href}/info/refs?service=git-upload-pack`;
    const res = await this.#fetch(url, {
      method: 'GET',
      headers: { 'Git-Protocol': 'version=2', 'User-Agent': AGENT, Accept: 'application/x-git-upload-pack-advertisement' },
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: 'error',
    });
    if (!res.ok) throw new GitTransportError(`advertisement: HTTP ${res.status} from ${url}`);
    const ctype = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (ctype !== 'application/x-git-upload-pack-advertisement') {
      // A captive portal, a proxy error page, or a plain 200 OK web page. Saying so beats letting
      // the pkt-line framer report "malformed pkt length \"<!DO\"".
      throw new GitTransportError(`advertisement: expected a git advertisement, got content-type ${JSON.stringify(ctype)}`);
    }
    const body = await readBounded(res, this.#maxControlBytes, 'advertisement');
    const lines = dataLines(skipServiceBanner(decodeAll(body)));
    if (lines[0] !== 'version 2') {
      throw new GitTransportError(`remote does not speak protocol v2 (first line: ${JSON.stringify(lines[0] ?? '')})`);
    }
    const values = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const eq = line.indexOf('=');
      if (eq === -1) values.set(line, '');
      else values.set(line.slice(0, eq), line.slice(eq + 1));
    }
    const objectFormat = values.get('object-format');
    if (objectFormat !== undefined && objectFormat !== 'sha1') {
      throw new GitTransportError(
        `remote uses object-format=${objectFormat}; this updater computes SHA-1 object ids and would verify every object against the wrong hash.`,
      );
    }
    for (const required of ['ls-refs', 'fetch']) {
      if (!values.has(required)) throw new GitTransportError(`remote does not advertise the ${required} command`);
    }
    const caps: ServerCapabilities = { values, has: (n) => values.has(n) };
    this.#caps = caps;
    return caps;
  }

  /** POST a v2 command and return its decoded packets. */
  async #command(name: string, args: readonly string[], maxBytes: number): Promise<Pkt[]> {
    const caps = await this.capabilities();
    const parts: Buffer[] = [encodePkt(`command=${name}\n`), encodePkt(`agent=${AGENT}\n`)];
    // Echo the hash algorithm back only when the server raised the subject, exactly as git does.
    if (caps.has('object-format')) parts.push(encodePkt('object-format=sha1\n'));
    parts.push(DELIM_PKT);
    for (const a of args) parts.push(encodePkt(`${a}\n`));
    parts.push(FLUSH_PKT);
    const body = Buffer.concat(parts);

    const url = `${this.#base.href}/git-upload-pack`;
    const res = await this.#fetch(url, {
      method: 'POST',
      headers: {
        'Git-Protocol': 'version=2',
        'User-Agent': AGENT,
        'Content-Type': 'application/x-git-upload-pack-request',
        Accept: 'application/x-git-upload-pack-result',
        'Content-Length': String(body.length),
      },
      body,
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: 'error',
    });
    if (!res.ok) throw new GitTransportError(`${name}: HTTP ${res.status} from ${url}`);
    const ctype = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (ctype !== 'application/x-git-upload-pack-result') {
      throw new GitTransportError(`${name}: expected a git result, got content-type ${JSON.stringify(ctype)}`);
    }
    return decodeAll(await readBounded(res, maxBytes, name));
  }

  /**
   * Resolve refs under `prefixes` to their object ids.
   *
   * Only the prefixes asked for come back, so a repository with thousands of tags costs nothing.
   * The reply is validated rather than trusted: a name outside the requested prefixes, or an id that
   * is not 40 hex digits, is a malformed reply and not something to work around.
   */
  async lsRefs(prefixes: readonly string[]): Promise<Map<string, string>> {
    for (const p of prefixes) {
      if (p.includes('\n') || p.includes('\0')) throw new GitTransportError(`ref-prefix contains a framing character: ${JSON.stringify(p)}`);
    }
    const pkts = await this.#command('ls-refs', prefixes.map((p) => `ref-prefix ${p}`), this.#maxControlBytes);
    const out = new Map<string, string>();
    for (const line of dataLines(pkts)) {
      const sp = line.indexOf(' ');
      if (sp === -1) throw new GitTransportError(`ls-refs: malformed line ${JSON.stringify(line)}`);
      const id = line.slice(0, sp);
      // Trailing attributes (`symref-target:`, `peeled:`) are separated by further spaces.
      const name = line.slice(sp + 1).split(' ')[0]!;
      if (!/^[0-9a-f]{40}$/.test(id)) throw new GitTransportError(`ls-refs: ${JSON.stringify(name)} has a malformed object id`);
      if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) {
        throw new GitTransportError(`ls-refs: returned ${JSON.stringify(name)}, which is outside the requested prefixes`);
      }
      out.set(name, id);
    }
    return out;
  }

  /**
   * Fetch a packfile containing `want` and up to `depth` ancestors.
   *
   * `thin-pack` is deliberately NOT requested. A thin pack deltas against objects the server
   * believes the client already holds — and this client holds none, because a version store keeps
   * checkouts rather than an object database. Asking for one would produce a pack that cannot be
   * resolved, at best.
   */
  async fetchPack(want: string, depth: number): Promise<FetchedPack> {
    if (!/^[0-9a-f]{40}$/.test(want)) throw new GitTransportError(`fetch: ${JSON.stringify(want)} is not an object id`);
    if (!Number.isInteger(depth) || depth < 1) throw new GitTransportError(`fetch: depth must be a positive integer, got ${depth}`);
    const caps = await this.capabilities();
    if (!caps.values.get('fetch')!.split(' ').includes('shallow')) {
      throw new GitTransportError('remote does not advertise the fetch "shallow" feature, so history depth cannot be bounded');
    }
    const pkts = await this.#command(
      'fetch',
      [
        'no-progress',
        'ofs-delta',
        `want ${want}`,
        `deepen ${depth}`,
        'done',
      ],
      this.#maxPackBytes,
    );
    return parseFetchResponse(pkts);
  }
}

/** The text of every data packet, with the trailing LF git writes stripped. */
/**
 * Drop the `# service=git-upload-pack` banner, and the flush after it, from an info/refs response.
 *
 * gitprotocol-v2 documents the v2 advertisement as beginning `version 2`, and that is what a plain
 * reading produces. Every real server puts the smart-HTTP discovery banner from gitprotocol-http in
 * front of it first:
 *
 *   001e# service=git-upload-pack\n
 *   0000
 *   000eversion 2\n
 *
 * Verified against GitHub, GitLab and Codeberg — three independent implementations, all identical,
 * which is what git's own client expects (`discover_refs` reads the banner, requires the flush,
 * then hands the rest to the v2 parser). Without this the updater refuses every one of them,
 * including the repository named in DEFAULT_REPO_URL: the whole mechanism was inoperative against
 * the only remote it ships pointing at.
 *
 * The flush is REQUIRED after the banner rather than merely skipped past. It is the frame boundary
 * between the discovery response and the capability advertisement, and a server that omits it is
 * sending something whose shape we have not established — which, on the code path that decides what
 * this machine will run next, is a refusal rather than a guess.
 *
 * A response with no banner at all is still accepted: that is what the v2 document itself shows,
 * and a POST reply never carries one.
 */
function skipServiceBanner(pkts: readonly Pkt[]): readonly Pkt[] {
  const first = pkts[0];
  if (first === undefined || first.kind !== 'data') return pkts;
  if (!first.payload.toString('utf8').startsWith('# service=')) return pkts;
  if (pkts[1]?.kind !== 'flush') {
    throw new GitTransportError('advertisement: a "# service=" banner was not followed by a flush packet');
  }
  return pkts.slice(2);
}

function dataLines(pkts: readonly Pkt[]): string[] {
  const out: string[] = [];
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    out.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

/**
 * Split a v2 fetch response into its sections.
 *
 * Sections arrive in a fixed order (`acknowledgments`, `shallow-info`, `wanted-refs`,
 * `packfile-uris`, `packfile`), each introduced by a data packet naming it and terminated by a
 * delim-pkt or the final flush. Only two matter here: `shallow-info`, which says where the depth
 * bound cut the history — the difference between "not a descendant" and "look further back" —
 * and `packfile`.
 *
 * An absent packfile section is an error rather than an empty result. `packfile-uris` in particular
 * would mean the server wants us to go and fetch the pack from somewhere else entirely, which is a
 * capability we never requested and must not silently treat as "nothing to do".
 */
export function parseFetchResponse(pkts: readonly Pkt[]): FetchedPack {
  let section: string | null = null;
  const shallow: string[] = [];
  const packPkts: Pkt[] = [];
  let sawPackfile = false;

  for (const p of pkts) {
    if (p.kind === 'delim' || p.kind === 'flush' || p.kind === 'response-end') {
      // A flush ends the response; a delim ends a section. Either way the next data packet names a
      // new section — except inside `packfile`, where the section runs to the end.
      if (section !== 'packfile') section = null;
      continue;
    }
    if (p.kind !== 'data') continue;
    if (section === null) {
      section = p.payload.toString('utf8').replace(/\n$/, '');
      if (section === 'packfile') sawPackfile = true;
      else if (section === 'packfile-uris') {
        throw new GitTransportError('remote answered with packfile-uris, a capability this client never requested');
      }
      continue;
    }
    if (section === 'shallow-info') {
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      const m = /^shallow ([0-9a-f]{40})$/.exec(line);
      if (m !== null) shallow.push(m[1]!);
      continue;
    }
    if (section === 'packfile') {
      packPkts.push(p);
      continue;
    }
    // acknowledgments / wanted-refs: nothing here needs them, and ignoring an unknown section is
    // right only because the packfile section is separately required below.
  }

  if (!sawPackfile) throw new GitTransportError('fetch response contained no packfile section');
  const pack = demuxSideband(packPkts);
  if (pack.length === 0) throw new GitTransportError('fetch response carried an empty packfile');
  return { pack, shallow };
}
