/**
 * The smart-HTTP client, against a real server speaking protocol v2 over a real socket.
 *
 * Every refusal here has a negative control, because this is the module that decides what bytes the
 * rest of the updater will believe. A transport that quietly accepts a confused or hostile far end
 * turns every downstream check into theatre: the checkout allow-list cannot help if the pack it
 * validates came from a captive portal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitRemote, GitTransportError } from './smart-http.ts';
import { decodePackfile } from './packfile.ts';
import { RepoBuilder, startGitServer, type Misbehaviour } from '../testing/git-repo.ts';

const AT = 1_700_000_000;

/** A three-commit repository and a server for it, with optional misbehaviour. */
async function withRepo(
  misbehave: Misbehaviour | undefined,
  fn: (remote: GitRemote, ctx: { shas: string[]; server: Awaited<ReturnType<typeof startGitServer>> }) => Promise<void>,
): Promise<void> {
  const repo = new RepoBuilder();
  const shas = repo.linear(3, { firstCommittedAt: AT });
  const server = await startGitServer({
    objects: repo.objects,
    refs: { 'refs/heads/main': shas[shas.length - 1]! },
    ...(misbehave !== undefined ? { misbehave } : {}),
  });
  try {
    await fn(new GitRemote(server.url, { timeoutMs: 5000 }), { shas, server });
  } finally {
    await server.close();
  }
}

test('the advertisement, ls-refs and a shallow fetch all work end to end', async () => {
  await withRepo(undefined, async (remote, { shas }) => {
    const caps = await remote.capabilities();
    assert.equal(caps.has('ls-refs'), true);
    assert.equal(caps.values.get('object-format'), 'sha1');

    const refs = await remote.lsRefs(['refs/heads/main']);
    assert.equal(refs.get('refs/heads/main'), shas[2]);

    // Depth 1: the tip commit and its complete tree, with the tip marked as the shallow boundary.
    const { pack, shallow } = await remote.fetchPack(shas[2]!, 1);
    assert.deepEqual(shallow, [shas[2]]);
    const objects = decodePackfile(pack);
    assert.equal(objects.get(shas[2]!)?.type, 'commit');
    assert.equal(objects.has(shas[1]!), false, 'depth 1 must not include the parent commit');

    // Depth 3 reaches the root, so nothing is a boundary.
    const deep = await remote.fetchPack(shas[2]!, 3);
    assert.deepEqual(deep.shallow, []);
    const all = decodePackfile(deep.pack);
    for (const sha of shas) assert.equal(all.get(sha)?.type, 'commit', `${sha} is present at depth 3`);
  });
});

test('a plaintext remote is refused unless it is loopback', () => {
  assert.throws(() => new GitRemote('http://one.example/repo.git'), /refusing http:/);
  assert.throws(() => new GitRemote('git://one.example/repo.git'), GitTransportError);
  assert.throws(() => new GitRemote('file:///etc/passwd'), GitTransportError);
  // https anywhere, and http on loopback for this suite's own server, are both fine.
  assert.doesNotThrow(() => new GitRemote('https://one.example/repo.git'));
  assert.doesNotThrow(() => new GitRemote('http://127.0.0.1:1234/repo.git'));
});

test('a response that is not a git advertisement is named as such', async () => {
  await withRepo({ advertisementContentType: 'text/html' }, async (remote) => {
    await assert.rejects(() => remote.capabilities(), /expected a git advertisement/);
  });
});

test('a remote that does not speak protocol v2 is refused rather than half-parsed', async () => {
  await withRepo({ versionLine: 'version 1' }, async (remote) => {
    await assert.rejects(() => remote.capabilities(), /does not speak protocol v2/);
  });
});

test('the smart-HTTP service banner in front of the v2 advertisement is read past', async () => {
  // The framing every real server actually sends. gitprotocol-v2 documents the advertisement as
  // beginning `version 2`, and this client was built to that reading, so it refused GitHub, GitLab
  // and Codeberg alike — including the repository DEFAULT_REPO_URL names. The whole update
  // mechanism was inoperative against the only remote it ships pointing at, and no test said so,
  // because the test server had been built from the same reading as the client.
  //
  // The banner is now what this server sends by DEFAULT, so every other case in this file is
  // exercised against the real-world shape too.
  await withRepo({}, async (remote) => {
    const caps = await remote.capabilities();
    assert.ok(caps.has('ls-refs'), 'the capabilities after the banner are the ones parsed');
  });

  // The no-banner shape stays accepted: it is what the v2 document literally shows.
  await withRepo({ omitServiceBanner: true }, async (remote) => {
    assert.ok((await remote.capabilities()).has('fetch'));
  });

  // But a banner with no flush after it is refused. The flush is the frame boundary between the
  // discovery response and the capability advertisement; without it the response has a shape we
  // have not established, and this is the code path that decides what the machine runs next.
  await withRepo({ bannerWithoutFlush: true }, async (remote) => {
    await assert.rejects(() => remote.capabilities(), /not followed by a flush/);
  });
});

test('the advertisement framing matches what real servers send, byte for byte', async () => {
  // A frozen transcript of GitHub's first 48 octets, checked against GitLab and Codeberg and
  // identical on all three. Pinned as bytes rather than described in prose so that a future change
  // to the banner handling has something to fail against that did not come from our own server.
  const observed = Buffer.concat([
    Buffer.from('001e# service=git-upload-pack\n', 'latin1'),
    Buffer.from('0000', 'latin1'),
    Buffer.from('000eversion 2\n', 'latin1'),
    Buffer.from('0028agent=git/github-cda1d7094a30-Linux\n', 'latin1'),
    Buffer.from('0013ls-refs=unborn\n', 'latin1'),
    Buffer.from('0027fetch=shallow wait-for-done filter\n', 'latin1'),
    Buffer.from('0012server-option\n', 'latin1'),
    Buffer.from('0017object-format=sha1\n', 'latin1'),
    Buffer.from('0000', 'latin1'),
  ]);
  const remote = new GitRemote('https://git.one.example/r.git', {
    fetchImpl: async () =>
      new Response(observed, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } }),
  });
  const caps = await remote.capabilities();
  assert.equal(caps.values.get('object-format'), 'sha1');
  assert.equal(caps.values.get('ls-refs'), 'unborn');
  assert.ok(caps.has('fetch'), 'and the fetch command is found, which is what the updater needs');
});

test('a sha256 repository is refused, because every object id here is computed as SHA-1', async () => {
  await withRepo({ capabilities: ['ls-refs', 'fetch=shallow', 'object-format=sha256'] }, async (remote) => {
    await assert.rejects(() => remote.capabilities(), /object-format=sha256/);
  });
});

test('a remote missing a command we need, or the shallow feature, is refused', async () => {
  await withRepo({ capabilities: ['fetch=shallow', 'object-format=sha1'] }, async (remote) => {
    await assert.rejects(() => remote.capabilities(), /does not advertise the ls-refs command/);
  });
  await withRepo({ capabilities: ['ls-refs', 'fetch=wait-for-done', 'object-format=sha1'] }, async (remote, { shas }) => {
    await assert.rejects(() => remote.fetchPack(shas[2]!, 1), /does not advertise the fetch "shallow" feature/);
  });
});

test('an HTTP error is reported, not treated as an empty repository', async () => {
  await withRepo({ httpStatus: 503 }, async (remote) => {
    await assert.rejects(() => remote.capabilities(), /HTTP 503/);
  });
});

test('a ref outside the requested prefixes is a malformed reply', async () => {
  await withRepo({ extraRef: { name: 'refs/tags/v1', id: 'a'.repeat(40) } }, async (remote) => {
    await assert.rejects(() => remote.lsRefs(['refs/heads/main']), /outside the requested prefixes/);
  });
});

test('a fatal message on band 3 is raised, not mistaken for a short pack', async () => {
  await withRepo({ fatal: 'fatal: no such object' }, async (remote, { shas }) => {
    await assert.rejects(() => remote.fetchPack(shas[2]!, 1), /remote error: fatal: no such object/);
  });
});

test('a missing packfile section, and a packfile-uris redirect, are both refused', async () => {
  await withRepo({ omitPackfile: true }, async (remote, { shas }) => {
    await assert.rejects(() => remote.fetchPack(shas[2]!, 1), /no packfile section/);
  });
  await withRepo({ packfileUris: true }, async (remote, { shas }) => {
    await assert.rejects(() => remote.fetchPack(shas[2]!, 1), /packfile-uris/);
  });
});

test('an oversized response is abandoned while streaming, not buffered and then rejected', async () => {
  // 2 MiB of band-2 progress noise: discarded by the demux, but it still crossed the wire, and the
  // cap counts what crossed the wire rather than what survived it.
  const repo = new RepoBuilder();
  const shas = repo.linear(1, { firstCommittedAt: AT });
  const server = await startGitServer({
    objects: repo.objects,
    refs: { 'refs/heads/main': shas[0]! },
    misbehave: { progressBytes: 2 * 1024 * 1024 },
  });
  try {
    const remote = new GitRemote(server.url, { timeoutMs: 5000, maxPackBytes: 64 * 1024 });
    await assert.rejects(() => remote.fetchPack(shas[0]!, 1), /exceeded the 65536 byte cap/);
  } finally {
    await server.close();
  }
});

test('malformed arguments are refused before a request is made', async () => {
  await withRepo(undefined, async (remote, { server }) => {
    await assert.rejects(() => remote.fetchPack('not-a-sha', 1), /is not an object id/);
    await assert.rejects(() => remote.fetchPack('a'.repeat(40), 0), /depth must be a positive integer/);
    await assert.rejects(() => remote.lsRefs(['refs/heads/main\nwant x']), /framing character/);
    assert.equal(server.commands.length, 0, 'none of those reached the network');
  });
});
