# 0001: Durable core - `core/` schema + `engine/` claim/complete primitives

## Status

`draft`

## Scope

This package covers task **6.1**, split into two sub-tasks because 6.1 as
written bundles two genuinely separable deliverables (the base durability
primitives, and durable-sleep/LISTEN-NOTIFY on top of them). This package
implements only the first:

- **6.1a (new, split from 6.1):** Promote spike 1.2's `executions`/
  `checkpoints` tables and `claim_execution()` dispatcher into `core/`'s
  schema (ADR-0002); stand up `core/`'s `withTransaction` primitive and
  typed repositories for these two tables; expose `engine/`'s
  `claimExecution`/`completeExecution` as two composable primitives that
  operate on a transaction handed to them, per ADR-0002's consolidation
  model. Base repo scaffolding (package.json/tsconfig/Biome/Vitest per
  ADR-0009, since nothing has been committed under `src/` yet) is included
  as it has no other home, as is the shared `pino` logger module (ADR-0009
  already decided the product; this package just stands up the shared
  instance since nothing has claimed that file yet either).
- **Explicitly NOT in scope, deferred to a follow-up package (tracked as
  new task 6.1b below):** the `waits` table, durable sleep,
  `signal_wait()`, and the `WakeListener` LISTEN/NOTIFY optimization.
  These are real parts of THE PATTERN (design.md D6) but are not required
  for the base exactly-once/crash-resumable durability guarantee this
  package tests, and pulling them in now would make this package's own
  test matrix (crash, contention, lease-expiry) harder to read against
  what it's actually proving. `session_log`/`session_pointer` (D3) and
  `placement`/`placement_config`/`placement_access` (D4) are correctly
  excluded per 6.1's own text - they belong to the `session/` and
  `scheduler/` packages respectively, built later against `core/`'s schema.

`tasks.md` will be updated (Phase 3) to replace task 6.1 with 6.1a (this
package, checked off) and 6.1b (left open, new).

## Sources

- **ADR-0002** (`@wfx/core` owns the consolidated schema): the
  `withTransaction(fn) -> repos` shape, and the rule that `engine/` never
  opens its own connection.
- **ADR-0007** (module inventory): `core/` and `engine/` module
  boundaries and dependency direction (`engine/` depends on `core/`, `ir/`;
  nothing depends on `engine/` yet since `apps/worker` doesn't exist).
- **ADR-0001/0009** (single TypeScript package, tooling): no `packages/`
  workspace, ESM, `strict` TS, raw `pg`, Vitest + testcontainers-node,
  single `schema.sql`, Biome.
- **ADR-0010** (CI/local dev): local dev Postgres via
  `docker-compose.dev.yml` (scoped down to just `postgres` for this
  package - `openbao`/`minio` have no consumer yet; `.dev` suffix makes the
  file's scope explicit - a persistent interactive-dev stack, distinct from
  testcontainers' per-test-run ephemeral one, per ADR-0010's own framing).
- **ADR-0009** (logging): general application logging is already decided -
  `pino`, structured JSON, with a shared `redact` config for secret-shaped
  fields (serving D7/task 9.6 later). Not an open question this package
  needs to make a fresh call on; this package just stands up the shared
  logger module (there being no prior home for it) and uses it minimally
  (a debug-level log line on claim/complete). No relation to `session_log`
  (D3) - that's a durable, queryable *domain* record of session mutations,
  not an application log; unaffected by this decision and still out of
  scope here.
- **design.md D6/D6a** ("THE PATTERN", the Postgres-native decision, the
  clean-room-over-fork decision): the correctness properties this package
  must reproduce from spike 1.2 (`archive/spikes/1.2-resonate-pg-durable-exec/`) -
  exactly-once via `UNIQUE(execution_id, step_id)`, crash-mid-transaction
  rollback-to-`queued`, and lease-expiry reclaim as a distinct failure
  shape - now as real, committed code rather than a spike.
- design.md D2/D3 (content-addressed state, event-sourced sessions) are
  background only here - this package does not touch `session_log`.

**Open questions these sources leave unresolved, resolved here as a call
this package makes:**

- ADR-0002's diagram shows `withTransaction(tx) -> { executions,
  checkpoints, waits, sessionLog, placement, datasetIndex, memoization }`
  as one large object. This package builds only the `executions` and
  `checkpoints` members now; the others are added incrementally by the
  packages that actually need them (`session/`, `scheduler/`,
  `dataset-catalog/`, the 6.1b follow-up). ADR-0002 mandates the *shape*
  (one `withTransaction`, one set of repos, one schema file) but not that
  every repo exist on day one - building the rest speculatively now, with
  no consumer, would contradict this project's own stated tooling posture
  (ADR-0009: "prefer the smallest tool that solves the problem in front of
  it").
- Postgres schema namespacing: spike 1.2 used a dedicated `spike` SQL
  schema for isolation from other experiments in the same DB. `core/`'s
  `schema.sql` uses the default `public` schema instead - there's no
  longer a need to isolate from other spikes, and ADR-0006 already gives
  `registry`/`workflow-store` their own separate *databases*, so no
  same-database name collision risk exists either.

## Plan

### File/module layout

```
package.json, tsconfig.json, biome.json, .nvmrc, vitest.config.ts   (new - base scaffolding)
docker-compose.dev.yml                                               (new - postgres only for now)

src/logger.ts           shared pino instance + redact config (ADR-0009); no consumer-specific
                         setup yet beyond this - apps/*'s own OpenTelemetry wiring is out of
                         scope until an app entrypoint exists
src/core/
  schema.sql            executions, checkpoints tables + claim_execution() SQL function
                         (ported from archive/spikes/1.2-resonate-pg-durable-exec/schema.sql,
                         dropping the session_log/session_pointer/placement tables - those
                         move to session/ and scheduler/'s future packages, and dropping the
                         `spike` schema wrapper per the namespacing decision above)
  db.ts                  createPool(config): Pool - thin wrapper over `pg.Pool`
  tx.ts                  withTransaction<T>(pool, fn: (repos: CoreRepos) => Promise<T>): Promise<T>
                          - BEGIN; build repos bound to the client; fn(repos);
                          COMMIT on success / ROLLBACK on throw; release in `finally`
  types.ts                Execution, Checkpoint row types
  repositories/
    executions.ts         ExecutionsRepo: claim(), findById(), markDone(), enqueue()
    checkpoints.ts         CheckpointsRepo: insert() (idempotent), findByExecutionAndStep()
  index.ts                 re-exports: createPool, withTransaction, CoreRepos type

src/engine/
  index.ts                claimExecution(repos, workerId, opts?), completeExecution(repos, params)
                          - pure functions over an already-bound CoreRepos, no connection of
                          their own (ADR-0002's "operate within a transaction handed to them")

test/
  core/tx.test.ts               withTransaction commit/rollback-on-throw, across two repos
  core/executions.test.ts       claim contention (SKIP LOCKED), lease-expiry reclaim
  core/checkpoints.test.ts      UNIQUE constraint idempotency
  engine/claim-complete.test.ts  claimExecution/completeExecution composed together;
                                 crash-mid-transaction test (pg_terminate_backend), mirroring
                                 spike 1.2's own crash test
```

### Interfaces (signatures)

```ts
// src/core/types.ts
export type ExecutionStatus = "queued" | "running" | "done" | "failed";

export interface Execution {
  id: number;
  sessionId: string;
  step: string;
  input: unknown;
  status: ExecutionStatus;
  workerId: string | null;
  leaseUntil: Date | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Checkpoint {
  executionId: number;
  stepId: string;
  output: unknown;
  committedAt: Date;
}

// src/core/repositories/executions.ts
export interface ExecutionsRepo {
  enqueue(input: { sessionId: string; step: string; input: unknown }): Promise<Execution>;
  claim(workerId: string, leaseSeconds?: number): Promise<Execution | null>;
  findById(id: number): Promise<Execution | null>;
  markDone(id: number): Promise<void>;
}

// src/core/repositories/checkpoints.ts
export interface CheckpointsRepo {
  // Idempotent: ON CONFLICT (execution_id, step_id) DO NOTHING, then re-select
  // if the insert hit the conflict, so callers never have to branch on retry.
  insert(executionId: number, stepId: string, output: unknown): Promise<Checkpoint>;
  findByExecutionAndStep(executionId: number, stepId: string): Promise<Checkpoint | null>;
}

// src/core/tx.ts
export interface CoreRepos {
  executions: ExecutionsRepo;
  checkpoints: CheckpointsRepo;
}
export function withTransaction<T>(
  pool: Pool,
  fn: (repos: CoreRepos) => Promise<T>,
): Promise<T>;

// src/engine/index.ts
export function claimExecution(
  repos: CoreRepos,
  workerId: string,
  opts?: { leaseSeconds?: number },
): Promise<Execution | null>;

export function completeExecution(
  repos: CoreRepos,
  params: { executionId: number; stepId: string; output: unknown },
): Promise<Checkpoint>;
```

### Data flow

A caller (in this package, a test; later, `apps/worker`) does:

```ts
await withTransaction(pool, async (repos) => {
  const exec = await claimExecution(repos, workerId);
  if (!exec) return;
  // future packages (session/, scheduler/) interleave their own writes
  // here, using the SAME `repos`'/transaction's client, per ADR-0002.
  const output = await runStep(exec);
  await completeExecution(repos, { executionId: exec.id, stepId: "the-step", output });
});
```

`claim()` itself remains a single SQL round-trip (`SELECT ... FOR UPDATE
SKIP LOCKED` then `UPDATE ... RETURNING`, wrapped in the `claim_execution()`
PL/pgSQL function, ported near-verbatim from spike 1.2) so the no-sweeper,
no-broker dispatch property carries over unchanged.

### Sequencing rationale

- **Why now:** every other still-open `tasks.md` item that touches
  `core/` or `engine/` (3.1 session log, 4.1 placement, 6.2 interpreter,
  6.9 map children) depends on `core/`'s `withTransaction`/repos shape and
  `engine/`'s claim/complete primitives existing first. Nothing currently
  committed to the repo exists to build on (no `package.json`, no `src/`) -
  confirmed by direct inspection before scoping this package.
- **What it depends on:** spike 1.2's `schema.sql`/`worker.js` (already
  crash/contention/load-tested, `archive/spikes/1.2-resonate-pg-durable-exec/`)
  as the reference implementation to promote-by-rewrite (ADR-0001 decision
  5 - not a verbatim port); ADR-0001/0002/0007/0009/0010 for the target
  shape and tooling.
- **What it unblocks:** 6.2 (generic interpreter, needs `claimExecution`/
  `completeExecution` to build a dispatch loop on), 3.1 (session log,
  needs `core/`'s `withTransaction` to add its own tables/repos into the
  same schema), 4.1 (placement, same), and eventually `apps/worker`.
- **What it deliberately does NOT unblock yet:** anything requiring durable
  sleep (a long-running human-in-the-loop wait) - that's 6.1b.

## Test design

Not collapsed with Phase 1 (see above) - this package is
foundational/consolidation-critical.

### Setup: default Vitest + testcontainers-node is sufficient

Every test below is the same class of test spike 1.2 already ran
successfully against a real, ephemeral Postgres instance (crash via
`pg_terminate_backend`, N-worker contention via `SELECT ... FOR UPDATE
SKIP LOCKED`) - this package is re-implementing already-proven behavior as
committed code, not exploring new correctness territory. No new stakes
(no new concurrency shape, no new scale claim) are introduced here that
would justify going beyond ADR-0009's default setup:

- **No dedicated load/scale test.** Spike 1.2e already closed the
  operational-weight/scale question at the design level (6,000
  executions/60 sessions/32 workers, no showstopper). This package doesn't
  reopen that claim - TC-2/TC-3 below use small worker/row counts (8-40,
  matching spike 1.2's own contention test scale) purely to exercise the
  *correctness* property (no double-claim, no cross-contamination), not to
  re-litigate scale.
- **testcontainers-node**, not a shared/manual Postgres, for every test
  that touches real transaction/lock semantics (TC-1 through TC-7) - exactly
  the class of behavior ADR-0009 names as requiring a real instance.
- TC-8 (logger) needs no Postgres at all - plain Vitest unit test.

### Test cases

| # | Test | Scope item | Correctness property verified |
|---|---|---|---|
| TC-1 | Apply `schema.sql` fresh; assert `executions`/`checkpoints` tables, the `status` CHECK constraint, the `UNIQUE(execution_id, step_id)` constraint, and the `claim_execution()` function all exist as expected | `core/schema.sql` | ADR-0002 (core owns the consolidated schema) - structural precondition for every test below |
| TC-2 | Seed N queued executions; run `claimExecution` concurrently from M workers (M ≥ N); assert each execution is claimed by exactly one worker and no execution is claimed twice | `ExecutionsRepo.claim` / `engine.claimExecution` | design.md D6 "THE PATTERN" - `SKIP LOCKED` is the entire dispatcher, no broker/leader election; R10 (distributed, load-balanced workers) |
| TC-3 | Claim an execution, commit that claim alone (no completion), let its lease expire, then claim again from a second worker; assert the second worker successfully reclaims it and no duplicate checkpoint results | `ExecutionsRepo.claim` | design.md R7 (native retries via lease-expiry sweep-less reclaim) - the genuinely distinct "committed claim, dead worker" failure shape, kept separate from TC-4's failure shape per design.md's own framing |
| TC-4 | Claim an execution inside `withTransaction`, write a checkpoint, then `pg_terminate_backend` the connection before COMMIT (mirroring spike 1.2's crash test hook); assert the execution reverts all the way to `queued` (not stuck `running`) and a subsequent claimant can immediately reclaim it with no partial checkpoint visible | `engine.claimExecution` + `completeExecution` composed inside `core.withTransaction` | design.md D6/R6 (durable execution, ADR-0002's DEEP-atomicity claim) - mid-transaction crash rolls back the claim itself, immediate recovery, no lease wait needed |
| TC-5 | Call `completeExecution` twice with the same `{executionId, stepId}` (simulating a retried completion after e.g. a dropped connection after COMMIT but before the caller observed success); assert exactly one `checkpoints` row exists and the execution stays `done` with no error surfaced | `CheckpointsRepo.insert`, `engine.completeExecution` | design.md D6/R7 "Postgres enforces exactly-once, not application code" via `UNIQUE(execution_id, step_id)` |
| TC-6 | Inside one `withTransaction(fn)` call, write via `executions` (claim) and a second, independent write via `checkpoints`, then throw before returning; assert neither write is visible after rollback | `core.withTransaction` | ADR-0002's atomicity guarantee, generalized beyond claim/complete's own use of it - matters because `session/`/`scheduler/` will later add their *own* writes into this same `fn` |
| TC-7 | Inside `withTransaction(fn)`, call `claimExecution`, then issue an ad hoc raw write on the same transaction's client (standing in for a future `session/`/`scheduler/` write), then `completeExecution`; kill the connection before COMMIT and assert all three writes roll back together; on a normal run, assert all three commit together | `engine.claimExecution`/`completeExecution` as composable primitives (not a hardcoded `processOneExecution`) | ADR-0002/ADR-0007 - "so `session/`, `scheduler/`, and `dataset-catalog/` can interleave their own writes on the same transaction" - proves the *shape* supports composition now, even with no real third consumer yet |
| TC-8 | Import the shared logger; assert it is a `pino` instance and that its redact config matches at least one known secret-shaped field name (e.g. `secret`, `token`) | `src/logger.ts` | ADR-0009 (pino + redact) - scaffolding smoke test, no testcontainers needed |

`ExecutionsRepo.enqueue` has no dedicated test case - it is exercised as
fixture setup inside TC-2 through TC-7 (seeding queued executions), which
is sufficient given it is a straightforward insert with no branching logic
of its own.

## Implementation notes

_(pending Phase 3)_

## Review notes

_(pending Phase 4)_
