/**
 * Negative controls for the checkout, which is the one place the updater turns remote-chosen names
 * into filesystem paths.
 *
 * Every case below is a real attack against real git implementations. A gate never shown to fail
 * does not count as a gate, and that matters more here than anywhere else in the project: a
 * checkout that silently skips a hostile entry produces a tree that looks complete, and a
 * pre-flight that then passes is a false assurance rather than a safeguard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutTree, isSafeComponent, CheckoutError } from './checkout.ts';
import { objectId, type GitObject } from './objects.ts';

/** Build a tree object from entries, and an object map that resolves them. */
function treeWith(entries: Array<{ mode: string; name: string; target: GitObject }>): {
  treeId: string;
  objects: Map<string, GitObject>;
} {
  const objects = new Map<string, GitObject>();
  const parts: Buffer[] = [];
  for (const e of entries) {
    const id = objectId(e.target.type, e.target.data);
    objects.set(id, e.target);
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'latin1'), Buffer.from(id, 'hex'));
  }
  const data = Buffer.concat(parts);
  const treeId = objectId('tree', data);
  objects.set(treeId, { type: 'tree', data });
  return { treeId, objects };
}

const blob = (s: string): GitObject => ({ type: 'blob', data: Buffer.from(s, 'latin1') });

function inTmp<T>(fn: (dir: string) => T): T {
  const base = mkdtempSync(join(tmpdir(), 'cutiemail-checkout-'));
  try {
    return fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('a well-formed tree is written, with directories and the executable bit honoured', () => {
  inTmp((base) => {
    const inner = treeWith([{ mode: '100755', name: 'run.sh', target: blob('#!/bin/sh\n') }]);
    const outer = treeWith([
      { mode: '100644', name: 'main.ts', target: blob('export const x = 1;\n') },
      { mode: '40000', name: 'bin', target: outer_dir(inner) },
    ]);
    for (const [k, v] of inner.objects) outer.objects.set(k, v);
    const root = join(base, 'wt');
    const n = checkoutTree(outer.treeId, root, (id) => outer.objects.get(id));
    assert.equal(n, 2);
    assert.equal(readFileSync(join(root, 'main.ts'), 'latin1'), 'export const x = 1;\n');
    assert.equal(readFileSync(join(root, 'bin', 'run.sh'), 'latin1'), '#!/bin/sh\n');
  });

  // A directory entry's "target" is the inner tree object itself.
  function outer_dir(t: { treeId: string; objects: Map<string, GitObject> }): GitObject {
    return t.objects.get(t.treeId)!;
  }
});

test('component rules reject every shape that escapes or shadows', () => {
  for (const bad of [
    '..',
    '.',
    '',
    'a/b',
    'a\\b',
    'x\0y',
    '.git',
    '.GIT',
    '.Git',
    'trailing.',
    'trailing ',
    'x'.repeat(256),
  ]) {
    assert.equal(isSafeComponent(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
  for (const ok of ['main.ts', 'src', '.gitignore', 'a-b_c.d', '.well-known']) {
    assert.equal(isSafeComponent(ok), true, `${JSON.stringify(ok)} must be allowed`);
  }
});

test('a traversal entry is refused, and the partial checkout is removed', () => {
  inTmp((base) => {
    const { treeId, objects } = treeWith([
      { mode: '100644', name: 'ok.ts', target: blob('fine\n') },
      { mode: '100644', name: '../escaped.ts', target: blob('pwned\n') },
    ]);
    const root = join(base, 'wt');
    assert.throws(() => checkoutTree(treeId, root, (id) => objects.get(id)), CheckoutError);
    assert.equal(existsSync(join(base, 'escaped.ts')), false, 'nothing was written outside the root');
    assert.equal(existsSync(root), false, 'and the partial tree was cleaned up, not left half-written');
  });
});

test('a .git path is refused whatever its case', () => {
  for (const name of ['.git', '.GIT', '.Git']) {
    inTmp((base) => {
      const { treeId, objects } = treeWith([{ mode: '40000', name, target: { type: 'tree', data: Buffer.alloc(0) } }]);
      assert.throws(
        () => checkoutTree(treeId, join(base, 'wt'), (id) => objects.get(id)),
        CheckoutError,
        `${name} must be refused`,
      );
    });
  }
});

test('symlink and gitlink modes are refused outright, not skipped', () => {
  // A symlink is dangerous because a LATER entry writes through it, escaping a root that every
  // individual path check passed. Refusing the mode is the only defence independent of ordering.
  for (const mode of ['120000', '160000', '100664', '040000x'.slice(0, 6)]) {
    inTmp((base) => {
      const { treeId, objects } = treeWith([{ mode, name: 'evil', target: blob('/') }]);
      assert.throws(
        () => checkoutTree(treeId, join(base, 'wt'), (id) => objects.get(id)),
        CheckoutError,
        `mode ${mode} must be refused`,
      );
    });
  }
});

test('a missing object is a refusal, not a hole in the tree', () => {
  inTmp((base) => {
    const { treeId, objects } = treeWith([{ mode: '100644', name: 'a.ts', target: blob('x') }]);
    // Drop the blob, keeping the tree that references it — a truncated or thin pack.
    for (const [k, v] of [...objects]) if (v.type === 'blob') objects.delete(k);
    assert.throws(() => checkoutTree(treeId, join(base, 'wt'), (id) => objects.get(id)), /missing from the pack/);
  });
});

test('file-count and byte limits are enforced', () => {
  inTmp((base) => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ mode: '100644', name: `f${i}.ts`, target: blob('x') }));
    const { treeId, objects } = treeWith(entries);
    assert.throws(
      () => checkoutTree(treeId, join(base, 'wt'), (id) => objects.get(id), { maxFiles: 3, maxTotalBytes: 1 << 20, maxDepth: 8 }),
      /more than 3 files/,
    );
  });
  inTmp((base) => {
    const { treeId, objects } = treeWith([{ mode: '100644', name: 'big.ts', target: blob('x'.repeat(100)) }]);
    assert.throws(
      () => checkoutTree(treeId, join(base, 'wt'), (id) => objects.get(id), { maxFiles: 10, maxTotalBytes: 10, maxDepth: 8 }),
      /exceeds 10 bytes/,
    );
  });
});
