# Backlog: open work, and what was deliberately declined

This is the one live list of what is **not yet done**. Every open item states its evidence and
one mission-rooted sentence on why it matters, the bar the
[working agreement](WORKING-AGREEMENT.md) sets. The ledger below holds everything that was
weighed and **declined**, each with its reason, so a cut is a recorded decision and not a silent
gap. For what the server already does and how it is proven, see [TESTING.md](TESTING.md) and
[the decision records](decisions/0000-about-these-decisions.md).

A test-coverage audit (2026-07-21) worked through ~30 candidate gaps. ~25 became
reproduce-first, negative-controlled tests. The suite stood at 1162 cases after that audit. The
rest are recorded declines in the ledger below or new decision records (ADRs
[0021](decisions/0021-imap-mailbox-name-encoding.md),
[0022](decisions/0022-eai-smtputf8-scope.md),
[0023](decisions/0023-outbound-delivery-semantics.md)). The correctness / usability / security
queue is empty again except for the follow-ups below.

## Closed: the conformance gaps found by the register expansion

A register-and-test pass (2026-07-26) took the IMAP register from 21 requirements to 66, and the
crypto register from 23 to 40. It also pointed the SMTP conformance corpus at this project's own
inbound listener for the first time. Ten MUST/SHOULD-level findings came out of it. Each finding
was written first as a running test marked as a known gap, so the obligation stayed executable
while it was open. All ten are now resolved and the suite carries no gap markers.

| # | Requirement | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | RFC 9051 §6.3.6 | `RENAME` did not move inferior hierarchical names. A rename of `foo` to `baz` left `foo/bar` unreachable under either name. This orphaned the mailbox and the mail in it. It was shaped like data loss, and the most serious of the ten. | Fixed. Both catalogs share `subtreeRenames` in `store/mailbox-name.ts`, so the reference and the real store cannot drift. A destination collision anywhere in the subtree refuses the whole rename. INBOX's own inferior names stay put, as §6.3.6 requires. |
| 2 | RFC 9051 §6.2.2 | An invalid base64 response to `AUTHENTICATE` drew `NO [AUTHENTICATIONFAILED]` where the RFC requires a tagged `BAD`. `NO` sends a client back to the user for a new password. `BAD` tells it that its own encoding is broken. A client with a SASL bug went into a re-prompt loop against a user whose password was correct. | Fixed on both the continuation path and the RFC 4959 initial-response path. Node's base64 decoder is the reason this needed an explicit gate. It skips characters outside the alphabet and stops at the first `=`, so garbage decoded to a short buffer and failed the credential check instead. |
| 3 | RFC 9051 §6.3.9 | `LIST` accepted an unrecognised `RETURN` option instead of an answer of `BAD`. The neighbouring rule pulls the other way: the server must silently ignore an unmatched PATTERN and still return `OK`. | Fixed, and it needed a real parser. The option groups were read as single space-split tokens, so `LIST (SUBSCRIBED RECURSIVEMATCH) "" *` had already silently mangled its own pattern. `RETURN (STATUS …)` is now answered rather than ignored, because §6.3.9 also requires support for the options the document defines. |
| 4 | RFC 6376 §6.1.1 | A DKIM signature with `v=2` verified instead of a return of PERMFAIL (incompatible version). | Fixed in the signature parser, where §6.1.1 puts the "meticulously validate" obligation. |
| 5 | RFC 6376 §6.1.1 | `a=rsa-sha999` verified. `a=` was read by suffix, so anything that did not end `sha1` was treated as SHA-256. The signer and verifier disagreed about what was computed. | Fixed with a closed algorithm set. `rsa-sha1` stays in it deliberately. RFC 8301 refuses it as a cryptographic *failure*, which is a different answer from a syntax error. |
| 6 | RFC 6376 §6.1.2 | Recorded as a defect. It was not one. The key-record parser already refuses a `v=` that is not `DKIM1`, so the key side of the version rule was in place while the signature side (#4) was missing. | No change. The case is kept as the pin and widened to cover a version that is known but not first. |
| 7 | RFC 7208 §5.2 | An `include` whose recursive evaluation returned permerror was treated as "not match". This was also how the ten-lookup limit was escaped: blow the shared budget inside an included record, the error is discarded, and evaluation continues. `temperror` propagated. `permerror` and `none` did not. | Fixed by a full implementation of the §5.2 result table. The redirect sibling in §6.1 was wrong the same way and is fixed with it, now registered as R-7208-6.1-a. |
| 8 | RFC 7208 §4.6.4 | An `mx` mechanism whose MX record named more than ten hosts was evaluated in full rather than a result of permerror. | Fixed, and the same code was wrong in the opposite direction too. The MX-target address lookups were charged to the ten-*term* budget, which §4.6.4 puts them "in addition to". A legitimate domain that publishes ten MX hosts and the record `v=spf1 mx -all` was handed a permerror it had not earned. The over-wide case only produced the right answer because the term budget ran out first. |
| 9 | RFC 8461 §3.2 | An MTA-STS policy that omitted `max_age` parsed as valid, so it had no defined lifetime. | Fixed at the parse, where a caller that reads `.valid` can no longer act on it. The cache already declined to store such a policy, so nothing downstream changed. |
| 10 | RFC 8461 §3.1 | Not a defect. The resolver already refuses a TXT record whose version field is not first. | No change. The case exists because nothing pinned it and the natural "tolerant parser" change would remove the check silently. |

Three of the eight real defects (4, 5, 7) are the shape the security audits keep finding: **a guard
applied to one path and not its structural sibling.** Two more were found only because a test
harness was rebuilt. The DKIM cases originally edited an already-signed message, which invalidates
the signature, so "must not pass" passed for the wrong reason and proved nothing.

Every fix was verified by mutation: thirteen mutants across the eight defects. Each mutant breaks
one guard, and the test that names the requirement kills each one. Every file was restored
byte-exactly afterwards. Two of the thirteen exist only because a passing test can pass for the
wrong reason. One lifts the `mx` cap and one puts the address lookups back on the term budget, and
the original case would have survived the second.

## Closed: what a live self-update test found

The self-update system (ADR 0025) was exercised against a real Hetzner box for the first time.
Every rung of the ladder had passed in local rehearsal. The box found **nine defects**. Local
testing could not have found any of them, because each was a property of the machine rather than
of the code.

| # | Defect | Why only a real deployment finds it |
| --- | --- | --- |
| 1 | The smart-HTTP client refused every real git server. It expected the v2 advertisement to begin `version 2`, and GitHub, GitLab and Codeberg all prefix it with the `# service=` banner. | The in-repo fake server had been written from the same reading of the spec as the client, so the two agreed with each other and not with reality. |
| 2 | The daemon exited 0 silently when started through the `current` symlink. `import.meta.url` resolves symlinks, `process.argv[1]` does not. | ADR 0025's whole layout runs the daemon through that symlink. A flat checkout never hits it. |
| 3 | `hetzner-up.sh` hung forever in a wait for cloud-init. `cloud-init status` exits 2 when it finishes *degraded*, and under `set -o pipefail` that exit code replaced the success of `grep`. | Needs a real cloud-init, and a cloud-config with a schema slip to make it degrade. |
| 4 | Rung 4 ran the candidate's whole test suite, which does not finish inside its fifteen-minute cap on two shared cores. Every update was refused, and the candidate was blamed. | The suite takes ~110s on a developer machine. Only the target hardware shows it. |
| 5 | The updater could not read the databases it exists to snapshot. | Requires the real two-user deployment. A developer runs both halves as themselves. |
| 6 | A WAL database is three files, and only the one with the name was secured. The sidecars are recreated at every checkpoint, so they reverted to owner-only and refused every reader the main file admitted. | Needs a live database that a running daemon checkpoints. |
| 7 | The post-cutover probe ran before the daemon was listening, so every cutover reverted a good version. `systemctl start` returns when a `Type=simple` process has *forked*, not when it serves. The gap measured 459ms on this box. | A local rehearsal starts the candidate and waits for its ports. Only systemd reports success this early. |
| 8 | No lock on the version store. A hand-run `apply` during a timer tick reverted a cutover that had already switched and passed its probe. Every run begins with the *recovery* of an interrupted cutover, and cannot tell another process's legitimate in-progress switch from a crashed one. | Needs a timer that fires on its own schedule alongside an operator. |
| 9 | A failed start was waited out for the full 120-second probe window before it was called a failure, when systemd already knew the unit was dead. | Only shows up as wasted downtime on a real cutover. |

The failure paths were then exercised deliberately, on side branches so `main` stayed clean:

| Drill | Result |
| --- | --- |
| A module the installed runtime cannot parse | Refused at rung 4 in 325ms, with the module named. Nothing started, nothing switched. |
| Submission AUTH broken for every login | Refused at rung 6b, against a snapshot of real data. This was before the switch, so no revert was necessary. |
| A version that dies under the unit's sandbox (writes outside `ReadWritePaths`) | Passed **every** pre-flight rung, because the pre-flight spawns the candidate itself and there is no sandbox there. The live probe caught it after the switch and reverted. |
| `SIGKILL` in the instant between the symlink move and the restart | The next run broke the stale lock, read the recorded phase, reverted the version nothing had confirmed, and left the daemon serving. The timer applied the update again on its next tick. |
| A hand-run `apply` during a timer tick | Declined, with the holding pid named and a statement that nothing was changed. `status` still answered. |
| Three consecutive unattended cutovers, then an idle soak | Each one switched on its own. The soak reported "up to date" repeatedly with no churn. |

The sandbox drill is the one that matters, and it is the argument for the design. The pre-flight
cannot test the environment the daemon will actually run in. The cutover can, and its answer to a
failure is to rename the symlink back. Mail was intact after every drill: the same ten messages
throughout, a fresh delivery accepted after each, and no probe credential left behind.

Defect 4 changed the design rather than just the code. The rule that came out of it is **a
pre-flight check must be able to fail for a reason CI could not have caught**. Rungs 1 and 2 already
prove the checkout is byte-identical to a commit CI tested, so a re-run of deterministic tests
re-answers a settled question, and on two shared cores they could not finish inside their cap. What
the box uniquely knows is this runtime, this configuration, this data, and this old→new transition.
So the rung became "every module imports under the Node actually installed" (487ms, from a 900s
cap). To drop the suite is affordable because correctness-confidence and recoverability are
substitutes. For that reason the same change added the rung that boots the *running* version against
the migrated snapshot, rather than an inference of reversibility from a schema version number. The
whole ladder now finishes in ~43 seconds on the smallest box the project targets, which is the
point: the same assurance for a deployment that cannot afford to run a test suite.

Two properties worth carrying forward:

- **An updater defect that blocks updates is self-perpetuating.** The deployment cannot pull its own
  fix, because the broken check refuses every candidate. It bit three times during this exercise and
  each time needed a manual re-lay. That is what makes the staleness alarm load-bearing rather than
  decorative, and it is the argument for the existence of `check` mode at all.
- **Verification of the thing you changed is not verification of the thing that failed.** Defects 5
  and 6 were each "fixed" and confirmed on the box before they were found still broken. The
  confirmation looked at the file that had been edited rather than at the operation that was failing.
  `test -r` on a database whose sidecars are unreadable says readable.

## Closed: what a fifth security audit found

The first four runs covered the mail server. This one was weighted to `src/update/`, which did not
exist when run 4 was written and had never been audited, plus everything else changed since. Twelve
findings, all reproduced by running code, all fixed with a mutation-verified test.

The one that matters most is a **confused deputy**, and it defeats the property ADR 0025 exists to
deliver. The mail daemon owns the control database, so it chooses what an account's `login` says.
The updater reads logins back out and joins them into filesystem paths. So a compromised daemon
could steer the pre-flight's `VACUUM INTO`, and the rollback's `copyFileSync`, into the version
store it is forbidden to write. `ProtectSystem=strict` does not help. It constrains which process
writes, and the point is that a *different* process does the writing. Nothing reached execution,
because the content always carries the SQLite header and nothing loads a file it finds by
enumeration. So this was a boundary breach, not persistence.

| # | What | Where |
|---|---|---|
| 1 | A daemon-chosen login steered a snapshot write into the code store. The containment assert ran after every copy | `update/snapshot.ts` |
| 2 | The rollback followed a dangling symlink, which `existsSync` cannot see, out of the data directory | `update/cutover.ts` |
| 3 | A pre-flight that failed every run still refreshed the freshness clock, so the staleness alarm never fired | `update/state.ts` |
| 4 | Repeated STATUS items multiplied a mailbox scan per matched mailbox. This froze the whole event loop for every account | `server/imap-server.ts` |
| 5 | The APPEND fairness budget was keyed on the wire spelling of the login, so each case variant got a slice | `server/imap-server.ts` |
| 6 | An `mx` term queried both A and AAAA per host — twice the address records §4.6.4 permits — and `exists` ignored §5.7's A-only rule | `auth/spf-check.ts` |
| 7 | The provisioning rsync carried 3 of the 12 exclude patterns its siblings carry, and published key material at 0644 | `deploy/hetzner-up.sh` |
| 8 | Doc titles and ADR filenames reached `<title>` and two `href`s unescaped, so a filename alone put script on every published page | `site/build.mjs` |
| 9 | The submission fix-up validated truncation on its input and returned a larger buffer. The signer signed the truncated list | `server/submission-fixup.ts`, `server/dkim-signer.ts` |
| 10 | A subtree rename stored a name `CREATE` could not produce, which stranded a listed but unselectable mailbox | `store/mailbox-name.ts` |
| 11 | Rung 4 reported every module as loaded after it imported one, because a module that exits at import time ends the sweep with status 0 | `update/executable.ts` |
| 12 | The migration census ignored flags, internal dates, the expunge journal and the marks that govern future ids | `update/snapshot.ts` |

**Two findings were rejected during validation, and that is the more useful result.** A packfile
whose deltas expand without an aggregate bound, and a checkout whose limits count blobs but not
directories, are both real: 20 KiB became 1.6 GiB of live buffers, and 929 bytes became 87,381
directories. Neither is a security finding. An adversarial validator drove the real
`acquireCandidate` against the project's own test git server, and **925 bytes of fabricated history
passed both provenance rules**, so anyone able to serve those bytes can ship code instead, which
ADR 0025 already accepts. They were left as correctness defects at the time, because the honest
severity is low and the fix is a cap whose value nobody could yet justify from evidence. While they
stood, `packfile.ts`'s claim that "every dimension a hostile pack could grow along is bounded here"
was false, because resolved aggregate is a fifth dimension. **Both are now fixed** (a packfile
`maxResolvedBytes` and a checkout `maxDirs`). The caps are anchored to the real repository size —
tens to hundreds of times the largest legitimate history — which resolved the "no justifiable
value" blocker. `packfile.ts`'s claim is true again.

**Nine of the twelve are the same shape**, which is now the clearest signal this codebase gives
about itself: a rule applied on one path and not on its structural twin. `checkout.ts` validates
remote-supplied path components and the `login` path did not. `og:title` was escaped and `<title>`
was not. The void-lookup budget covered `a` and `exists` but not `mx`. `migrateMailboxIdHwm`
reconciles unconditionally and `migrateCatalogMeta` returned early. `.gitignore` and `.dockerignore`
carry twelve exclude patterns and the rsync carried three. A fix of one instance without a search
for the sibling is how each of these survived the review that created it.

**Two tests were found that could not fail.** `executable.test.ts` asserted `result.modules > 150`
with the comment "the whole tree was swept, not a corner of it". But that count is the number of
modules *found*, not imported, so it read 226 while the sweep imported four. And during this work a
wall-clock assertion about the STATUS freeze passed with the defect still in place, so a
deterministic count of mailbox scans replaced it. A test shaped like a guard is worse than no test,
because it stops anyone from a look.

## Closed: what a sixth security audit found

Twenty-one findings, all reproduced by running code, all fixed with a test that fails on the old
code. The prior five runs had already closed forty-four, so the interesting result is not the count.
It is that **thirteen of the twenty-one are the same shape the last run named**: a rule applied on
one path and not on its structural twin. That is now the most reliable thing this codebase says
about itself, and two of the worst findings here are cases where the flag was already tracked and
simply not consulted the second time.

The one that mattered most needed no credentials at all. `STARTTLS` was gated on whether TLS is
*configured*, never on whether it is already *active*, and each upgrade wraps whatever socket is
current. So fifty `STARTTLS` commands on one connection nested fifty `TLSSocket`s, every read walked
the chain, and the stack overflowed. One unauthenticated TCP connection, about a hundred
milliseconds, and the process that serves SMTP, submission and IMAP is gone. `Restart=on-failure`
with systemd's default start limiter then keeps it down after five repetitions. The `#tls` flag it
needed already existed and already gated `AUTH`.

From headers that are not malformed at all could bypass the DMARC rewrite that landed just before
this audit. RFC 5322 §4.4's `obs-mbox-list` makes `victim@bank.com,` a one-mailbox list, RFC
6854 permits group syntax in `From`, and `obs-domain` permits CFWS between the domain's atoms.
Reference parsers resolve all three to the plain address, so that is what the recipient sees. The
extractor did not, and produced a "domain" that carried a comma, semicolon or space. c-ares rejects
such a name with `EBADNAME`, discovery became `temperror`, and enforcement only acts on `fail`. The
more mangled the header, the more lenient the handling. The fix is to parse the grammar the module
always claimed to model, and to treat a From that yields no author domain as a failure rather than
as an absence of policy.

| # | What | Where |
|---|---|---|
| 1 | Repeated `STARTTLS` nested TLS sockets until the stack overflowed — unauthenticated, whole daemon | `server/smtp-receiver.ts` |
| 2 | `#onData` appended before it tested `#ended`, and `end()` is a half-close, so a rejected peer grew an unparsed buffer without bound | `server/smtp-receiver.ts` |
| 3 | Legal RFC 5322 From forms produced unqueryable domains, so a published `p=reject` was never discovered | `message/from-author.ts` |
| 4 | `LOGIN`/`AUTHENTICATE` stayed reachable once authenticated, which kept the previous account's mailbox and defeated both containment verbs | `server/imap-server.ts` |
| 5 | The APPEND regex backtracked cubically: three `\s*` runs between two optional groups | `server/imap-server.ts` |
| 6 | `fetch-att` repeats were neither de-duplicated nor capped, though `status-att` repeats are. Each one costs a whole body copy | `server/imap-server.ts` |
| 7 | Key derivation ran on the event loop, so one credential could loop it into a whole-server stall | `auth/scram.ts` |
| 8 | Only one author domain was evaluated, so the attacker chose which zone governed the message (RFC 9989 §11.5) | `server/dmarc-inbound.ts` |
| 9 | The `Authentication-Results` strip spelled its whitespace class in a regex narrower than `.trim()` | `server/received.ts` |
| 10 | `mail_db_path` — the daemon-owned half of the same path — reached `openMailDb` unguarded, so a symlink was followed and its target created | `update/snapshot.ts` |
| 11 | A revert moved the database aside and unlinked its write-ahead log, which lost mail already answered `250` | `update/cutover.ts` |
| 12 | `stop()` read inactivity as a clean drain, so a systemd `SIGKILL` was indistinguishable from one | `update/main.ts` |
| 13 | `INSERT OR REPLACE` reassigned the rowid, so a password rotation moved the postmaster mailbox to another account | `store/account-registry.ts` |
| 14 | Sequence-set ranges were enumerated per range, so repeats multiplied the work | `imap/sequence-set.ts` |
| 15 | No bound on mailbox-name length or depth, and `LIST` rebuilds every ancestor prefix | `server/imap-server.ts` |
| 16 | The DMARC enforcement log spliced the From domain in raw, twenty lines above the line that sanitises it | `main.ts` |
| 17 | `JSON.stringify` was used as a terminal sanitiser. It passes DEL and the whole C1 range | `server/smtp-receiver.ts`, `server/imap-server.ts` |
| 18 | `MAIL_DEBUG` redacted one token, while the LOGIN handler is quote-aware — a working passphrase minus its first word | `server/imap-server.ts` |
| 19 | `QUIT` ended the socket without a stop of the loop, so pipelined commands still ran and mail was stored after the session closed | `server/smtp-receiver.ts` |
| 20 | `countReceived` had the same whitespace-class gap as the strip, which left hops uncounted | `server/received.ts` |
| 21 | The start-budget comparison parsed a systemd timespan with `Number()`, so it never ran | `update/main.ts` |

**Three of the fixes are more interesting than the defects.** To move key derivation off the event
loop meant that the whole IMAP command loop became asynchronous, with the same chunk-serialisation
the SMTP receiver already uses and for the same reason. Provisioning stays synchronous, because a
CLI can afford the pause and only verification is driven by strangers. The mailbox-name bound went
into `store/mailbox-name.ts` and is applied at `CREATE` *and* `RENAME`, because the file's own
comment about a guard on both doors was already there for Net-Unicode. And the
`Authentication-Results` matcher now DERIVES the field name the way the parser does instead of a
re-spell of it. This was the third distinct gap found in that one regex across three audits, each
time by a widen of it to chase `.trim()`, so the fix is to stop the double spelling.

**The rest of the audit is a shorter list than it looks.** Five findings were documentation that
asserted a property the code did not deliver — a revert that never deletes, a drain that is awaited,
a budget that is compared, credentials that are redacted. This is its own defect class, because an
operator reads those and plans around them. Each doc has been corrected alongside its code.

### Left open, deliberately

`node:sqlite` opens by path and offers no descriptor-based entry point, so the snapshot's source
check (`lstat`, then containment) cannot close a perfectly-timed symlink swap between the check and
SQLite's own open. What it does close is the steady state. The path must be a real file inside the
data directory at rest, so there is no longer a create-a-file primitive to aim, only a race to win.
Recorded here rather than papered over.

Two flaky tests were found and made deterministic, neither related to a finding. The backup
concurrency test raced a 150 ms sleep against a child process's startup. The federation test
asserted an outbound queue was drained at the moment the *recipient* stored the message, which is
necessarily earlier. Both now wait for the condition they mean. A test that fails for a reason other
than the defect it targets is the same problem as one that cannot fail at all.

## Closed: the two things the update path could not see about itself

Both came from the self-updater put to work on a real deployment rather than read on the page, and
both are the same species of defect: a safety mechanism that reports success about something it had
never actually exercised.

**The pre-flight never ran the signer.** Its mail-path rung delivers to the probe account itself,
and a submitted message is signed only on the copy bound for a remote domain. The local copy is
stamped with a `Received` trace and stored unsigned. So the signing code was never reached. Worse,
the rung's own configuration made it unreachable on purpose. The updater runs as a different user
and cannot read the DKIM key, and its response was to *delete* `MAIL_DKIM_KEY`, which disables the
signer outright. `MAIL_TLS_CERT` got the same treatment, which moved the candidate onto the bundled
development certificate rather than the branch that reads a file. The two settings most likely to
break mail were the two the ladder tested least.

A candidate that had stopped signing altogether therefore passed every rung, passed the cutover
probe, and passed the watch window. None of those can distinguish a healthy daemon from a
healthy daemon that sends unsigned mail. The operator would have learned from DMARC aggregate
reports, days after the version was confirmed and its snapshot destroyed.

Unreadable key material now substitutes a **stand-in** rather than a switch of the feature off: the
bundled certificate written to a real file, and a freshly generated DKIM key. The candidate runs the
same code paths with keys of the same shape, and a second probe message addressed to a reserved
remote domain is inspected — in the queue it is held in, never sent — for a `DKIM-Signature` that
carries the expected domain and selector. The negative control is a copy of this checkout with the
signing call replaced by a pass-through. It is refused at the mail-path rung, and it passes against
the ladder as it stood. Containment is unchanged. The updater still holds neither real key, which is
the point of it being a separate user.

**A setting the updater depends on lives where no update can reach it.** The updater ships code and
deliberately never unit files. Write access to `/etc/systemd/system` would let the account that
downloads code rewrite `User=` and hand itself root. But `TimeoutStopSec` has to be at least the
drain deadline or systemd SIGKILLs the daemon before the drain completes, which means every cutover
during a slow shutdown is abandoned with nothing that names the cause. `check`, `apply` and `status`
now report a stop budget that is too short, the setting that fixes it, and the value to use. This is
a warning rather than a refusal. A short stop budget can be deliberate, and a refusal of every
update over one would pin the deployment on the version it is running. Detection is compatible with
containment. Correction is not.

Three stale claims were corrected alongside them: a comment that asserted the shipped unit sets no
`TimeoutStopSec` (it has since it was added), a deploy-script comment that promised the pre-flight
boots a candidate "with your real settings" (not true of TLS or DKIM, and the pre-flight's own
comment was already honest about it), and a duplicated twenty-four-line block in
[TESTING.md](TESTING.md). Pre-flight warnings are also de-duplicated now. The candidate's
configuration is built once per boot, so a deployment whose certificate the updater cannot read
printed the same note three times, which reads as three findings.

## Closed: the census asked a database for a column it was entitled not to have

Found by a live deployment that refused an update, and it is the sharpest example yet of the rule
this subsystem keeps proving: **a pre-flight check must be able to fail for a reason CI could not
have caught**.

Mail databases are migrated when their catalog is *opened*, and a catalog is opened when its account
is used. A registered but dormant account — a check address, a seldom-read alias — therefore keeps
the schema it was created with for as long as nobody touches it. `PRAGMA user_version` cannot
distinguish the two, because these migrations are additive and reconciled by a probe for the column
rather than by a bump of a version. On the deployment that found this, two mail databases both
reported `user_version 1` and genuinely differed. The active account had `mailbox_id_hwm`, the
dormant one did not.

`censusOf` named that column outright, so `db.prepare` threw `no such column: mailbox_id_hwm` before
it read a row. Three things made it worse than a crash. The ladder attributed the failure to
`migration against your data`, which reads as *the candidate corrupted something* when the candidate
had not yet been started. It recurred identically on every run, so the deployment could never update
again. And no fixture could reproduce it, because fixtures are built by current code, which always
has the column.

The census now asks what the database has before it asks for it, and treats an absent mark as zero.
This is not a convenient default but the correct value. A mark that does not exist cannot have been
lowered, and `compareCensus` only reports a mark that moved *backwards*. The candidate's migration
seeds the column past every id in use, which is forward, so an addition of it is a migration and not
a loss.

**A deployment that already carries the defect cannot be updated out of it**, because the census
that fails is the *running* version's. That is inherent to a self-updater. The code that performs
the check is by definition the old code. One open of the dormant account's mailbox migrates its
catalog and clears the block, after which the update proceeds normally. Worth remembering as a
general property: a defect in the update path is only ever fixable forward for deployments that do
not yet have it.

## Closed: MTA-STS policy without an `mx` list

RFC 8461 §3.2's policy ABNF marks `sts-policy-mx` "required at least once, except when mode is
'none'". A policy that omitted it parsed as valid, and an `enforce` policy with an empty MX list
then refused **every** host. All mail to that domain stopped. Fixed: the parser now marks such a
policy invalid (register entry `R-8461-3.2-e`, which mirrors the sibling `max_age` rule), so
`resolve()` keeps a still-valid cached policy or falls back to opportunistic TLS rather than a
bounce of every host. This is the less-destructive direction, and the same treatment every other
malformed field gets. `mode: none` legitimately omits `mx` and stays valid. Reproduced first,
negative-control via an `acceptMissingMx` defect.

## Closed: rename-INBOX UIDVALIDITY monotonicity

A plain `CREATE` draws UIDVALIDITY from the catalog's monotonic high-water mark, so a recreated
name can never reuse a deleted incarnation's `(UIDVALIDITY, UID)` space (RFC 9051 §6.3.4). The one
path that did not was the fresh target a `RENAME INBOX` produces. It was seeded with **INBOX's own**
UIDVALIDITY (the catalog origin), so `RENAME INBOX A`, `DELETE A`, `RENAME INBOX A` handed both `A`
incarnations the same UIDVALIDITY, and a client that cached the first could take the second's UIDs
as unchanged. Fixed in both catalogs by a draw from `#nextUidValidity()`. `sqlite-mailbox.ts` and
`memory-catalog.ts` seeded it the same way, so the differential parity oracle was blind to the
shared wrongness. Reproduced first with a catalog-parity **invariant** test over both backends.

## Open: test-bed completeness

The test suite is the one place where completeness is itself the goal, so these stay listed
even though each one is either blocked on an environment or marginal against coverage already
achieved:

### Real-MTA (Postfix) calibration of the receiver suite: DONE (2026-07-22)

The SMTP receiver suite is now calibrated against **four** independent implementations (Postfix
3.7.11, Exim 4.99, mox 0.0.15, aiosmtpd 1.4.6) with zero false positives. Postfix ran via
Docker in two configs, vulnerable and hardened. The suite flagged the two SMTP-smuggling
vectors on the vulnerable config and positively cleared them on the hardened one. This is the
strongest single validation of the false-positive discipline, which was built around never a
conviction of a hardened Postfix. It also gave the §4.1.2 control-octet rule a second lenient
witness. Postfix and aiosmtpd accept a BEL octet, and Exim and mox reject it. No server change
followed, because our server is on the strict side of all four. See
[reference-servers/CALIBRATION-postfix.md](../reference-servers/CALIBRATION-postfix.md).

Optional remaining corroboration: an OpenSMTPD or Stalwart/Maddy run. Not blocking, because the
calibration goal is met four times over.

### openSPF RFC 7208 vector suite

SPF is implemented, wired, and tested, but the canonical ~200-case openspf.org YAML suite is
not yet vendored as a pinned oracle. Adoption of it would exercise the macro and edge-case
boundary the evaluator currently treats as a deliberate safe non-match. Vendor as a frozen
snapshot with its licence.

### Longer Dovecot `imaptest` soak

The IMAP server was calibrated against `imaptest` (~12,000 mutations, five concurrent clients).
That run found and fixed a real RFC 9051 §7.4.1 bug. A longer soak needs a built `imaptest`,
which means a compile of Dovecot from source. This is marginal against that cost, and worth
doing where a prebuilt binary is available.

*Optional, not a gap:* continuous coverage-guided fuzzing. The parsers already have
deterministic fuzz harnesses (~30,000 generated inputs) plus per-subsystem security review. A
coverage-guided corpus would go deeper but is an addition, not a missing floor.

---

## Considered and declined, with reasons

Per the working agreement, every omission is a recorded decision. Popular demand alone does not
clear the bar. Most of these carry a revisit trigger.

**Scope cuts (ADR 0007, the opinionated boundary):**

- **POP3.** IMAP4rev2 serves every modern client. A whole extra protocol and harness gains
  nothing.
- **JMAP.** Modern and desirable, but additive: the modern-client round-trip is
  already met. The standing "desirable later, not minimum" item.
- **Sieve.** Per-`+tag` folder filing would want it, but that filing is itself out of scope for
  now.
- **CalDAV / CardDAV / webmail.** A mail *client* or a calendar is a different
  project. The mission is service of *existing* clients.
- **DANE.** Needs DNSSEC validation Node's resolver does not provide. MTA-STS is the chosen
  outbound TLS-policy mechanism.
- **ARC sealing.** This server never forwards, so there is nothing to seal. Inbound
  verification (ADR 0011) is the whole of the useful surface.

**Reporting and observability:**

- **DMARC `rua`/`ruf` and TLS-RPT emission.** Outbound scheduled-report machinery with near-zero
  value at personal scale. `ruf` is privacy-fraught besides.
- **Reading the DMARC aggregate reports you *receive*.** Distinct from the entry above, which is
  about reports this server would send, and worth its own reason because it is the step operators
  most often give up at. You publish a `rua=`, Gmail and Microsoft start to mail you gzipped XML
  every day, and without a parser it is unreadable. So people turn DMARC off rather than leave
  it to collect attachments. A `dmarc-report` summary command beside `doctor` would fit the
  house style (SQLite is already here, `node:zlib` is a builtin). Declined on two counts. The
  reports exist to inventory *unknown* senders, and a one-domain one-box deployment has none.
  Every path that can send is the daemon itself, which is why `setup` emits `p=quarantine`
  outright rather than the `p=none`-and-wait rollout the reports are designed to support. And
  the cost is not the summary. It is a from-scratch XML parser fed unsolicited third-party
  attachments: a new hostile-input surface bought for an operator convenience that
  publicly-hosted analysers already provide. **Revisit** if multi-domain ever lands, because a
  second sending path is exactly the condition that makes the reports say something.
- **Prometheus metrics / structured-log tooling.** `doctor` and the queue CLI answer the
  operator's real questions at this scale. A metrics endpoint has no consumer here.
- **Richer `account list` (created / last-login).** A marginal nicety. Its one real use, a spot
  of a dormant or compromised account, would be better served by per-credential
  *last-used* on app passwords. **Revisit** alongside app-password observability.
- **ValiMail `arc_test_suite` as an external vector pin.** ARC's offline sign/verify
  round-trips plus the golden signing-input already cover the scope. Recorded nice-to-have.
- **A unified project-wide coverage percentage.** A roll of the receiver and outbound-client
  coverage into one number is cosmetic reporting, not correctness. It fails the bar.

**Operational:**

- **Live config / certificate reload.** SIGHUP is caught, logged, and ignored (rather than a
  kill of the daemon, Node's default). A restart picks up a renewed certificate, and clients
  reconnect from it transparently. True hot-reload without a drop of IMAP sessions means a
  re-bind of TLS contexts on live listeners. Real complexity. **Revisit** if
  certbot-restart churn or dropped IDLE sessions become a felt problem.
- **`account remove`.** Deliberately absent (ADR 0012). Deletion of the registry row would strand
  the mailbox database with all its mail, a half-destruction that pretends to be clean. The CLI
  surfaces the decommission recipe (`disable`, then remove the mailbox file) instead.

**Infrastructure and availability:**

- **Serving the MTA-STS policy / client autoconfig over HTTP.** Decided: no HTTP listener
  (ADR 0013). The policy file is two lines and can live on any static host. `setup` emits it.
- **Built-in ACME.** Attractive for the ten-minute-setup story, but a large zero-dependency
  effort that duplicates certbot, which is ubiquitous and documented. **Revisit** if certificate
  provisioning proves to be the setup step that actually defeats operators.
- **Backup MX / HA / clustering.** Personal scale. Even Mox declines it, and
  accept-then-forward backup MXes create backscatter obligations. The `backup`/`verify`
  snapshot story is the honest availability answer here.
- **Distro packaging.** A `.deb`/`.rpm` presupposes a distribution story the project does not have
  and does not seek. Unattended updates were the part of this worth having, and they are built
  instead as a self-updater over the git remote the deployment was installed from (ADR 0025), which
  needs no packaging story at all.
- **Multi-domain.** One domain per server is the current design (ADR 0009 notes a future
  multi-domain story would widen the account key, deliberately not now). Multi-domain is
  a real scope expansion, revisitable with a stated reason.

**Security features blocked or covered elsewhere:**

- **2FA / passkeys.** Blocked on the ecosystem. IMAP/SMTP clients and the SASL mechanisms
  do not support them, so there is nothing to build until they move. The per-IP throttle covers
  brute force today. App passwords (ADR 0017) are the reachable adjacent win, and shipped.
- **Spam filtering (Bayesian / DNSBL / reputation).** DMARC enforcement already junks the
  forged class. A Bayesian filter is a large subsystem with training UX. **Revisit** trigger:
  daily-driver use with recorded spam volume that DMARC does not catch.
- **Greylisting.** Rejected. It delays legitimate mail and poisons reputation-based
  reasoning (Mox rejects it too).
- **Milter / plugin hooks / external filter integration.** Anti-mission. The project is
  self-contained and opinionated precisely to avoid integration-point complexity.

**Conformance depth and delivery (weighed in the 2026-07-21 coverage audit):**

- **Full EAI / SMTPUTF8 transmission.** Deferred, recorded as [ADR 0022](decisions/0022-eai-smtputf8-scope.md).
  The envelope is ASCII-only. Submission and inbound reject a non-ASCII `MAIL FROM` / `RCPT TO`
  with `553 5.6.7` (SMTPUTF8 is not advertised), and the delivery client refuses to transmit an
  internationalized envelope rather than corrupt it. UTF-8 header/body content already parses.
  Only the envelope is out of scope. **Revisit** if EAI submission is ever actually asked for.
- **DKIM key-record `h=` permitted-hash enforcement.** Declined. `sha1` is already rejected
  outright (RFC 8301), so support for a key record that restricts the hash to a set adds no
  security over what the algorithm gate already denies.
- **The rest of RFC 9989 (DMARC): `psd`, `np`, and per-identifier tree-walk alignment.**
  Deferred, recorded as [ADR 0027](decisions/0027-dmarc-rfc9989.md). Policy discovery and the
  `t` test-mode tag were adopted. Alignment still compares Public Suffix List organizational
  domains rather than a run of §4.10.2's tree walk per authenticated identifier, which would cost
  up to eight DNS queries for the Author Domain plus eight for each DKIM `d=` and the SPF domain,
  per message, on an unauthenticated path. `np` needs a non-existent-domain determination this
  server does not make. `psd` needs the walk to continue past the registered domain to the TLD,
  which the PSL floor deliberately prevents. **Revisit** if a legitimate sender is observed to
  rely on tree-walk alignment to split alignment between intermediate names, or if PSL refresh
  cadence becomes the thing that breaks alignment.
- **Concurrent per-domain outbound relay.** Declined. The serial single-flight drain is
  deliberate. The `stop()` / DB-close safety design depends on one in-flight relay, and the MX
  list already bounds per-message host attempts. A concurrency rework
  (head-of-line elimination) exceeds the mission bar at personal scale. The queue drains fast
  enough that no message waits on an unrelated slow domain in practice.
- **Prompt permanent bounce for an IPv6-only destination.** An AAAA-only domain (no A, no MX)
  is not treated as deliverable, because relay is deliberately IPv4-only (PTR reasons). It stays a
  **transient** failure (the domain may add an A record) rather than a prompt permanent bounce.
  A prompt v6-only bounce is left as an operator deliverability-policy call, not a default.
- **`httpsFetchPolicy` timeout / redirect unit tests.** Declined as not cheaply unit-testable.
  The timeout and no-redirect paths need a live TLS server that answers under the exact
  `mta-sts.<domain>` name. The non-200 and oversize-truncation paths *are* tested. The
  MTA-STS integration suite covers the end-to-end enforce-mode delivery.

*Previously open, since resolved (recorded so they are not re-proposed):* dot-stuffing / DATA
transparency coverage (ADR 0005's revisit trigger fired, and the receiving sink was built),
per-IP brute-force lockout (shipped as the auth throttle), and the STARTTLS-injection family
(ADR 0006: all three variants covered).
