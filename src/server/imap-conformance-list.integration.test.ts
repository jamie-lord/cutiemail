/**
 * RFC 9051 wire conformance: LIST and IDLE.
 *
 * LIST is how every mail client discovers what exists, and the two requirements that matter most
 * here pull in opposite directions: an unrecognised OPTION must draw BAD, while a PATTERN the
 * server does not accept must be silently ignored and still return OK. Getting them the wrong way
 * round is invisible in a single test and obvious to a user — a client walking a hierarchy asks
 * about names that may not exist, and a server that answers NO stops the walk dead.
 *
 * IDLE is where push mail lives. Its requirements are about what arrives with no command to
 * correlate it against, which is a category no single-connection test can reach.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imapRequirement, type ImapRequirementId } from '../register/imap/index.ts';
import { withImapServer } from '../testing/imap-fixture.ts';
import { untaggedOf, type ImapClient } from '../testing/imap-client.ts';

const cites = (id: ImapRequirementId): void => assert.ok(imapRequirement(id).id === id);

/** The mailbox names in a LIST reply, unquoted. */
function listedNames(untagged: readonly string[]): string[] {
  return untagged
    .filter((l) => /^\* LIST /.test(l))
    .map((l) => /("(?:[^"\\]|\\.)*"|\S+)\s*$/.exec(l)?.[1] ?? '')
    .map((n) => n.replace(/^"|"$/g, ''));
}

/** A small hierarchy: one parent with two children, plus a sibling leaf. */
async function buildHierarchy(c: ImapClient): Promise<void> {
  for (const name of ['Work', 'Work/Invoices', 'Work/Notes', 'Personal']) {
    const reply = await c.command(`CREATE ${name}`);
    assert.equal(reply.status, 'OK', `CREATE ${name}: ${reply.line}`);
  }
}

test('a "%" pattern stays within one hierarchy level and "*" crosses them', async () => {
  cites('R-9051-6.3.9-a');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    await buildHierarchy(c);

    const oneLevel = await c.command('LIST "" %');
    assert.equal(oneLevel.status, 'OK', oneLevel.line);
    const top = listedNames(oneLevel.untagged);
    assert.ok(top.includes('Work'), `the top level is listed: ${top.join(', ')}`);
    // The distinction that makes a folder tree a tree. A server treating % as * shows a client a
    // flat list of everything where it expected one level.
    assert.ok(!top.includes('Work/Invoices'), `% must not cross the hierarchy separator: ${top.join(', ')}`);

    const everything = await c.command('LIST "" *');
    const all = listedNames(everything.untagged);
    for (const name of ['Work', 'Work/Invoices', 'Work/Notes', 'Personal']) {
      assert.ok(all.includes(name), `* reaches every level, missing ${name}: ${all.join(', ')}`);
    }

    // And a pattern that names one subtree returns that subtree only.
    const subtree = await c.command('LIST "" Work/%');
    const under = listedNames(subtree.untagged);
    assert.ok(under.includes('Work/Invoices') && under.includes('Work/Notes'), under.join(', '));
    assert.ok(!under.includes('Personal'), `a scoped pattern does not reach a sibling: ${under.join(', ')}`);
  });
});

test('a pattern that matches nothing is an empty OK, not an error', async () => {
  cites('R-9051-6.3.9-b');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    await buildHierarchy(c);

    const reply = await c.command('LIST "" "no-such-thing/%"');
    // "Silently ignored, i.e., it results in no LIST responses, and the LIST command still returns a
    // tagged OK response." Both halves, and the OK is the half a client depends on.
    assert.equal(reply.status, 'OK', `an unmatched pattern is still OK: ${reply.line}`);
    assert.deepEqual(listedNames(reply.untagged), [], `and lists nothing: ${reply.untagged.join(' | ')}`);
  });
});

test('an unrecognised option draws BAD, in either option group', async () => {
  cites('R-9051-6.3.9-d');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    await buildHierarchy(c);
    for (const command of [
      'LIST "" * RETURN (NOSUCHOPTION)',
      'LIST "" * RETURN (CHILDREN NOSUCHOPTION)', // one bad option among good ones
      'LIST (NOSUCHOPTION) "" *', // the selection group binds the same rule
      'LIST (RECURSIVEMATCH) "" *', // §6.3.9.2: not permitted as the ONLY selection option
    ]) {
      const reply = await c.command(command);
      assert.equal(reply.status, 'BAD', `${command} must draw BAD: ${reply.line}`);
    }
    // The negative controls. Every option RFC 9051 §6.3.9.1/§6.3.9.5 and RFC 6154 define is one
    // this server MUST support, so none of them may be swept up by the check above — otherwise
    // this test would pass against a server that BADs every option it is given.
    for (const command of [
      'LIST (SUBSCRIBED) "" *',
      'LIST (REMOTE) "" *',
      'LIST (SUBSCRIBED RECURSIVEMATCH) "" *', // a multi-option group, which a space-split parse mangles
      'LIST (SPECIAL-USE) "" *',
      'LIST "" * RETURN (SUBSCRIBED CHILDREN SPECIAL-USE)',
      'LIST "" * RETURN (STATUS (MESSAGES UNSEEN))',
    ]) {
      const reply = await c.command(command);
      assert.equal(reply.status, 'OK', `${command} is an option we must support: ${reply.line}`);
    }
  });
});

test('RETURN (STATUS ...) answers the same untagged STATUS the STATUS command would', async () => {
  cites('R-9051-6.3.9-d');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    fx.seed('INBOX', 3);
    // §6.3.9.5 defines the option as returning "the same untagged STATUS response", so the two
    // routes must produce identical bytes for the same mailbox — which is why they are the same
    // code. Recognising the option and then ignoring it would leave a client that asked for
    // message counts reading a reply that silently contains none.
    const viaList = (await c.command('LIST "" INBOX RETURN (STATUS (MESSAGES UIDNEXT))')).untagged.filter((l) => l.startsWith('* STATUS'));
    const viaStatus = (await c.command('STATUS INBOX (MESSAGES UIDNEXT)')).untagged.filter((l) => l.startsWith('* STATUS'));
    assert.deepEqual(viaList, viaStatus, 'one mailbox, one answer, whichever command asked');
    assert.match(viaList[0]!, /MESSAGES 3/, `and it is the real count: ${viaList[0]}`);

    // The option must not widen the result set either (R-9051-6.3.9-c): a name that does not
    // exist draws no STATUS, and a non-selectable intermediate draws none either.
    await c.command('CREATE deep/child');
    const walked = await c.command('LIST "" % RETURN (STATUS (MESSAGES))');
    assert.equal(walked.status, 'OK', walked.line);
    assert.ok(
      !walked.untagged.some((l) => /^\* STATUS "?deep"? /.test(l)),
      `a \\NonExistent intermediate has no status to report: ${walked.untagged.join(' | ')}`,
    );
  });
});

test('a return option changes what is said, not which mailboxes match', async () => {
  cites('R-9051-6.3.9-c');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    await buildHierarchy(c);

    const plain = listedNames((await c.command('LIST "" %')).untagged).sort();
    const withChildren = listedNames((await c.command('LIST "" % RETURN (CHILDREN)')).untagged).sort();
    // An easy mistake if CHILDREN is implemented by walking children and emitting them.
    assert.deepEqual(withChildren, plain, 'RETURN (CHILDREN) must not widen the result set');
  });
});

test('RETURN (CHILDREN) reports both attributes, on every matched mailbox', async () => {
  cites('R-9051-6.3.9.5-a');
  cites('R-9051-6.3.9.5-b');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    await buildHierarchy(c);

    const reply = await c.command('LIST "" % RETURN (CHILDREN)');
    assert.equal(reply.status, 'OK', reply.line);
    const lines = reply.untagged.filter((l) => /^\* LIST /.test(l));
    const work = lines.find((l) => /"?Work"?\s*$/.test(l));
    const personal = lines.find((l) => /"?Personal"?\s*$/.test(l));
    assert.ok(work !== undefined && personal !== undefined, `both mailboxes listed: ${lines.join(' | ')}`);

    assert.match(work, /\\HasChildren/, `Work has children: ${work}`);
    // Both attributes, not just the interesting one: \HasNoChildren is what lets a client draw a
    // leaf without a disclosure triangle instead of probing to find out.
    assert.match(personal, /\\HasNoChildren/, `Personal must be positively marked as a leaf: ${personal}`);
  });
});

test('a repeated return option is treated as if it were given once', async () => {
  cites('R-9051-6.3.9-e');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    await buildHierarchy(c);

    const once = await c.command('LIST "" % RETURN (CHILDREN)');
    const twice = await c.command('LIST "" % RETURN (CHILDREN CHILDREN)');
    assert.equal(twice.status, 'OK', `a duplicated option is tolerated, not refused: ${twice.line}`);
    // The observable failure modes of "act as if once": duplicated attributes, or the same mailbox
    // listed twice.
    assert.deepEqual(listedNames(twice.untagged).sort(), listedNames(once.untagged).sort(), 'the same mailboxes');
    for (const line of twice.untagged.filter((l) => /^\* LIST /.test(l))) {
      const hasChildren = (line.match(/\\HasChildren/g) ?? []).length;
      const hasNoChildren = (line.match(/\\HasNoChildren/g) ?? []).length;
      assert.ok(hasChildren <= 1 && hasNoChildren <= 1, `no duplicated attributes: ${line}`);
    }
  });
});

test('LIST reports the hierarchy delimiter, consistently with the names it returns', async () => {
  cites('R-9051-6.3.9-a');
  await withImapServer(async (fx) => {
    const c = await fx.session();
    await buildHierarchy(c);
    const reply = await c.command('LIST "" *');
    const line = reply.untagged.find((l) => /^\* LIST .*Work\/Invoices/.test(l));
    assert.ok(line !== undefined, `Work/Invoices is listed: ${reply.untagged.join(' | ')}`);
    // The delimiter a client uses to construct and split names has to be the one actually in use.
    const delimiter = /^\* LIST \([^)]*\) ("[^"]*"|NIL) /.exec(line)?.[1];
    assert.equal(delimiter, '"/"', `the advertised delimiter matches the names: ${line}`);
  });
});

test('an unsolicited FETCH during IDLE carries a UID', async () => {
  cites('R-9051-6.3.13-a');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const idler = await fx.session();
    const writer = await fx.session();
    await idler.command('SELECT INBOX');
    await writer.command('SELECT INBOX');
    await idler.unsolicited();

    const tag = idler.nextTag();
    idler.writeRaw(`${tag} IDLE\r\n`);
    await idler.unsolicited(150); // consume the continuation request

    assert.equal((await writer.command('STORE 1 +FLAGS (\\Seen)')).status, 'OK');
    const pushed = await idler.unsolicited(500);

    const fetches = pushed.filter((l) => / FETCH /.test(l));
    if (fetches.length > 0) {
      // Conditional because the RFC's own phrasing is "if the server chooses to send unsolicited
      // FETCH responses" — sending none is conformant. Sending one without a UID is not: there is
      // no command to correlate it against, so the sequence number may already be stale.
      for (const line of fetches) assert.match(line, /\bUID \d+/, `an unsolicited FETCH must carry a UID: ${line}`);
    }

    idler.writeRaw('DONE\r\n');
    const done = await idler.readTagged(tag);
    assert.equal(done.status, 'OK', done.line);
  });
});

test('DONE ends IDLE immediately', async () => {
  cites('R-9051-6.3.13-b');
  await withImapServer(async (fx) => {
    fx.seed('INBOX', 1);
    const c = await fx.session();
    await c.command('SELECT INBOX');

    const tag = c.nextTag();
    c.writeRaw(`${tag} IDLE\r\n`);
    await c.unsolicited(150);

    // A client ends IDLE because it has something to do; every millisecond before the tagged OK is
    // a millisecond the user waits. Generous bound — this is catching "waits for the next poll
    // tick", not measuring latency.
    const started = Date.now();
    c.writeRaw('DONE\r\n');
    const done = await c.readTagged(tag, 10_000);
    const took = Date.now() - started;
    assert.equal(done.status, 'OK', done.line);
    assert.ok(took < 2000, `the tagged response follows DONE immediately, took ${took}ms`);

    // And the session is usable again straight away.
    assert.equal((await c.command('NOOP')).status, 'OK', 'ready to process other commands');
  });
});
