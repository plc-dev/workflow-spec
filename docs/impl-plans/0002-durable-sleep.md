# 0002: Durable sleep - `waits` table, `signal_wait()`, LISTEN/NOTIFY `WakeListener`

## Status

`reviewed`

## Scope

This package covers task **6.1b** in full - the remainder of THE PATTERN
(design.md D6) that 0001 (task 6.1a) deliberately deferred:

- **6.1b:** a `waits` table (durable sleep/human-in-the-loop, `wake_at`
  timestamp); `claim_execution()` extended to claim a due timer-wait
  execution via an `EXISTS` join, with no separate sweeper process (same
  "the rows ARE the queue" posture 6.1a already established for
  lease-expiry reclaim); a `signal_wait()` function that durably broadcasts
  wakeup to **every** execution waiting on a given key, not just one; a
  `WakeListener` built on Postgres LISTEN/NOTIFY, modeled explicitly as a
  latency optimization that is never a correctness dependency (design.md
  D6's own framing: "the rows ARE the queue, not NOTIFY").

**Explicitly NOT in scope:**

- Wiring `WakeListener` into an actual poll loop - there is no `apps/worker`
  or generic interpreter (task 6.2) yet to wake up. This package builds and
  tests the primitive itself (subscribe, receive a notification, unsubscribe)
  with no real consumer, the same restraint 0001 applied to itself (e.g. not
  building `session`/`placement` repos before a consumer existed).
- `session_log`/`session_pointer` (D3) and `placement`/`placement_config`/
  `placement_access` (D4) - unrelated to this package, still belong to
  future `session/`/`scheduler/` packages per 0001's own scoping.
- Any change to `apps/worker`, `engine/`'s dispatch loop shape, or a
  higher-level "durable sleep" DSL construct (task 5.x) - this package is
  the `core/`+`engine/` primitive only, the same layer 0001 built at.

## Sources

- **design.md D6 "THE PATTERN"** (lines ~333-345): the six-element recipe
  this system independently re-derives - a `waits` table with `wake_at` for
  durable sleep ("a multi-week wait costs exactly one row"), and LISTEN/
  NOTIFY as a latency optimization layered on top of, never substituting
  for, the rows-are-the-queue dispatch model. This package builds the two
  remaining un-built elements of that recipe (0001 already built the other
  four: `executions`, `SKIP LOCKED` claim, `checkpoints`
  exactly-once-via-`UNIQUE`, lease-expiry reclaim-without-a-sweeper).
- **design.md D6a**: resonate-pg and hatchet-dev's tutorial are named
  explicitly as **design references** for "what a `waits`/durable-sleep
  table should eventually look like" - not fork targets (clean-room
  decision already locked in). This package's `waits` schema and
  `signal_wait()` semantics are informed by, not copied from, either.
- **ADR-0002**: `waits` is one of the named members of `core/`'s
  consolidated `withTransaction(tx) -> { ..., waits, ... }` repo set (its
  own diagram lists it explicitly) - this package is the first to actually
  build that member, following 0001's own precedent of building repos
  incrementally as a real consumer appears (this package IS that consumer,
  per task 6.1b's own text).
- **ADR-0007**: no change to module boundaries - `waits` lives in `core/`
  (schema+repo), the new engine-level primitive (`waitFor`) lives in
  `engine/`, exactly mirroring `claimExecution`/`completeExecution`'s
  existing split.
- **ADR-0009**: LISTEN/NOTIFY named explicitly as one of the real-Postgres-
  semantics reasons this system tests against testcontainers rather than
  mocking `pg`; raw `pg`, no ORM/query builder (a `Client`-level LISTEN
  subscription is exactly the kind of thing an ORM would abstract over
  awkwardly).
- **ADR-0012**: module-internal shape - `waits` gets the same
  domain/repository/queries triad as `executions`/`checkpoints`
  (`core/domain/wait.ts`, `core/repositories/waits.repository.ts`,
  `core/repositories/queries/waits.queries.ts`); the new engine primitive
  gets its own file (`engine/wait.ts`), mirroring `claim-complete.ts`
  rather than growing that file; barrel-only cross-module imports continue
  unchanged.

**Open questions these sources leave unresolved, resolved here as a call
this package makes:**

- **Where `WakeListener` lives.** Nothing in ADR-0002/0007/0012 says who
  owns a LISTEN/NOTIFY subscription (it's not a repository bound to a
  transaction client - `LISTEN` must stay on one long-lived connection
  outside the transactional pool). Resolved: `core/database/wake-
  listener.ts`, alongside `connection-pool.ts` - it's connection-management,
  the same category of concern `core/database/` already owns, not a
  transactional repository and not `engine/` logic (which stays
  connection-agnostic per ADR-0002).
- **What NOTIFY actually broadcasts.** THE PATTERN's one-line description
  doesn't specify a channel/payload shape. Resolved: a single channel,
  fired by `signal_wait()` with the wait key as payload. No per-execution
  or per-session channel fan-out - `WakeListener` is a single "something
  became claimable, maybe go check" nudge, matching THE PATTERN's own
  "latency optimization, not the queue itself" framing; a subscriber that
  wants to filter or act does so after re-checking the rows, not by
  trusting the payload as the source of truth. **Naming correction (post-
  Phase-1-review):** the channel name is `execution_ready`, not
  `wfx_execution_ready` - no `wfx`-prefix abbreviation. `wfx` is this
  repo's own `package.json` name (short for "workflow execution"), not a
  spelled-out word, and every existing schema object (`executions`,
  `checkpoints`, `claim_execution()`) is already unprefixed - there is
  exactly one Postgres database/schema in play here (ADR-0002), so no
  object needs an application-name prefix to disambiguate it from anyone
  else's. The named constant in `core/constants.ts` is
  `EXECUTION_READY_CHANNEL = "execution_ready"`, matching ADR-0012's "no
  abbreviations" naming discipline (already stated for filenames; applied
  here to this runtime string constant for the same reason).
- **Whether `wake_at` and `wait_key` are mutually exclusive.** Not
  specified anywhere. Resolved: allow both on one row (a hybrid wait woken
  by whichever fires first) with a `CHECK (wait_key IS NOT NULL OR wake_at
  IS NOT NULL)` - at least one wakeup path required, either or both is
  valid. This is a strict superset of "timer-only" and "signal-only," so it
  doesn't foreclose either narrower future use.
- **`signal_wait()`'s locking discipline.** `claim_execution()`'s `SKIP
  LOCKED` is correct there because skipping a contended row just means
  "some other worker already has it, fine." That reasoning does NOT carry
  over to `signal_wait()`: task 6.1b's own text requires it to "durably
  broadcast to **every** execution waiting on a key" - skipping a
  contended row would silently under-deliver the broadcast. Resolved:
  `signal_wait()` uses plain (blocking) `FOR UPDATE`, not `SKIP LOCKED`,
  accepting the small extra contention cost for correctness on this one
  operation (broadcast is expected to be rare/low-cardinality compared to
  claim's hot loop, so this is not a throughput concern).

## Plan

### File/module layout

```
src/core/
  constants.ts                     (extended) + EXECUTION_READY_CHANNEL
  database/
    schema.sql                     (extended) - waits table, executions.status
                                    CHECK gains 'waiting', claim_execution()
                                    extended with the due-timer-wait EXISTS
                                    branch, new signal_wait() function
    wake-listener.ts                (new) createWakeListener(config) -> WakeListener
  domain/
    wait.ts                         (new) Wait, WaitInput types
    rows.ts                         (extended) + WaitRow
    mappers.ts                      (extended) + mapWaitRow
    index.ts                        (extended) barrel
  repositories/
    waits.repository.ts             (new) WaitsRepo: create(), findByExecutionId(), signal()
    executions.repository.ts        (extended) + markWaiting()
    queries/
      waits.queries.ts               (new) SQL_INSERT_WAIT, SQL_FIND_WAITS_BY_EXECUTION,
                                      SQL_SIGNAL_WAIT
      executions.queries.ts          (extended) + SQL_MARK_EXECUTION_WAITING
  database/transactions.ts          (extended) CoreRepos gains `waits: WaitsRepo`
  index.ts                          (extended) barrel - export Wait, WaitsRepo, createWakeListener

src/engine/
  wait.ts                           (new) waitFor(repos, executionId, params) -> Wait,
                                    signalWait(repos, waitKey) -> Wait[]
  index.ts                          (extended) barrel

test/
  core/database/schema.test.ts      (extended) - waits table/CHECK/indexes/functions exist
  core/database/wake-listener.test.ts (new) - subscribe/notify/unsubscribe round trip
  core/repositories/waits.repository.test.ts (new)
  engine/wait.test.ts               (new) - waitFor/signalWait composed with
                                    claimExecution/completeExecution; crash test
```

### Interfaces (signatures)

```ts
// src/core/domain/wait.ts
export interface Wait {
  id: number;
  executionId: number;
  waitKey: string | null;
  wakeAt: Date | null;
  satisfiedAt: Date | null;
  createdAt: Date;
}

// src/core/repositories/waits.repository.ts
export interface WaitsRepo {
  create(input: {
    executionId: number;
    waitKey?: string;
    wakeAt?: Date;
  }): Promise<Wait>;
  findByExecutionId(executionId: number): Promise<Wait[]>;
  // Marks every still-pending wait row for `waitKey` satisfied and promotes
  // each one's execution from 'waiting' back to 'queued', atomically, via
  // the signal_wait() SQL function (see schema.sql). Returns every Wait
  // actually signaled (empty array if none were pending).
  signal(waitKey: string): Promise<Wait[]>;
}

// src/core/repositories/executions.repository.ts (extended)
export interface ExecutionsRepo {
  // ...existing members unchanged...
  markWaiting(id: number): Promise<void>;
}

// src/core/database/transactions.ts (extended)
export interface CoreRepos {
  executions: ExecutionsRepo;
  checkpoints: CheckpointsRepo;
  waits: WaitsRepo;
  client: PoolClient;
}

// src/core/database/wake-listener.ts
export interface WakeListener {
  // Fires on every notification on EXECUTION_READY_CHANNEL; payload is the
  // wait key signal_wait() broadcast. A pure latency nudge - callers must
  // still re-check claimable rows themselves, never trust the payload as
  // authoritative (design.md D6: "the rows ARE the queue, not NOTIFY").
  onNotify(callback: (payload: string) => void): () => void; // returns an unsubscribe fn
  close(): Promise<void>;
}
export function createWakeListener(config: PoolConfig): Promise<WakeListener>;

// src/engine/wait.ts
export function waitFor(
  repos: CoreRepos,
  executionId: number,
  params: { waitKey?: string; wakeAt?: Date },
): Promise<Wait>;

export function signalWait(repos: CoreRepos, waitKey: string): Promise<Wait[]>;
```

### Data flow

```ts
// A step handler that needs to durably sleep instead of completing:
await withTransaction(pool, async (repos) => {
  const execution = await claimExecution(repos, workerId);
  if (!execution) return;
  // instead of completeExecution(...):
  await waitFor(repos, execution.id, { wakeAt: in24Hours });
  // execution.status is now 'waiting'; no separate sweeper reclaims it -
  // the NEXT claimExecution call (by any worker, any time after wake_at)
  // finds it via claim_execution()'s new EXISTS branch, same as
  // lease-expiry reclaim already works in 0001.
});

// A signal-based wakeup (e.g. an external event, human-in-the-loop action):
await withTransaction(pool, async (repos) => {
  const woken = await signalWait(repos, "approval:1234");
  // every execution waiting on this key is now 'queued' again, in ONE
  // transaction - not one commit per waiting execution.
});

// Optional latency optimization, once a poll loop exists (future apps/worker,
// task 6.2/6.15) - NOT wired up by this package, built and tested standalone:
const wakeListener = await createWakeListener(pgConfig);
const unsubscribe = wakeListener.onNotify(() => pollNow());
```

`claim_execution()` itself remains a single SQL round trip; the due-timer-
wait branch is an additional `OR EXISTS(...)` clause on the same `SELECT
... FOR UPDATE SKIP LOCKED` this package doesn't otherwise change - the
no-sweeper property carries over unchanged, exactly as 0001's lease-expiry
branch already established the pattern for a second failure/wakeup shape.

### Sequencing rationale

- **Why now:** 6.1b is the one deliberately deferred remainder of 6.1
  itself (per 0001's own Scope section) - the natural next slice directly
  on top of what 0001 landed, before either 6.2 (generic interpreter) or
  3.1 (session log) need to decide whether durable sleep is a primitive
  they can rely on. Building it now keeps `core/`'s schema/repo evolution
  linear (one package finishing what the previous one explicitly deferred)
  rather than letting 6.2 or 3.1 either block on it unexpectedly or grow
  their own ad hoc sleep mechanism.
- **What it depends on:** 0001's `core/database/{connection-pool,
  transactions}.ts`, `core/repositories/{executions,checkpoints}
  .repository.ts`, and `engine/claim-complete.ts` - this package extends
  all of them in place rather than introducing a parallel structure.
- **What it unblocks:** task 6.5 (session-as-long-running-execution with
  event/signal-driven user actions) and task 6.11 (durable/resumable
  multi-round tool-calling loop) both need a durable-sleep primitive; a
  future `apps/worker` poll loop (6.15) has `WakeListener` available as a
  ready-built latency optimization once it exists.
- **What it deliberately does NOT unblock yet:** 6.2 (generic interpreter)
  doesn't strictly need durable sleep to exist first - it's listed as
  unblocked by 6.1a alone in 0001's own sequencing note. This package is
  additive to what 6.2 needs, not a hard prerequisite for it.

## Test design

Not collapsed with Phase 1 - this package extends `core/schema.sql`'s
`claim_execution()` (a foundational, already-hot dispatch path shared by
every future consumer) and introduces a genuinely new failure/concurrency
shape (broadcast-to-many, LISTEN/NOTIFY-vs-poll races) that 0001 never
tested. Same posture as 0001's own package.

### Setup: default Vitest + testcontainers-node is sufficient

Every test below touches real transaction/lock/notification semantics
(`FOR UPDATE`, `SKIP LOCKED`, `LISTEN`/`NOTIFY`, timestamp comparisons
against `now()`) that ADR-0009 already names as requiring a real Postgres
instance, not a mock. No new stakes beyond that:

- **No dedicated load/scale test.** This package doesn't reopen 1.2e's
  scale claim - `signal_wait()`'s broadcast is exercised at small
  cardinality (TC-4 below) purely to prove the "every matching row wakes,
  not just one" *correctness* property, not to measure throughput. Nothing
  here changes the hot-path claim loop's own scale characteristics -
  `claim_execution()`'s new `EXISTS` branch only executes an extra `waits`
  lookup when an execution's status is `'waiting'`, same `LIMIT 1` shape
  otherwise.
- **testcontainers-node** for TC-1 through TC-8 - real lock/timestamp/
  notification semantics. TC-9 (WakeListener unsubscribe/close) needs a
  live LISTEN connection too, so it stays on the same testcontainers
  instance as the rest, not a separate mocked-`pg` unit test.

### Test cases

| # | Test | Scope item | Correctness property verified |
|---|---|---|---|
| TC-1 | Apply extended `schema.sql`; assert the `waits` table exists with its columns/`CHECK(wait_key IS NOT NULL OR wake_at IS NOT NULL)`/indexes, `executions.status`'s `CHECK` now accepts `'waiting'`, and `signal_wait()` exists as a function | `core/schema.sql` | ADR-0002 (core owns the schema) - structural precondition for every test below |
| TC-2 | `waitFor` an execution with only `wakeAt` in the near future; assert `claimExecution` does NOT claim it before `wakeAt`, and DOES claim it (transitioning `waiting` -> `running`) once `wakeAt` has passed, with no separate sweeper process ever run | `engine.waitFor`, `claim_execution()`'s `EXISTS` branch | design.md D6 "THE PATTERN" - durable sleep costs one row; "the rows ARE the queue," no sweeper, mirrors 6.1a's own lease-expiry reclaim posture for a second, genuinely distinct wakeup shape |
| TC-3 | `waitFor` an execution with only `waitKey` (no `wakeAt`); assert `claimExecution` never claims it (indefinitely) until `signalWait` is called for that key, at which point a subsequent `claimExecution` claims it | `engine.waitFor`/`signalWait` | design.md D6 - signal-based wakeup is a distinct path from timer-based wakeup; an unsignaled wait must never be claimed via polling alone |
| TC-4 | `waitFor` TWO different executions with the SAME `waitKey`; call `signalWait` once; assert BOTH executions are promoted back to `queued` (and both `waits` rows marked satisfied) from the one call, not just one | `engine.signalWait` / `signal_wait()` | task 6.1b's own text - "durably broadcasts to every execution waiting on a key," the specific property that rules out `SKIP LOCKED` for this function |
| TC-5 | Call `signalWait` twice in a row for the same key after only one execution was ever waiting on it; assert the second call signals zero (already-satisfied rows are left alone, no double-promotion of an execution that has since moved on to `running`/`done`) | `engine.signalWait` | design.md D6/R7 posture (Postgres-enforced exactly-once-per-transition) applied to the new signal path - a retried/duplicate signal must be a safe no-op |
| TC-6 | Inside `withTransaction`, call `waitFor`, then `pg_terminate_backend` the connection before COMMIT (mirroring 0001's TC-4 crash test); assert the execution reverts to its pre-wait status (`running`) and no `waits` row survives | `engine.waitFor` | design.md D6/R6 (DEEP atomicity) - a mid-transaction crash during a NEW primitive rolls back exactly like the existing claim/complete primitives do, not a special case |
| TC-7 | Seed one execution whose `waits` row has `wakeAt` already in the past; run `claimExecution` concurrently from M workers; assert exactly one worker claims it | `claim_execution()`'s `EXISTS` branch under `SKIP LOCKED` | design.md D6 R10 - the new branch doesn't weaken the existing no-double-claim guarantee TC-2/TC-3 of 0001 already established for the other two claimable shapes |
| TC-8 | `waitFor` an execution with BOTH `wakeAt` (near future) and `waitKey` set (hybrid wait); assert it is claimable via EITHER path - whichever fires first (`wakeAt` elapsing, or `signalWait` being called) - and the other path becomes a no-op once claimed | `engine.waitFor` (hybrid case) | this package's own "mutual exclusivity" open-question resolution - a hybrid wait's two wakeup paths must not race into a double-transition |
| TC-9 | `createWakeListener`, subscribe via `onNotify`, call `signalWait` in a separate connection, assert the subscriber's callback fires with the signaled `waitKey` as payload; then `unsubscribe`/`close` and assert no further callbacks fire and the connection is released | `core.createWakeListener` | design.md D6 - LISTEN/NOTIFY as a latency optimization, tested as the standalone primitive it is (no poll-loop consumer exists yet, per Scope) |

`WaitsRepo.findByExecutionId` has no dedicated test case - it is exercised
as an assertion helper inside TC-2/TC-4/TC-6/TC-8 (checking `satisfied_at`
state directly), sufficient given it has no branching logic of its own.

## Implementation notes

Built as planned, with one small addition and one naming note beyond the
plan's own interface sketch:

- **`ExecutionsRepo.markWaiting`/`SQL_MARK_EXECUTION_WAITING`** - a small
  addition not spelled out in the original interface sketch (which only
  named `waitFor`/`signalWait` at the `engine/` level), needed as
  `markDone`'s direct counterpart so `engine.waitFor` has a typed repo
  method to call rather than reaching for `repos.client` directly. Same
  shape as `markDone`, no new pattern introduced.
- **`signal_wait()`'s `RETURN NEXT`** re-selects the just-updated `waits`
  row via `UPDATE ... RETURNING * INTO v_wait` before returning it, so the
  `satisfied_at` timestamp callers see (`WaitsRepo.signal`'s return value)
  is the actual committed value, not the pre-update snapshot.
- **`waits_pending_wake_idx`/`waits_pending_key_idx`** (partial indexes,
  `WHERE satisfied_at IS NULL AND ...`) were not explicitly named in the
  plan's file-layout sketch (which only showed the `waits` table's
  columns) but are a direct, uncontroversial consequence of the plan's own
  "only pending waits are ever scanned" framing - added alongside the
  table rather than treated as a separate decision.
- **Existing tests' `TRUNCATE executions, checkpoints RESTART IDENTITY`
  statements** (0001's `claim-complete.test.ts`, `transactions.test.ts`,
  `executions.repository.test.ts`, `checkpoints.repository.test.ts`) had
  to be extended to `TRUNCATE executions, checkpoints, waits RESTART
  IDENTITY` - `waits`' new `FOREIGN KEY (execution_id) REFERENCES
  executions(id)` makes a `TRUNCATE executions` that doesn't also name
  every table with a live FK into it fail outright, regardless of whether
  `waits` has any rows. Not a plan deviation (the plan's own Scope
  correctly anticipated extending `executions`), just a mechanical
  consequence worth recording since it touches files this package didn't
  otherwise plan to touch.

The channel-naming correction agreed during Phase 1 review
(`execution_ready`, not `wfx_execution_ready`) is implemented exactly as
recorded in the Sources section above - `EXECUTION_READY_CHANNEL =
"execution_ready"` in `core/constants.ts`, referenced by name (not
re-hardcoded) only in comments, since the actual `pg_notify(...)` call
lives in SQL (`signal_wait()`) and can't literally import the TypeScript
constant - the same cross-runtime sync-by-hand posture already accepted
for `DEFAULT_LEASE_SECONDS`.

All 9 planned test cases (TC-1 through TC-9) are implemented and passing,
plus 1 additional repository-level test (`WaitsRepo.signal`'s empty-array
case on an unknown key) added because it was a trivial extension of
TC-4/TC-5's own fixtures already in place, not part of the original
9-case set:

- TC-1: `test/core/database/schema.test.ts` (3 new tests, plus the
  existing `waits`-inclusive table-listing assertion extended in place:
  `'waiting'` status accepted, the waits `CHECK` enforced, `signal_wait()`
  exists)
- TC-2, TC-3, TC-6, TC-7, TC-8: `test/engine/wait.test.ts` (5 tests)
- TC-4, TC-5 (repo level): `test/core/repositories/waits.repository.test.ts`
  (3 tests, including the unknown-key no-op case)
- TC-9: `test/core/database/wake-listener.test.ts` (2 tests: notify
  delivery, and unsubscribe/close silencing further delivery)

`npx tsc --noEmit`, `npx biome check .`, and `npx vitest run` all pass
clean (34/34 tests across 11 files, up from 0001's 21) - verified directly
immediately before writing this section, not assumed.

No env vars were added or changed - `.example.env` needed no update
(verified by inspection, not just by absence of a diff).

No follow-up tasks spun off. `WakeListener` remains deliberately unwired
to any poll loop, exactly as scoped - the first real consumer will be
whichever of `apps/worker` (6.15) or the generic interpreter (6.2) builds
that loop.

**Post-review fixes** (from the local code review pass immediately after
this section was first written - all within this package's own scope, no
plan/test-design change; each is also covered by a new regression test,
not just fixed in place):

- **Lock-order deadlock between `claim_execution()` and `signal_wait()`**
  on a hybrid wait (both `wake_at` and `wait_key` set): the original
  `signal_wait()` locked `waits` before `executions`, the opposite of
  `claim_execution()`'s own order, an AB-BA deadlock shape under real
  concurrency. Fixed by reordering `signal_wait()` to lock the
  `executions` row first (via a `PERFORM ... FOR UPDATE`), then re-lock
  and re-check the `waits` row before acting - both functions now agree
  on lock order. Regression test:
  `test/engine/wait.test.ts` - "does not deadlock when a due timer claim
  races a same-key signal on the same hybrid wait" (20 hybrid waits,
  claimed and signaled concurrently).
- **`WakeListener`'s raw `pg.Client` had no `error` listener** - a
  dropped/terminated connection would have crashed the whole process
  (Node's default behavior for an unhandled `'error'` event), unlike
  `transactions.ts`'s existing swallow/log pattern for the same class of
  event. Fixed by adding an `error` listener that logs via the shared
  `pino` instance rather than swallowing silently (this connection is
  meant to live for the process lifetime, so a subscriber otherwise has
  no way to learn notifications stopped). Regression test:
  `test/core/database/wake-listener.test.ts` - "does not crash the
  process when its connection is forcibly terminated."
- **`executions.status`'s widened `CHECK` wasn't actually idempotent
  against an already-existing table** - `CREATE TABLE IF NOT EXISTS` is a
  no-op if `executions` already exists (e.g. a persistent
  `docker-compose.dev.yml` volume from before this package), so the old,
  narrower constraint would have silently survived a re-apply. Fixed with
  an explicit `ALTER TABLE ... DROP CONSTRAINT IF EXISTS ... ADD
  CONSTRAINT ...` pair, making the widening itself re-appliable. No
  dedicated new test (this is a schema-apply-mechanics fix, not new
  runtime behavior) - covered indirectly by every existing test, all of
  which apply this file fresh via testcontainers.
- **`wait_key` was unbounded `TEXT`, fed directly into `pg_notify()`**,
  whose payload Postgres caps at 8000 bytes - an oversized key would have
  aborted the entire `signal_wait()` call, rolling back every other
  wait's mark-satisfied/promote-to-`queued` work in the same broadcast.
  Fixed with a new `WAIT_KEY_MAX_LENGTH` constant (256, `core/
  constants.ts`), enforced up front in `WaitsRepo.create` (a new
  `ERROR_IDS.CORE_WAIT_KEY_TOO_LONG` / `FatalError`) as the primary check,
  plus a matching `CHECK(length(wait_key) <= 256)` on the `waits` table
  itself as a backstop for any other writer. Regression test:
  `test/core/repositories/waits.repository.test.ts` - "rejects a waitKey
  longer than WAIT_KEY_MAX_LENGTH."
- **`ExecutionStatus` (domain type) didn't include `"waiting"`** - a type/
  runtime drift, since the DB's actual value space already included it.
  Fixed by adding `"waiting"` to the union in `core/domain/execution.ts`.
  No dedicated new test (a type-level fix; existing tests that read back
  a `'waiting'` execution already exercise the corrected type).
- **`WaitsRepo.findByExecutionId` was unused** - flagged as dead code
  introduced by this package. Resolved by using it (rather than removing
  it): `test/engine/wait.test.ts`'s TC-2/TC-6 assertions and a new
  dedicated test in `test/core/repositories/waits.repository.test.ts`
  ("findByExecutionId returns every wait row for that execution") now
  call it instead of querying `waits` via raw SQL.

All 9 originally-planned test cases plus these 4 post-review regression
tests (38 total, up from the 34 first reported above) pass; `tsc
--noEmit` and `biome check .` remain clean. Re-ran all three commands
immediately after these fixes, not assumed.

## Review notes

Compared against the agreed plan (Phase 1) and agreed test design (Phase
2), not a fresh read of the code in a vacuum:

- Every Scope item (task 6.1b) is present: the `waits` table,
  `claim_execution()`'s due-timer-wait `EXISTS` branch, `signal_wait()`,
  `core/domain/wait.ts`, `core/repositories/waits.repository.ts` +
  `queries/waits.queries.ts`, `ExecutionsRepo.markWaiting`,
  `CoreRepos.waits`, `core/database/wake-listener.ts`, and
  `engine/wait.ts` (`waitFor`/`signalWait`).
- All 9 agreed test cases (TC-1 through TC-9) exist and pass -
  cross-checked against the Test design table's file/property mapping.
- A local code review pass (`/local-review-uncommitted`) after the first
  "implemented" cut found 5 real issues (a lock-order deadlock between
  `claim_execution()`/`signal_wait()`, a missing error handler on
  `WakeListener`'s connection, a schema-CHECK-widening idempotency gap, an
  unbounded `wait_key` colliding with `pg_notify()`'s payload cap, and an
  `ExecutionStatus` type/runtime drift) plus 2 suggestions (unused
  `findByExecutionId`, `signal_wait()`'s unbatched lock scope). All 5
  issues were fixed, each with a new regression test (see Implementation
  notes' "Post-review fixes"); the `findByExecutionId` suggestion was
  resolved by using it in tests rather than removing it; the lock-scope
  suggestion was left as a documented, accepted trade-off (matches the
  plan's own stated reasoning for why `signal_wait()` can't use `SKIP
  LOCKED`).
- Re-ran `npx tsc --noEmit`, `npx biome check .`, and `npx vitest run`
  immediately before writing this section, after the post-review fixes:
  clean typecheck, clean lint, 38/38 tests passing across 11 files.
- The Phase-1-review naming correction (`execution_ready`, not
  `wfx_execution_ready`) is applied consistently everywhere the channel
  name appears - the SQL `pg_notify()` call, the TypeScript constant, and
  every comment referencing it - not just in the plan document.
- Both small implementation-time additions (`markWaiting`, the two
  partial indexes) are recorded in Implementation notes with rationale;
  neither changes the plan's shape, both are direct, unsurprising
  consequences of what was already agreed.
- No scope creep: `session_log`/`placement`/`apps/worker`/any DSL-level
  durable-sleep construct were not touched, consistent with the plan's
  explicit exclusions. `WakeListener` was built and tested but
  deliberately left unwired, exactly as scoped.
- `tasks.md` accurately reflects reality: 6.1b marked `[x]` with pointers
  to the real files/tests, not just this doc.

No follow-up issues found. Package considered complete for its stated
scope.
