# Performance — where the server stops scaling, and why

*Measured 2026-07-19. Benchmarks live in [`perf/`](../perf) and drive the real production
code paths (`SqliteMailbox`, the IMAP + SMTP servers) — they are measurement rigs, not tests,
so `npm test` and `tsc` ignore them. Two machines: **laptop** (8-core, 16 GB, NVMe) and **box**
(the live target: Hetzner cx23, 2 vCPU, 3.7 GB, the hardware this is actually deployed on).*

> **Status: fixed (2026-07-19).** The lazy-storage refactor below landed (commits `3ec1a2b`,
> `97d26cc`). On the box, a single-message body fetch on a 50k mailbox went **1825 ms → 0.53 ms**,
> per-command heap churn **195 MB → 1.3 MB**, and greeting latency under load **4.6 s → 0.44 s**.
> A second stress round (`ad27034`) then found and fixed a matching freeze on the **write** path —
> bulk `STORE`/`COPY` ran one transaction per message (**~37 s → ~3 s** for a 20k folder). A third,
> adversarial round (`93de573`) found and fixed a real **OOM** — an authenticated read-slowloris
> that killed the box (now bounded by a write-backlog budget). The
> [Fixed](#what-was-fixed), [stress](#pushing-harder--stress-findings-2026-07-19) and
> [red-team](#red-team--deliberately-trying-to-break-it-2026-07-19) sections carry the details. The
> diagnosis below is kept as the record of *why* — read it in the past tense.

## TL;DR

The server was correct and fine at rest, but **one moderately-large mailbox being read made
the whole server unresponsive for every other user and for all inbound mail.** Two root causes
compounded:

1. **Every IMAP command materialises the entire mailbox** — all message bytes + an N+1 flag
   query — even to answer `FETCH 1 (FLAGS)`. Cost is O(total mailbox bytes), not O(what was asked).
2. **`node:sqlite` is synchronous on a single-threaded server**, so that whole-mailbox read
   *blocks the event loop* — freezing every other connection and every delivery for its duration.

On the box, with a 221 MB mailbox (50k typical messages — a few years of one person's mail) and
just **3 concurrent readers**, a new IMAP connection waits **4.6 s** for its greeting and an
inbound email takes **25 s** to be accepted. A sending MTA would time out and retry; the box
looks dead. None of this needs an attacker — it is ordinary use at a boringly normal scale.

The good news: cause (1) is the lever. Making the storage layer fetch only what a command needs
turns almost every operation into a bounded, sub-millisecond query, which also removes the
event-loop stalls of (2) on the common path. It is a contained refactor behind one interface.

## How a command touches storage today

```mermaid
flowchart LR
    C["IMAP client<br/>FETCH 1 (FLAGS)"] --> H["imap-server.ts<br/>handler"]
    H -->|"selected.messages"| G["SqliteMailbox.messages<br/>(getter)"]
    G -->|"SELECT uid,internal_date,raw,mod_seq<br/>FROM message (ALL rows, ALL blobs)"| DB[(SQLite)]
    G -->|"then one flag query PER message"| DB
    G -->|"Buffer.from(raw) copy per message"| HEAP["JS heap:<br/>whole mailbox"]
    H -->|"reads [0], ignores the other 49,999"| R["reply"]
```

`messages` is a getter that re-runs on **every access**, and handlers touch it several times per
command (SELECT reads it 3×). The `ServableMailbox` interface itself — `readonly messages:
readonly ServableMessage[]` — is what forces this: there is no way to ask for less.

## Measured — mailbox-size scaling (`perf/storage-scaling.bench.ts`)

Cost to answer **one** `FETCH 1 (FLAGS)`, by mailbox size, 4 KB messages:

| mailbox | on disk | laptop FETCH1 | **box FETCH1** | heap churned | RSS spike (laptop) |
|--------:|--------:|--------------:|---------------:|-------------:|-------------------:|
|   1,000 |  4.5 MB |        4.2 ms |        35.9 ms |      3.9 MB |            7 MB |
|  10,000 | 44.2 MB |         55 ms |         273 ms |     39.1 MB |           82 MB |
|  50,000 |  221 MB |        311 ms |    **1,825 ms** |    195.3 MB |          426 MB |

Reading **one** message costs the same as reading **all 50,000**, because the whole mailbox is
materialised first. `sequenceNumber()` (an indexed `COUNT`) stayed <2 ms throughout — it is *not*
a problem; the BLOB materialisation is. Append held ~550 msg/s on the box (one fsync'd
transaction each) — fine for personal scale, and disk-fsync-bound, not CPU-bound.

## Measured — head-of-line blocking (`perf/concurrency.bench.ts`)

While N clients hammer `FETCH 1` on a 50k mailbox, we sample two things that should be cheap: a
fresh IMAP connection's time-to-greeting (touches no mailbox — a pure event-loop-responsiveness
probe) and a full inbound delivery (`MAIL`/`RCPT`/`DATA` → 250).

**Box, 3 loaders:**

| probe | idle p50 | under load | blow-up |
|---|--:|--:|--:|
| IMAP greeting (touches nothing) | 1.7 ms | **4,616 ms** | 2,710× |
| SMTP delivery (inbound email)   | 49 ms | **24,751 ms** | 505× |

```mermaid
sequenceDiagram
    participant New as New connection / inbound mail
    participant Loop as Event loop (single thread)
    participant SQL as node:sqlite (synchronous)
    Loop->>SQL: reader A: load 50k mailbox (~1.8s)
    Note over Loop: BLOCKED — nothing else runs
    New--xLoop: SYN / MAIL FROM sits in the OS queue
    SQL-->>Loop: done
    Loop->>SQL: reader B: load 50k mailbox (~1.8s)
    Note over Loop: still blocked; new work keeps waiting
    Loop-->>New: finally serviced, seconds later
```

The greeting delay is decisive: that probe reads no mailbox, yet it waits seconds — proof the
stall is event-loop starvation, not per-command work. Inbound mail waits in the same queue, so
throughput "in" and "out" don't share the machine gracefully; they exclude each other.

## Measured — many-users footprint (`perf/many-users.bench.ts`)

Holding user databases open (as `MailStores` does, permanently):

| open user DBs | RSS Δ | per user |
|--------------:|------:|---------:|
| 500 | 140 MB | 287 KB |
| 2,000 | 344 MB | 176 KB |

Memory per user is *reasonable* — RAM is not the first wall. Two sharper limits are:

- **File descriptors.** Each open WAL database holds ~3 fds (db + `-wal` + `-shm`), plus one per
  live connection. The box's `ulimit -n` is **1024**, so ~300 distinct active users would exhaust
  descriptors long before memory — and `MailStores` **never evicts**, so the floor only grows
  with distinct logins seen since boot.
- **Unbounded cache.** No cap, no idle close. A busy day's worth of distinct senders/logins is a
  monotonic leak of handles until restart.

## What was fixed

### 1. [DONE] The storage layer fetches only what a command needs

The `ServableMailbox.messages` getter — which loaded every message BLOB and ran a flag query per
message on every access — is replaced by two accessors ([`MessageMeta`](../src/store/mailbox.ts),
[`imap-server.ts`](../src/server/imap-server.ts)):

- **`index()`** — ordered per-message metadata (uid, flags, internalDate, modseq, **size**) with
  **no body bytes**. Two queries regardless of mailbox size: the message rows carry `LENGTH(raw)`
  (SQLite reads the octet count from the record header, never the BLOB), and all flags come in one
  grouped query joined in memory (no N+1). This is what FETCH FLAGS / STATUS / SELECT / EXPUNGE /
  STORE / sequence-set resolution read.
- **`raw(uid)`** — one message body, a single row, fetched only when a command actually needs it
  (BODY[…]/RFC822/ENVELOPE, a body/header SEARCH, COPY).

`STATUS` sums `meta.size` (no BLOBs); a `LARGER`/`SMALLER` SEARCH uses `meta.size` too; a
flag/date/uid SEARCH loads nothing. A new guard, `imap-fetch-laziness.test.ts`, asserts over the
wire that a metadata command loads **zero** bodies and a single-message body fetch loads **exactly
one** — so a regression to eager loading fails the suite. Behaviour is identical: the full suite
(1025) stays green, including the `SqliteCatalog`↔`MemoryCatalog` catalog-parity oracle.

**Measured (box, 50k / 221 MB mailbox), old `.messages` → new:**

| operation | before | after | change |
|---|--:|--:|--:|
| single-message body fetch (`raw(uid)`) | 1825 ms | **0.53 ms** | ~3200× |
| metadata read (`index()`; FETCH FLAGS / STATUS) | 1695 ms | **424 ms** | 4× |
| heap churned per command | 195 MB | **1.3 MB** | 153× |
| greeting latency under 3 readers | 4616 ms | **435 ms** | 10.6× |
| inbound delivery under 3 readers | 24,751 ms | **6825 ms** | 3.6× |

### 2. [DONE — insurance] fd headroom; cache eviction deliberately not built

`LimitNOFILE=65536` is set in the systemd unit ([`deploy/hetzner-up.sh`](../deploy/hetzner-up.sh)):
each open user DB holds ~3 fds and the default 1024 would wall before memory.

Refcounted `MailStores` eviction is **deliberately not built.** The cache is keyed by *login* and
only ever opens a store for a **real account** — both delivery (`deliverTo(login)`) and IMAP resolve
addresses/aliases/`+tags` to a bounded set of real logins before touching a store — so its size is
bounded by the account count, which is small at the project's personal scale (ADR 0009). Adding
refcounted eviction would put the load-bearing shared-instance/IDLE invariant (`mail-stores.ts`) at
risk to defend a limit (hundreds of accounts) the project does not target. **Revisit** if the
project ever grows a multi-tenant story. This corrects the earlier note above: the floor grows with
*account count*, not with distinct senders.

### 3. [DONE] No DDL on the mailbox hot path

`SqliteCatalog.get()` (run on every SELECT/STATUS/COPY) now calls `SqliteMailbox.attach()` — a bare
constructor — instead of `open()`, which had re-executed `CREATE TABLE IF NOT EXISTS` ×4, three
`pragma_table_info` probes, and `CREATE INDEX` every time. The catalog runs schema + migrations once
at open; `open()` stays for tests that create a bare mailbox.

## Pushing harder — stress findings (2026-07-19)

After the read-path fix, a second round pushed bigger mailboxes (up to 100k / 442 MB), bulk
whole-mailbox commands, large attachments, and concurrent load (`perf/stress.bench.ts`,
`perf/large-messages.bench.ts`, `perf/inbound-burst.bench.ts`). One new bug, three characterised
ceilings.

### 4. [DONE] Bulk STORE / COPY / EXPUNGE ran one transaction per message

The same O(mailbox) freeze, on the write path. `storeFlags`/`append`/`expunge` each open their own
transaction (one fsync), and the `STORE 1:*` / `COPY 1:*` / `UID EXPUNGE` loops called them **once
per message** — so marking a 20k folder read, or archiving it, was 20k fsyncs: **~37 s of frozen
server** on the box. `SqliteMailbox.#tx` is now reentrant and exposes `transaction(fn)`; the server
wraps its bulk loops in it, so N mutations commit at **one** fsync. Per-message modseqs and FETCH
responses are unchanged (the catalog-parity oracle + full suite hold). Plain `EXPUNGE`
(`expungeDeleted`) and `SEARCH` were already batched/streamed.

**Measured (box, 20k mailbox):** `STORE 1:*` **36,726 ms → 2968 ms (12×)**; `COPY 1:*`
**37,581 ms → 4139 ms (9×)**. Now CPU/SQL-bound, not fsync-bound. Live-verified on the service.

### Characterised ceilings (not bugs — the shape of a synchronous single-thread server)

- **Metadata floor scales with mailbox size, and serialises under concurrent readers.** `index()`
  is O(rows) (no BLOBs): **521 ms at 50k, 1192 ms at 100k** on the box. Because it is synchronous,
  concurrent heavy readers queue behind each other — 3 readers on a 50k mailbox delayed a new
  connection's greeting to 0.44 s, **8 readers to 3.8 s**. No errors, no crash — pure latency, and
  only under many clients hammering a large mailbox (not realistic steady use). This is what the
  deferred lever below would cut.
- **Inbound accept ceiling ≈ the single writer.** 5000 concurrent deliveries (32 in flight, 20
  recipient DBs) sustained **244/s on the box with zero `SQLITE_BUSY`** — the synchronous writer
  serialises everything (so `busy_timeout` never even engages) and never errors. 244/s is ~880k
  mail/hour, far beyond any personal mailbox; a genuine flood queues at the sender's MX, it does not
  fail here.
- **Concurrent large-body fetch memory ≈ 3× the bytes in flight.** `raw(uid)` loads a whole body,
  and 24 clients each fetching a 2 MB message peaked at **+141 MB** (the SQLite buffer + the
  `Buffer.from` copy + literal framing). Authenticated-only and bounded by `MAX_APPEND_LITERAL`
  (25 MB) × connections, so personal-scale-safe; worth remembering before raising that cap or the
  512-connection limit.

### Deferred — a real lever, higher risk, only bites the extreme case

**Make a *bounded* fetch sub-linear.** `resolveForConn` still calls `index()` (all metadata) to map
sequence numbers, so even opening one message pays the metadata read (**424 ms** on the box for a
50k mailbox, **1192 ms at 100k**; ~80 ms on a normal server) — and that floor is what serialises
under the 8-reader load above. It could instead resolve the set to UIDs first — from the in-memory
client view for sequence mode, a cheap `MAX(uid)` for `*` in UID mode — and batch-fetch metadata for
only the matched messages, making `FETCH <one message>` O(matched) not O(mailbox). It is **not
built**: it touches the RFC 9051 §7.4.1 client-view sequence logic that is heavily tested and has
been a source of subtle bugs (audit runs 5–7), and the residual only hurts very large mailboxes
under heavy concurrent load on slow hardware — disproportionate risk for the mission. Recorded as
the next lever if a large-mailbox latency complaint ever materialises.

### Body/header SEARCH of a huge mailbox

Still inherently O(mailbox) — it must stream each candidate body — but now one row at a time (via
`raw(uid)`), never a single 195 MB allocation, and only for HEADER/BODY/TEXT criteria. Bounded by
the existing authenticated-only SEARCH-key DoS guards. Left as-is; the personal-scale answer.

### Not a problem (measured, so it isn't guessed at)

`sequenceNumber` (indexed COUNT, <2 ms at 50k); append throughput (~550/s on the box, disk-fsync-
bound, ample for personal scale); per-user memory (176 KB). No effort spent here.

## Red-team — deliberately trying to break it (2026-07-19)

A third round stopped measuring and tried to crash, hang, or OOM the server
(`perf/abuse.bench.ts`, `perf/oom.bench.ts`). One real OOM, now fixed; the parser held.

### 5. [DONE] Authenticated read-slowloris OOM

The genuine break. The server frames a whole FETCH body and hands it to the socket with **no
backpressure** — a client that requests a large message then stops reading leaves the entire
response buffered in the process, unbounded. Summed across connections this is an OOM, and
`MAX_CONNECTIONS` (512) does not help because each connection needs only *one* big fetch. Live on
the box: **~112 connections each stalling on a 25 MB `BODY[]` drove RSS to 3.3 GB and the Linux
OOM-killer killed the process** (`Out of memory: Killed process … node`, confirmed in `dmesg`).
Authenticated — it needs valid credentials — but a single misbehaving or slow-linked client
fetching big attachments is the same shape.

Fix: a server-wide **write-backlog budget** (256 MiB, `MAX_WRITE_BACKLOG`). After each body write,
if the summed `writableLength` across all sockets exceeds it, the biggest-backlog (slowest-draining)
connections are dropped until back under — a client reading promptly holds ~0 and is never chosen,
so normal use is untouched. The decision is a pure, unit-tested `shedToBudget()`; end-to-end,
`perf/oom.bench.ts` now **plateaus at ~325 MB out to 256 stalled clients (was OOM-killed at ~112)**
and the process survives. `writableLength` is the right metric: it measures exactly the in-process
backlog that OOMs (on a platform whose kernel absorbs the data in its own bounded send buffer, the
process never accumulates and the guard correctly stays idle).

### 8. [DONE] APPEND read-side slow-upload OOM

The mirror image on the *read* path. `APPEND INBOX {25000000}` makes the server buffer the whole
declared literal in the connection's receive buffer before it can store the message, so a client
that declares a big literal then uploads slowly (or withholds the terminating CRLF) pins ~its size
per connection — and, across connections each needing only ONE APPEND, that OOMs the process too.
Reproduced live (`perf/append-oom.bench.ts`): RSS grew **~23 MB per stalled APPEND** on the box,
reaching **1466 MB at 64 connections** and tripping the kernel's `TCP: out of memory` — ~140 would
have OOM-killed node.

Because a literal's size is *declared* up front, this is bounded cleanly rather than by shedding: a
new APPEND **reserves** its declared size against a server-wide budget (`MAX_APPEND_INFLIGHT`,
256 MiB, configurable) and is **refused with a transient `NO`** once that would exceed it — a
synchronizing literal then never sends its data (and retries); a non-synchronizing one drops the
link, as the size cap already does. The reservation is released on completion, error, or disconnect.
Verified on the box: RSS now **plateaus at ~388 MB out to 128 stalled uploaders** (116 refused) and
a real IMAPS `APPEND` is unaffected. Regression test covers refusal-at-budget and release on both
completion and disconnect.

*Related inefficiency (not a vulnerability, left as-is):* the receive buffer grows via
`Buffer.concat` per chunk, which is O(n²) for a large literal and generates enough GC-lagged garbage
to inflate the plateau above the reserved live set (~388 MB vs ~256 MB on the box; more on a machine
with idle RAM). The budget bounds it regardless, and V8 collects the garbage under pressure, so this
is a CPU/transient-allocation wart, not a memory-safety issue — a chunk-list accumulation would tidy
it but means restructuring the heavily-tested literal/line/pipelining data loop, not worth the risk.

### Parser / protocol abuse — held

Nine pathological inputs (a 64 KB explicit sequence set, an over-cap command line, `FETCH
1:4294967295`, astronomically large explicit UIDs, an APPEND literal declared-but-never-sent, an
over-25 MB APPEND, binary/NUL floods, 2000-connection connect/disconnect churn, 10k pipelined
commands) all left the server **alive and responsive**, RSS flat. The sequence-set parser clamps
ranges to the largest UID in use (no enumeration blow-up), the command line is capped at 64 KB, the
APPEND literal at 25 MB, and connections at 512 (Node's `maxConnections`, which drops a flood
cleanly). One cosmetic note: the 64 KB line cap is only checked while a line is *unterminated*, so a
complete oversized line arriving in a single loopback chunk is parsed — network-safe (TCP delivers
it in ≤64 KB reads, which the cap catches), not worth hardening.

## Outbound + mixed load — the send leg and everything at once (2026-07-19)

A fourth round measured the *outbound* path and then ran inbound + outbound + IMAP together to the
edge of what the box sustains (`perf/outbound.bench.ts`, `perf/mixed-load.bench.ts`). One real bug,
one hardening, and a clean bill on robustness.

### Outbound ceiling (box)

Two stages, different limits:

- **Submission accept: ~59 msgs/s.** Authenticated STARTTLS+AUTH clients → sender-authz → header
  fix-up → **DKIM RSA-2048 signing** → enqueue. Signing is the cost (the laptop does ~258/s).
- **Relay drain: ~11 msgs/s.** The `RelayLoop` processes the queue **serially** — one MX dialog at
  a time (`for (const entry of due) await processEntry(...)`) — even to an instant-accepting local
  sink. The real internet is slower still (per-message DNS + TLS + remote acceptance). ~11/s is
  ~40k mail/hour, ample for personal scale, but it means a burst drains slowly and, crucially, that
  submission can outrun it.

### 6. [DONE] Outbound-queue backpressure

Because submission (59/s) outruns the serial relay (11/s) and applied **no backpressure**, a
sustained outbound stream grew the queue without bound — mixed-load runs showed depth climbing
0→520+ monotonically. Each queued row holds the whole signed body, so that is a **disk**-exhaustion
vector for a runaway or compromised authenticated account (the disk analogue of the FETCH OOM).
Fix: submission now returns a transient **451 4.3.1** for a message needing outbound queuing once
`queue.size >= maxQueueDepth` (config, default 10000 — generous vs a legitimate downstream-outage
backlog, tiny vs the disk), checked *before* local delivery so a refused message is never
half-delivered then retried, and a purely-local message is never refused.

### 7. [DONE] Shutdown race — relay tick vs. DB close

The real bug the mixed load exposed. `RelayLoop.stop()` cleared its interval timer but did **not**
wait for an in-flight tick, so a tick draining a backed-up queue kept running while `close()` went
on to close the control database — and the tick's next `queue.due()` hit a closed handle:
**`Error: database is not open`**, an unhandled rejection on every shutdown that had outbound mail
queued (i.e. exactly when the box is busy). `stop()` is now async, sets a stop flag, and awaits the
in-flight tick, which bails at the next entry boundary leaving the rest durably queued; `close()`
awaits it before closing the DB. Verified in production: `systemctl stop` now logs a clean
"Deactivated successfully" with no error. Regression test reproduces the race.

### Robustness under sustained mixed load — clean

20 s of 6 inbound + 6 outbound + 6 IMAP workers at once (all four SQLite writers — enqueue,
relay-settle, inbound delivery, IMAP store — contending), including a **40%-rejection bounce storm**
(432 DSN bounces + 216 dead-letters): **zero errors, zero `SQLITE_BUSY`, no memory growth** (RSS
flat 48→50 MB), no crash, no backscatter loop. The synchronous single-thread + `busy_timeout`
serialise the writers cleanly, and the bounce/dead-letter path holds under load. Throughput per
stream falls to ~30/s each as the three compete for two cores — expected, not a fault.
