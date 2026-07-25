/**
 * Git's object model: identity, commit ancestry, tree parsing.
 *
 * The ancestry walk is a security control, not a convenience — it is the descendant rule from
 * ADR 0025 — and it operates on a graph the remote composed. So the cases below include the shapes
 * a hostile or merely broken graph takes: a cycle, an unbounded fan-out, a parent that was never
 * sent, and a merge that reaches the same commit by two paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestryFrom, isAncestor, objectId, parseCommit, parseTree, GitObjectError, type Commit } from './objects.ts';

test('object ids are the hash git computes, over the typed header and the content', () => {
  // The canonical example: `git hash-object` of an empty blob, and of "hello\n".
  assert.equal(objectId('blob', Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(objectId('blob', Buffer.from('hello\n', 'latin1')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  // The type is part of the identity: the same bytes as a different type is a different object.
  assert.notEqual(objectId('tree', Buffer.alloc(0)), objectId('blob', Buffer.alloc(0)));
});

test('a commit yields its tree, its parents, and the committer timestamp the bake rule uses', () => {
  const raw = Buffer.from(
    [
      'tree 1111111111111111111111111111111111111111',
      'parent 2222222222222222222222222222222222222222',
      'parent 3333333333333333333333333333333333333333',
      'author A U Thor <a@one.example> 1700000000 +0000',
      // Deliberately different from the author date: a rebase or a merge moves the COMMITTER date,
      // which is when the change actually landed on the branch — the only one bake time can use.
      'committer C O Mitter <c@one.example> 1700003600 +0100',
      '',
      'a message',
      '',
    ].join('\n'),
    'latin1',
  );
  const commit = parseCommit(raw);
  assert.equal(commit.tree, '1'.repeat(40));
  assert.deepEqual(commit.parents, ['2'.repeat(40), '3'.repeat(40)]);
  assert.equal(commit.committedAt, 1_700_003_600);
});

test('a commit without a usable tree or with a malformed parent is refused', () => {
  assert.throws(() => parseCommit(Buffer.from('author x\n\nmsg\n', 'latin1')), /no valid tree/);
  assert.throws(() => parseCommit(Buffer.from('tree short\n\nmsg\n', 'latin1')), /no valid tree/);
  assert.throws(
    () => parseCommit(Buffer.from(`tree ${'1'.repeat(40)}\nparent nope\n\nmsg\n`, 'latin1')),
    /malformed parent/,
  );
});

test('a tree yields its entries verbatim, including names the checkout will refuse', () => {
  const entry = (mode: string, name: string, id: string): Buffer =>
    Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'latin1'), Buffer.from(id, 'hex')]);
  const data = Buffer.concat([
    entry('100644', 'main.ts', '1'.repeat(40)),
    entry('40000', 'src', '2'.repeat(40)),
    entry('120000', '../escape', '3'.repeat(40)),
  ]);
  const entries = parseTree(data);
  assert.deepEqual(entries.map((e) => e.name), ['main.ts', 'src', '../escape']);
  assert.deepEqual(entries.map((e) => e.mode), ['100644', '40000', '120000']);
  assert.equal(entries[2]!.id, '3'.repeat(40));
  // Validation belongs to the checkout, in one place. Sanitising here as well would leave a second,
  // laxer parser for someone to find later.
});

test('a malformed tree is refused rather than partially read', () => {
  const id = Buffer.alloc(20, 0x11);
  const withMode = (mode: string): Buffer => Buffer.concat([Buffer.from(`${mode} x\0`, 'latin1'), id]);
  assert.throws(() => parseTree(Buffer.from('100644main.ts\0', 'latin1')), GitObjectError, 'no mode separator');
  assert.throws(() => parseTree(withMode('99999')), /malformed mode/, 'octal digits only');
  assert.throws(() => parseTree(withMode('1006440')), /malformed mode/, 'too long');
  assert.throws(() => parseTree(Buffer.from('100644 x\0short', 'latin1')), /truncated/);
  // The negative control: the same shape with a valid mode parses.
  assert.equal(parseTree(withMode('100644'))[0]!.id, '11'.repeat(20));
});

/** A commit graph as a lookup, for the ancestry tests. */
function graph(edges: Record<string, string[]>): (id: string) => Commit | undefined {
  return (id) => {
    const parents = edges[id];
    if (parents === undefined) return undefined;
    return { tree: '0'.repeat(40), parents, committedAt: 0 };
  };
}

test('the descendant rule accepts a real ancestor and refuses an unrelated commit', () => {
  const g = graph({ d: ['c'], c: ['b'], b: ['a'], a: [], x: [] });
  assert.equal(isAncestor('a', 'd', g), true);
  assert.equal(isAncestor('d', 'd', g), true, 'a commit is its own ancestor: nothing to update to');
  assert.equal(isAncestor('x', 'd', g), false, 'a disjoint history is exactly what a force-push leaves');
  assert.equal(isAncestor('d', 'a', g), false, 'and the rule is directional: no moving backwards');
});

test('a parent that was never sent is still visited, so "cut short" is distinguishable from "not there"', () => {
  // A shallow fetch cuts history at a boundary. The boundary commit still NAMES its parent, and
  // that name is what tells the caller to fetch deeper rather than to refuse the update.
  const g = graph({ c: ['b'], b: ['a'] }); // `a` itself was not sent
  const walked = ancestryFrom('c', g);
  assert.deepEqual([...walked], ['c', 'b', 'a']);
  assert.equal(isAncestor('a', 'c', g), true);
});

test('a merge reaching the same commit twice is ordinary history, not a bound violation', () => {
  //   m -> l, r -> both -> base
  const g = graph({ m: ['l', 'r'], l: ['base'], r: ['base'], base: [] });
  // Four distinct commits: a bound of 4 must accept it even though `base` is queued twice.
  assert.equal(ancestryFrom('m', g, 4).size, 4);
  assert.equal(isAncestor('base', 'm', g, 4), true);
});

test('a fabricated graph cannot walk forever', () => {
  const cycle = graph({ a: ['b'], b: ['c'], c: ['a'] });
  assert.equal(ancestryFrom('a', cycle).size, 3, 'a cycle terminates: an id is visited once');

  // A long chain is refused at the bound rather than walked.
  const long: Record<string, string[]> = {};
  for (let i = 0; i < 500; i++) long[`c${i}`] = [`c${i + 1}`];
  assert.throws(() => ancestryFrom('c0', graph(long), 100), /exceeded 100 commits/);
  // The negative control for the bound: the same walk with room to finish.
  assert.doesNotThrow(() => ancestryFrom('c0', graph(long), 1000));
});
