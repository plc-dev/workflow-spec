# Spike 1.2 — PRIMARY, DEEPEST SPIKE: Postgres-durable-execution pattern (resonate-pg-shaped)

**Task**: tasks.md 1.2. Fork a documented Postgres-durable-execution pattern
(e.g. resonate-pg) and run the SQL-session scenario against it, testing
whether the placement-resolver (D4/1.10) and session log (D3/3.1) can
genuinely share one Postgres instance/transaction with the durability layer -
the 4-way infra-consolidation claim at its **DEEP** end (same-transaction
atomicity, not just same-instance locality) - plus D3's linear-per-session-
mutation guarantee under concurrent/crash conditions via ordinary
`SELECT ... FOR UPDATE` discipline.

## What was built

Rather than installing resonate-pg's actual 1,351-line SQL file verbatim
(which targets Supabase Edge Functions + pg_cron/pg_net for async HTTP
invocation), this spike forks the **underlying pattern** design.md D6
documents as common to resonate-pg, DBOS, and the Hatchet-published tutorial
("THE PATTERN": an executions table, `SELECT ... FOR UPDATE SKIP LOCKED`
claiming, a `UNIQUE(execution_id, step_id)` checkpoints table, lease-based
sweeping) - because that pattern, not resonate-pg's Supabase-specific
transport, is what's actually under test. This is a closer analog to
"ordinary `SELECT ... FOR UPDATE` discipline" as named in the task, and lets
the spike run as a plain worker loop against a plain Postgres instance
without pulling in Supabase/pg_cron/pg_net.

One Postgres schema (`spike`, see `schema.sql`) hosts all four consolidation
candidates side by side:

- `executions` + `checkpoints` — the durability core (D6)
- `session_log` + `session_pointer` — D3's session input-history log
- `placement` — D4's placement-resolver (content-hash -> warm replica)

A single worker transaction (`src/worker.js: processOneExecution`) claims one
execution via `claim_execution()` (SKIP LOCKED), then - **in that same
transaction** - takes a `FOR UPDATE` lock on the session's pointer row,
appends to `session_log`, advances the pointer, upserts `placement`, writes
the `checkpoints` row, and marks the execution `done`, before committing
once. If any step fails, the whole transaction rolls back.

## Results

All three tests pass reliably (`npm run test:happy`, `test:contention`,
`test:crash`), run against a real Postgres 16 instance (Docker):

### 1. Happy path — final-state consistency, uncontended

After processing N queued mutations for one session, sequentially, with no
failure injected: `executions(done) == checkpoints == session_log rows ==
N`, exactly, with a contiguous seq chain and a pointer matching the last log
entry.

**Scope of what this proves**: on its own, an uncontended, failure-free run
like this cannot distinguish a same-transaction (DEEP) implementation from
one that commits the same four writes in four separate, sequential
transactions - both would produce an identical final state when nothing
fails mid-run. This test establishes the *baseline* invariant the other two
tests then check under adversarial conditions; the atomicity claim itself is
substantiated by the crash test (§3 Scenario 1), which injects an actual
failure boundary mid-transaction and checks what survives it.

### 2. Contention — D3's linear-per-session-mutation guarantee under concurrency

8 concurrent workers raced against 80 queued mutations spread across **two**
interleaved sessions (40 each), all pulled from the same shared queue by the
same worker pool - i.e. no worker is statically assigned to "session A's
work" vs "session B's work". Result: exactly 80 total completions (no
double-claim, thanks to `SKIP LOCKED`), and **both** sessions' `session_log`
sequences came out independently contiguous and duplicate-free (`1..40`
each) purely from `FOR UPDATE` locking on each session's own pointer row -
no extra application-level coordination, mutex, or distributed lock, and no
cross-session contamination despite the interleaving.

**Scope of what this proves**: this is a correctness result (per-session
linear chains stay correct even when a shared, unpartitioned worker pool
interleaves two sessions' work), not a timing/throughput measurement. The
lock predicate is `WHERE session_id = $1`, so by ordinary Postgres row-lock
semantics a lock on session A's pointer row cannot block a transaction
locking session B's pointer row - but this spike did not instrument
lock-wait timing to directly measure that workers on different sessions
truly never wait on each other; it infers it from Postgres's documented
row-level locking semantics plus the correctness result above, not from a
timing measurement.

### 3. Crash test — two distinct recovery mechanisms, tested separately

Two DIFFERENT failure shapes were tested, deliberately kept separate because
they exercise different recovery paths and reporting them together
previously conflated which mechanism did the recovering:

**Scenario 1 — mid-transaction crash.** A worker was allowed to write all
three concerns' rows (checkpoint, session_log, placement) *inside* an open
transaction, then its Postgres backend was forcibly terminated
(`pg_terminate_backend`) before `COMMIT` was ever sent - simulating a hard
process crash mid-transaction (exactly the "mid-transaction kills" design.md
D6 calls out).

- **Atomicity held**: zero rows survived in `checkpoints`, `session_log`, or
  `placement` after the kill. Postgres rolled back the entire transaction,
  not "most of it."
- A consequence worth calling out explicitly: because `claim_execution()`
  runs *inside* that same transaction, the claim itself rolled back too -
  the execution reverted all the way to `status='queued', attempts=0`, not
  merely to `running` with a live lease. Recovery from this failure shape is
  therefore **immediate** (a subsequent claimant does not need to wait out
  any lease), which is confirmed directly: a second worker re-claimed and
  completed the same execution right away, ending with exactly one
  `session_log` row and one `checkpoints` row - no duplicate side effects
  from the crashed attempt (which never committed anything to duplicate).

**Scenario 2 — a committed claim whose worker then goes dark.** A genuinely
different failure shape: the *claim* itself is committed on its own (e.g. a
heartbeat/lease-renewal-style pattern), and then the worker disappears
before ever completing the step. Recovery here does depend on lease expiry,
tested directly with a short (1s) lease: once it expired, a second worker
re-claimed and completed the execution, ending at `attempts=2` (the
abandoned claim + the lease-sweep re-claim), with exactly one `session_log`
row and one `checkpoints` row for that execution - again no duplicate side
effects.

## Verdict on the 4-way consolidation claim

**The DEEP claim holds, not just the SHALLOW one.** The durability layer
(D6), the placement-resolver (D4/1.10), and the session log (D3/3.1) share
not just one Postgres instance but literally one transaction per step - a
session-log mutation and its corresponding placement/checkpoint write commit
together or not at all, matching what design.md attributed to Restate's
Virtual Objects as a "for free" property. The atomicity half of this claim
is demonstrated concretely by the crash test (§3 Scenario 1): killing the
connection mid-transaction rolls back every one of the four writes together,
with none surviving partially - confirming design.md D6's framing of
resonate-pg-shaped forks as "structurally positioned for the DEEP end." (The
happy-path test alone would not have distinguished this from four separate
commits; it needed the injected failure boundary to actually test atomicity
rather than just final-state consistency.)

**D3's linear-per-session-mutation guarantee also holds under both
concurrent and crash conditions**, using nothing beyond ordinary `SELECT
... FOR UPDATE` on a per-session row - no bespoke sequencer, no external
lock service. The concurrency test additionally checked, with two
interleaved sessions processed by one shared worker pool, that this
per-session locking doesn't cross-contaminate sessions; it did not directly
measure that cross-session workers avoid lock-wait entirely (see caveats).

## Caveats / what this spike does NOT settle

- The cross-session non-contention property (§2) is checked for
  correctness, not measured for timing/lock-wait: this spike infers "workers
  on different sessions don't block each other" from Postgres's documented
  per-row `FOR UPDATE` locking semantics plus the observed correctness
  result, rather than from direct lock-wait instrumentation. A follow-up
  that wants a hard throughput/latency number here would need to add that
  instrumentation.
- The happy-path test alone does not prove same-transaction atomicity (any
  four-separate-commits implementation would look identical when nothing
  fails); the atomicity claim rests on the crash test (§3 Scenario 1), which
  does inject a real failure boundary.
- This tests the **pattern**, not resonate-pg's actual promise/task/timer
  protocol, HTTP-push transport (pg_net), or its `ctx.sleep`/durable-timer
  semantics (pg_cron) - those are orthogonal to the consolidation question
  this spike was scoped to, but would need their own validation before
  fully committing to resonate-pg specifically over a from-scratch fork of
  THE PATTERN.
- Single-Postgres-instance scale/throughput ceiling (vacuum/bloat under
  heavy `UPDATE`-in-place churn on `executions`, connection-count limits
  under many concurrent workers) was not load-tested here - this spike used
  8 workers / dozens of rows, not a production-scale fan-out.
- R12 (bounded agent-directed composition, long multi-round tool loops) was
  not exercised in this spike; design.md already cites resonate-pg's own
  agent-loop example as evidence for R12, which this spike did not need to
  re-derive.
- This spike did not exercise the LISTEN/NOTIFY wakeup optimization or the
  `waits` table (durable sleep) from THE PATTERN - out of scope for the
  consolidation question, relevant to R5/session-longevity separately.

## How to reproduce

`npm test` runs all four test scripts (happy-path, contention, crash, load)
sequentially against ONE self-managed Postgres container lifecycle (see
`run-all-tests.js` and the shared `../../scripts/with-postgres.sh` wrapper it
calls) - no manual `docker run` step is required:

```bash
npm install
npm test
```

Each individual script (`npm run test:happy`, `test:contention`,
`test:crash`, `test:load`) is also independently self-contained - each
starts and tears down its own container. If Docker isn't available, or the
container never becomes ready, these fail loudly (non-zero exit) rather
than skipping the database-dependent assertions.
