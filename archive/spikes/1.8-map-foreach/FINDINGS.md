# Spike 1.8 — Dynamic map/forEach construct on the Postgres-native engine

**Task**: tasks.md 1.8. Spike a dynamic `map`/`forEach` construct against the
execution engine selected in 1.4 — the Postgres-native "THE PATTERN" (design.md
D6), first spiked in `spikes/1.2-resonate-pg-durable-exec/`. The question this
spike answers: do design.md D8's `map`/`forEach` requirements — **static body
shape, dynamic (runtime-sized) cardinality, independent per-child retry,
parent-non-blocking fan-out, and an original-order join** — actually hold when
expressed on that pattern, demonstrated against a real Postgres instance, or
only on paper?

The relevant design decisions under test:

- **D8 (line 583)**: "A map/forEach construct statically declares the shape of
  a single iteration ...; only the iteration count is resolved at run time,
  from a runtime-sized collection. Each iteration executes as an independently
  tracked, durable unit (see D9), so partial failure only re-runs the failed
  iteration."
- **D8c (line 735)**: `{ from: step, id: <mapId>, output: <name> }` resolves to
  "the array of per-iteration values ... regardless of ... what order they're
  declared" — i.e. **parallel arrays in original source order**, not completion
  order.
- **D9 (line 770) / task 6.9**: the child/step-execution primitive lets a
  running workflow "start one or many additional tracked executions, including
  dynamically and in a loop, **without the parent terminating**, with each
  getting its own durable tracking, retries ...".

## What was built

This spike does **not** re-derive the durability core; it **extends** spike
1.2's exact pattern (an `executions` table, `SELECT ... FOR UPDATE SKIP LOCKED`
claiming via an identical `claim_execution()` PL/pgSQL function, a
`UNIQUE(execution_id, step_id)` `checkpoints` table for exactly-once step
completion, same `spike` schema / `pg` / Node conventions). Files:

- `schema.sql` — the 1.2 core, plus:
  - three nullable columns on `executions`: `kind ('map'|'step')`,
    `parent_execution_id` (self-FK), `map_index` (position in source), and a
    test-only `fail_remaining` transient-failure injector.
  - `map_nodes (execution_id PK, total_children, completed_children, source)` —
    per-map bookkeeping created atomically with its children.
  - `map_results (execution_id PK, yields JSONB)` — the joined parallel arrays.
- `src/worker.js` — one generic `processOne(pool, workerId)` that claims **one**
  queued execution from the shared queue and dispatches on `kind`/state:
  fan-out, ordinary step, or join. Plus a `workerLoop` for pool-based draining.
- `src/test-map-foreach.js` — four scenarios, 19 assertions, exit 0 only if all
  hold. `src/seed.js` for manual poking. `package.json` (`npm test`).

### Key design choice: a child is *literally another `executions` row*

Per D9's "each getting its own durable tracking, retries", child iterations
**reuse the `executions` table** rather than living in a separate `map_children`
table. This was deliberate and is the crux of the spike: because a child is
just another row with `status='queued'`, it is claimed, leased, retried,
checkpointed and (would be) lease-swept by the **exact same machinery** as any
other execution — including the identical `claim_execution()` function, which
cannot even tell a map child apart from a standalone step. A separate children
table would have forced a parallel, near-duplicate claim/lease/retry path and
quietly undercut the very "a child is just another execution" property D9
asserts. The map/child linkage is therefore only two nullable columns; a small
`map_nodes` companion table holds the runtime cardinality and an O(1)
completion counter.

### The map node's lifecycle across *multiple independent claims*

A `map` node is never held open across its children. Its life is three separate
claims by (potentially) three different workers:

1. **Fan-out** (first claim, no `map_nodes` row yet): in one transaction,
   insert N child rows + the `map_nodes` row, then park the parent in a new
   `status='awaiting_children'` — which `claim_execution()` does **not** select,
   so the parent immediately releases its worker and is not re-claimable.
2. **(children processed independently, concurrently, by any workers)**
3. **Join** (parent re-queued to `'queued'` by whichever child commits last):
   collect children's checkpoint outputs `ORDER BY map_index` into parallel
   arrays, write `map_results`, checkpoint the join step, mark the map `done`.

Exactly-once "last child detection" uses `UPDATE map_nodes SET
completed_children = completed_children + 1 ... RETURNING` under the row lock, so
precisely one child observes `completed_children == total_children` and re-queues
the parent — no double-join, no lost join.

## Results

All 19 assertions pass, reliably (re-run 4×, including the genuinely concurrent
scenarios), against a real Postgres 16 instance (Docker, `:55433`).

### 1. Fan-out — runtime-sized cardinality, statically-shaped body

A `map` over an array of **N=12** items, claimed once, produced **exactly 12**
child `executions` rows, all independently claimable (`status='queued'`), with
the parent parked in `awaiting_children` holding **no** worker/lease and
`map_nodes.total_children = 12`. The body shape (the `enrichOne` step) is fixed
in code (static, compile-time-known); only the count N came from the runtime
`input.source` array — exactly D8's "static body shape, dynamic cardinality"
split.

### 2. Independent per-child retry

One child (source index 5) was seeded to fail once. Under a 4-worker pool: it
suffered **exactly one** injected failure (at index 5, not elsewhere) and then
succeeded; **all 12** children ended `done`; **no child had a duplicate
checkpoint** (no double side-effect); the failing child ended at `attempts=2`
while **every other child was at exactly `attempts=1`** — i.e. untouched by its
neighbour's failure; and the join came out complete and correct despite the
retry. Partial failure re-ran **only** the failed iteration, as D8 requires.

A modelling note that matters for honesty (see caveats): an injected transient
failure is committed as a **failed attempt** (decrement owed-failures + requeue,
no checkpoint, in one transaction), *not* as a bare rollback. A bare rollback —
the shape spike 1.2's crash Scenario 1 uses — would revert the in-transaction
`claim_execution()` attempt increment too, so `attempts` would never reach 2 and
the injection could race (multiple workers re-claiming the still-owed-failure
row before a post-rollback decrement lands). Committing the failed attempt is
both race-free (SKIP LOCKED gives a single claimant; the decrement is durable)
and the realistic shape for an application-level transient error that wants its
retry counted. Real *crash* recovery (rollback / lease-sweep) is unchanged from
1.2 and out of scope here.

### 3. Parent non-blocking — shared pool, interleaved with unrelated work

A map over 12 items was queued alongside **10 unrelated standalone** step
executions in the same queue, drained by a single 4-worker pool. All 10
standalone executions completed, all 12 children completed, and the map reached
`done` via a **separate** join claim. Crucially, at least one worker was
observed processing **both** a map child **and** a standalone execution — direct
evidence that no worker sat blocked "babysitting" the whole map synchronously.
The parent held a worker slot only for the (fast, single-transaction) fan-out
and join claims, never across the children's processing.

### 4. Ordered join under genuinely out-of-order completion

A map over **N=15** non-monotonic values, drained by **6 workers** with real
per-child random jitter (0–40ms), so children genuinely commit out of source
order — one observed true wall-clock completion order was
`[0,2,1,5,4,9,8,7,10,3,11,12,14,6,13]`. The joined `enriched` array nonetheless
came out **length 15, in original source order** (`source[i]*2` at position i),
matching D8c's "regardless of ... what order". Completion order is captured in
application code, not by `ORDER BY committed_at` — the latter is contaminated by
same-millisecond ties (an earlier version of this test fabricated a spuriously
"sorted" completion order that way, which is why the check now records true
commit order in the worker).

## Verdict

**D8's `map`/`forEach` requirements hold on the Postgres-native pattern selected
in 1.4, demonstrated (not merely asserted) against a real Postgres instance.**
Specifically:

- **Static body shape + dynamic cardinality** — the iteration body is fixed in
  code; N is resolved at fan-out time from the runtime source array and frozen
  in `map_nodes.total_children`. ✔ (Scenario 1)
- **Independent, durable per-child tracking + per-child retry** — each child is
  literally another `executions` row, claimed/retried by the identical
  `claim_execution()`; a single child's failure re-ran only that child, with no
  duplicate side-effect and no effect on any sibling or the join. ✔ (Scenario 2)
- **Parent-non-blocking fan-out** — the parent parks in `awaiting_children`
  holding no worker; children and unrelated executions are drained, interleaved,
  by one shared pool; the join is a separate claim. ✔ (Scenario 3)
- **Ordered join** — parallel arrays indexed by original `map_index`, correct
  under genuinely out-of-order concurrent completion. ✔ (Scenario 4)

The child/step-execution primitive D9 posits as "the general mechanism behind
D8's map construct" is, on this engine, **not a new mechanism at all** — it is
the same executions-table + SKIP-LOCKED-claim + checkpoint pattern applied to a
row whose only distinguishing marks are a `parent_execution_id` and a
`map_index`. That is the strongest form of the D8/D9 claim: fan-out is
expressible without any bespoke fan-out engine.

## Caveats / what this spike does NOT settle

- **Injected failure ≠ crash recovery.** Scenario 2 models a *committed failed
  attempt* (application-level transient error with a counted retry), chosen so
  the injection is race-free and `attempts` persists. It does **not** re-test
  the mid-transaction-crash or lease-expiry-sweep recovery of an in-flight
  child — those recovery shapes were established in spike 1.2 and are inherited
  here unchanged (a child is an ordinary execution), but this spike did not
  re-exercise `pg_terminate_backend` mid-child or a lease sweep of a child.
- **`yields` is exercised structurally, not semantically.** The join collects a
  single yielded field (`enriched`) into one parallel array. The multi-field
  `yields` case (D8c's `enrichedRecord` + `wasFlagged` parallel arrays) and the
  "≥2 steps in the body ⇒ yields required" rule are represented by a
  single-step body only; nested bodies (a `map` whose body contains a `branch`
  or another `map`, D8d's unrestricted nesting) were not built.
- **No lease/heartbeat for long-parked parents.** A map node in
  `awaiting_children` is re-queued only by its last child. If that final
  re-queue transaction were lost (it isn't, since it commits atomically with the
  last child's completion), there is no sweeper here that would notice a map
  stuck in `awaiting_children` with all children done. A production build would
  want a periodic "all children done but parent not re-queued" reconciliation as
  defence-in-depth; this spike relies solely on the atomic last-child re-queue.
- **The completion-counter path serializes per-parent at the final commit.**
  `UPDATE map_nodes ... completed_children + 1` under the row lock briefly
  serializes children of the *same* map at their completion boundary (not during
  their processing). This is correct and cheap at N=12–15; it was not load-tested
  at large fan-out widths where that single counter row could become a hot spot.
  An alternative (a `COUNT(*) WHERE parent=... AND status='done'` guarded by a
  join checkpoint) would trade the hot row for a heavier count query; not
  evaluated here.
- **Scale/throughput unmeasured.** As with spike 1.2: ≤6 workers, ≤15 children,
  no vacuum/bloat or connection-ceiling testing. This validates *mechanics and
  correctness*, not a fan-out width or throughput ceiling.
- **Ordering of the join input relies on `map_index`, not `committed_at`.** The
  spike deliberately joins `ORDER BY map_index` (durable, assigned at fan-out).
  It explicitly does **not** and must not order by completion/commit time —
  Scenario 4's earlier bug (a spuriously sorted `ORDER BY committed_at`) is a
  reminder that commit-time is not a safe ordering key.

## How to reproduce

`npm test` is fully self-contained - it starts its own throwaway Postgres
container (via `../../scripts/with-postgres.sh`), waits for real readiness,
applies `schema.sql`, runs the suite, and tears the container down
afterward (pass or fail). No manual `docker run` step is required or
implied by anything below:

```bash
npm install
npm test          # 19 assertions across 4 scenarios; exit 0 iff all hold
```

If Docker isn't available, or the container never becomes ready, this
fails loudly (non-zero exit, clear error) rather than skipping the
database-dependent assertions.
