/**
 * Restore round-trip — the other half of backup.
 *
 * backup.test.ts proves a snapshot is CONSISTENT and VERIFIES; this proves it actually
 * RESTORES: take a real backup, simulate losing the data directory, copy the snapshot back
 * exactly as DEPLOYMENT.md documents, boot the real daemon (`startServer`) against it, and
 * confirm every restored surface:
 *   - SCRAM auth succeeds (the credential registry came back);
 *   - IMAP FETCH BODY[] is byte-exact (the mail came back unchanged);
 *   - the outbound queue and the dead-letter store came back intact.
 * Plus the DEPLOYMENT.md promise for an account whose mailbox file is absent from the
 * backup (it never received mail): it must come back as an EMPTY mailbox that still
 * authenticates, not a failed restore.
 *
 * A note on the restore TARGET. `account add` records each mailbox at an absolute path
 * (`join(dirname(controlDb), 'mail-<login>.db')`), and the registry is the source of truth
 * for that path at boot — so a faithful restore puts the snapshot back at the SAME location
 * it came from, which is exactly what DEPLOYMENT.md does (`cp /backups/*.db over
 * /var/lib/mailserver/`). These tests therefore restore in place: wipe the data directory's
 * databases (and any sidecars) and copy the verified snapshot back over them.
 *
 * `startServer` is imported from ../main.ts for READ-ONLY use (driving the assembled daemon);
 * nothing here edits main.ts. `outboundMode: 'hold'` keeps the relay loop from ever running,
 * so a restored, still-due queue row is inspected without a byte leaving for a real MX.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../main.ts';
import { runBackup } from './backup.ts';
import { runAccount, type PasswordSource } from './account.ts';
import { SqliteCatalog } from '../store/sqlite-mailbox.ts';
import { SqliteQueue } from '../store/sqlite-queue.ts';
import { openMailDb } from '../store/open-mail-db.ts';
import { TEST_CERT, TEST_KEY } from '../testing/tls-test-cert.ts';

const DOMAIN = 'mail.example.test';
const PASSWORD = 'restore-round-trip-pw';
const silentIo = { out: (): void => {}, err: (): void => {} };
const pw: PasswordSource = { interactive: false, read: () => Promise.resolve(PASSWORD) };
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Wipe a data directory's databases + WAL/SHM sidecars, then copy every *.db from the backup back. */
function restoreInPlace(dataDir: string, backupDir: string): void {
  for (const f of readdirSync(dataDir)) {
    if (f.endsWith('.db') || f.endsWith('.db-wal') || f.endsWith('.db-shm')) rmSync(join(dataDir, f));
  }
  for (const f of readdirSync(backupDir)) {
    if (f.endsWith('.db')) cpSync(join(backupDir, f), join(dataDir, f));
  }
}

interface Session {
  readonly ok: boolean;
  readonly exists: number;
  readonly body: Buffer | null;
}

/** IMAPS LOGIN + SELECT INBOX (capturing EXISTS) + FETCH 1 BODY[] when the mailbox is non-empty. */
async function imapSession(port: number, user: string, pass: string): Promise<Session> {
  const sock = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
  const chunks: Buffer[] = [];
  sock.on('data', (d) => chunks.push(Buffer.from(d)));
  sock.on('error', () => {});
  await new Promise<void>((r) => sock.once('secureConnect', () => r()));
  const all = (): Buffer => Buffer.concat(chunks);
  const waitFor = async (needle: string): Promise<string> => {
    for (let i = 0; i < 600; i++) {
      const at = all().indexOf(Buffer.from(needle, 'latin1'));
      if (at !== -1) return all().subarray(0, at + needle.length).toString('latin1');
      await delay(5);
    }
    throw new Error(`timed out waiting for ${needle}`);
  };
  try {
    await waitFor('* OK');
    sock.write(Buffer.from(`a1 LOGIN ${user} ${pass}\r\n`, 'latin1'));
    let loginOk: boolean | null = null;
    for (let i = 0; i < 600 && loginOk === null; i++) {
      const s = all().toString('latin1');
      if (s.includes('a1 OK')) loginOk = true;
      else if (s.includes('a1 NO')) loginOk = false;
      else await delay(5);
    }
    if (loginOk !== true) return { ok: false, exists: 0, body: null };
    sock.write(Buffer.from('a2 SELECT INBOX\r\n', 'latin1'));
    const sel = await waitFor('a2 OK');
    const exists = Number(/\* (\d+) EXISTS/.exec(sel)?.[1] ?? '0');
    let body: Buffer | null = null;
    if (exists > 0) {
      const before = all().length;
      sock.write(Buffer.from('a3 FETCH 1 BODY[]\r\n', 'latin1'));
      await waitFor('a3 OK');
      const resp = all().subarray(before);
      const marker = /\{(\d+)\}\r\n/.exec(resp.toString('latin1'))!;
      const start = resp.indexOf(Buffer.from(marker[0], 'latin1')) + marker[0].length;
      body = Buffer.from(resp.subarray(start, start + Number(marker[1])));
    }
    return { ok: true, exists, body };
  } finally {
    sock.end();
  }
}

test('restore round-trip: SCRAM auth, byte-exact IMAP FETCH, and queue/dead-letter all come back', async () => {
  const data = tmp('restore-live-');
  const backup = tmp('restore-backup-');
  const controlPath = join(data, 'control.db');
  const mailPath = join(data, 'mail-alice.db');
  const message = Buffer.from('Subject: restored\r\nFrom: someone@elsewhere.test\r\n\r\nthis body must survive the round trip\r\n', 'latin1');
  const deadData = Buffer.from('the message delivery permanently gave up on\r\n', 'latin1');
  let liveQueueId = '';
  try {
    // --- Build a real live world through the production code paths. ---
    assert.equal(await runAccount(['add', 'alice', '--db', controlPath], silentIo, {}, pw), 0);
    {
      const db = openMailDb(mailPath);
      SqliteCatalog.open(db, 1).get('INBOX')!.append(message);
      db.close();
    }
    {
      const cdb = openMailDb(controlPath);
      const q = SqliteQueue.open(cdb);
      liveQueueId = q.enqueue(`alice@${DOMAIN}`, ['bob@remote.invalid'], Buffer.from('still queued', 'latin1'), 1000);
      const dlId = q.enqueue(`alice@${DOMAIN}`, ['carol@remote.invalid'], deadData, 1000);
      const entry = q.due(2000).find((e) => e.id === dlId)!;
      q.deadLetter(entry, { failedRecipients: ['carol@remote.invalid'], lastError: '550 5.1.1 no such user', now: 3000 });
      cdb.close();
    }

    // --- Back up, lose the data directory, restore the snapshot in place (DEPLOYMENT.md). ---
    assert.equal(runBackup([backup, '--db', controlPath], silentIo, {}), 0);
    restoreInPlace(data, backup);

    // --- Boot the real daemon against the restored files and prove every surface. ---
    const server = await startServer({
      dbPath: controlPath,
      host: '127.0.0.1',
      smtpPort: 0,
      submissionPort: 0,
      imapPort: 0,
      domain: DOMAIN,
      accounts: [], // passwordless: the restored registry is the sole source of accounts
      tls: { key: TEST_KEY, cert: TEST_CERT },
      outboundMode: 'hold', // never relay the restored queue row
    });
    try {
      const good = await imapSession(server.imap.port, 'alice', PASSWORD);
      assert.ok(good.ok, 'SCRAM auth succeeds against the restored credential registry');
      assert.equal(good.exists, 1, 'the restored mailbox holds its one message');
      assert.deepEqual(good.body, message, 'FETCH BODY[] is byte-exact after the restore');

      // A wrong password still fails — the restore did not weaken auth.
      assert.equal((await imapSession(server.imap.port, 'alice', 'wrong-password')).ok, false);

      // The outbound queue and dead-letter store survived the snapshot intact.
      assert.equal(server.queue.size, 1, 'the live queue row survived the restore');
      assert.equal(server.queue.due(10_000)[0]!.id, liveQueueId, 'the same queue entry, by id');
      const dls = server.queue.listDeadLetters();
      assert.equal(dls.length, 1, 'the dead-letter row survived the restore');
      assert.deepEqual(dls[0]!.data, deadData, 'dead-letter bytes are byte-exact');
    } finally {
      await server.close();
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  }
});

test('restore round-trip: an account whose mailbox file is missing from the backup boots as an empty, authenticable mailbox', async () => {
  const data = tmp('restore-live-');
  const backup = tmp('restore-backup-');
  const controlPath = join(data, 'control.db');
  try {
    // alice exists in the registry but never received mail, so mail-alice.db is never created.
    assert.equal(await runAccount(['add', 'alice', '--db', controlPath], silentIo, {}, pw), 0);

    // backup snapshots the control DB and SKIPS the missing mailbox file (no mail yet).
    assert.equal(runBackup([backup, '--db', controlPath], silentIo, {}), 0);
    const snapped = readdirSync(backup);
    assert.deepEqual(snapped.filter((f) => f.endsWith('.db')).sort(), ['control.db'], 'only the control DB is in the backup');

    restoreInPlace(data, backup);

    const server = await startServer({
      dbPath: controlPath,
      host: '127.0.0.1',
      smtpPort: 0,
      submissionPort: 0,
      imapPort: 0,
      domain: DOMAIN,
      accounts: [],
      tls: { key: TEST_KEY, cert: TEST_CERT },
      outboundMode: 'hold',
    });
    try {
      const s = await imapSession(server.imap.port, 'alice', PASSWORD);
      // DEPLOYMENT.md's exact promise: comes back as an empty mailbox, not a failed restore.
      assert.ok(s.ok, 'the account still authenticates (its credentials restored)');
      assert.equal(s.exists, 0, 'the mailbox is empty rather than failing the boot');
    } finally {
      await server.close();
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  }
});
