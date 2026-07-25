# Task 1.10 - Placement resolver, formalized (bespoke-resolver option)

This directory is the deliverable for **task 1.10**: formalizing the
placement-resolver mechanism. Of the three options 1.10 lists (bespoke resolver,
service-mesh consistent-hash policy, native engine primitive), the engine
decision (task 1.4/1.4a, design.md D6/D6a) is **locked to a Postgres-native,
clean-room implementation of THE PATTERN**. That makes the **bespoke resolver**
the natural choice, and — exactly as 1.10 predicted — it is not a from-scratch
design: it is spike 1.2's minimal `placement` table
(`content_hash -> replica_id`, upserted in the same transaction as the
durability core + session log) grown up into the D4a cache-admission model.

This is a working, tested module against a real Postgres, not a paper design.

## Files

- `schema.sql` — the formalized `placement` schema (own `placement` Postgres
  schema), plus `placement_config` (tunable parameters as DATA) and a
  `placement_access` rolling-window event log.
- `src/resolver.js` — the resolver module (read path, write path, decision
  functions, action functions, capacity eviction, trust gate).
- `src/db.js` — test connection helper + `resetSchema`.
- `test/run.js` — the test suite (30 assertions, all passing against real PG).
- `package.json` — `pg` dependency, `npm test`.

## What extends spike 1.2, and why

Spike 1.2's table was `(content_hash PK, replica_id, session_id, updated_at)`.
The formalized table keeps all of that and adds exactly the fields D4a's model
needs, nothing speculative:

| Field | Purpose (design.md ref) |
|---|---|
| `pinned`, `pinned_at` | unpinned vs pinned residency state (D4a) |
| `interactivity` | workflow-writer declared intent, `interactive`/`batch` (D4) |
| `access_count`, `first/last_accessed_at` | cumulative recency/frequency stat (D4a) |
| `declared_cost_class` | D5 materialization-cost class, used as a **prior** (D4a) |
| `observed_rehydration_ms`, `observed_sample_count` | observed rolling average (D4a) |
| `size_bytes` | capacity-aware LRU eviction (D4a) |

Two columns became clarifying **relaxations** of the spike's constraints:

- `replica_id` is now **NULLABLE** (spike had NOT NULL). A hash can be tracked
  for admission before a replica is bound, and an evicted/demoted entry can
  retain its fact with no live replica. This is what lets a resolver "miss" be
  a first-class, non-error outcome (D4: "affinity is always an optimization").
- `session_id` stays NULLABLE because static/shared/immutable bindings
  (D4 `scope=static`) are not session-scoped.

## Judgment calls (the actual design decisions)

### 1. Tunable parameters modeled as DATA, both in SQL and JS

D4a is explicit that every threshold is a *starting default exposed as a
tunable scheduler parameter, not a hardcoded constant*. Implemented **both**
ways so 4.5 can pick either:

- `placement_config` table holds named JSONB profiles; the seeded `default`
  row carries D4a's starting defaults verbatim (7-min promotion window, 250ms
  cost threshold, 20-min demotion idle, 1 GiB pinned budget, 5-sample cost
  cutover). Tunable by `UPDATE`, no code change.
- Every decision/action function takes a `config` object argument;
  `loadConfig(exec, name)` reads a profile into one. Callers may override
  in-memory. Nothing is compiled into SQL or JS as an unchangeable literal.

### 2. "Estimated vs observed" cost — an explicit authority rule

D4a: use the declared cost-class as a *prior* before empirical data exists,
then switch to an observed rolling average once enough samples are collected.
Modeled as two separate inputs with one deciding function,
`effectiveRehydrationCostMs(row, config)`:

- **Observed wins** iff `observed_sample_count >= cost.observedMinSamples`
  (default 5) — the observed rolling average is authoritative.
- Otherwise fall back to `classPriorsMs[declared_cost_class]`.
- If neither exists, cost is `null` → promotion's cost gate cannot pass (fail
  safe: we do not pin something whose cost we can't justify).

The rolling average is an **incremental mean** maintained inside `recordAccess`'
upsert: `new_avg = (old_avg*n + sample)/(n+1)`. **Simplification noted:** D4a
says "per service + size-bucket"; this module keys the average per
`content_hash`. Aggregating to service+size-bucket is a straightforward
`GROUP BY` layer on top and is left for 4.4/4.5 — the per-hash column already
gives them the sampled input.

### 3. Windowed frequency needs an event log, not just a counter

A cumulative `access_count` cannot answer ">= 3 accesses within a 5-10 minute
rolling window". So `recordAccess` also appends to `placement_access`
(one row per access) and `evaluatePromotion` counts rows inside the window.
`recordAccess` prunes events older than the configured window to keep it
bounded. `access_count` is retained as a cheap lifetime stat and for debugging.

### 4. Decision / action separation (no side effects from evaluating)

`evaluatePromotion` / `evaluateDemotion` are reads that return a decision
object (`{promote|demote, reason, detail}`) and **never mutate residency**.
`promote()` / `demote()` are the explicit state-mutating actions. Tests assert
that evaluating does not flip `pinned`. This keeps the scheduler (4.4-4.6) free
to log/aggregate/override a decision before acting.

### 5. Hysteresis is structural, not incidental

Promotion looks at a *frequency window* (default 7 min); demotion looks at an
*idle threshold* (default 20 min). Because they are different parameters over
different signals, "promote-quick, demote-slow" is enforced by construction.
The test demonstrates the concrete gap: a binding idle 10 min (past the 7-min
promotion window, below the 20-min demotion threshold) is **not** demoted;
at 25 min it is.

### 6. Eviction unpins, it does not delete — and is trust-independent

`evictLRUIfOverCapacity` scans **only the pinned set**, ordered LRU by
`last_accessed_at`, and unpins entries until the pinned total is within budget.
Two deliberate choices:

- **Unpin, don't delete.** The placement *fact* (and its access history)
  survives eviction, so a later access can re-promote it and `resolvePlacement`
  can still report a now-cold fact. Deleting would throw away the frequency
  signal.
- **Scoped to pinned only.** Unpinned rows are never touched even if larger or
  older — the test seeds an unpinned entry that is the oldest of all and
  confirms it survives while the LRU *pinned* entry is evicted.
- **Independent of trust tier.** Eviction is capacity management of the pool's
  own memory. Trust gating (D5a/4.7) governs whether a warm replica may be
  *shared/reused*, which is a different question from whether the pool may
  reclaim space. Keeping these orthogonal avoids a subtle bug where a
  low-trust-but-pinned entry would distort the budget accounting.

### 7. Trust is consulted, never enforced here

Per D5a the scheduler must **never** lean on sharing/pooling/COW-reuse below
`production-proven`. But that is the *caller's* policy (4.7), not the resolver's
job — the resolver returns facts. So:

- `isTrustEligibleForOptimization(trustTier)` returns `true` only for
  `production-proven`. It is exported and one import away, but **not called
  internally** — the resolver never gates its own reads on it.
- `getPlacementFactsStub` documents the intended source of the trust tier: the
  registry's `getPlacementFacts(digest, function)` (task 2.8), which returns
  capability metadata + trust tier + hardware requirements atomically. The stub
  throws with a clear message so a real wiring is obvious; the trust tier is an
  **input the caller supplies**, keeping this module usable/testable standalone.
  (registry/ did not exist at build time; if it does later, replace the stub
  with a real import.)

The contract for 4.7: `resolvePlacement` tells you *there is a warm replica*;
before you actually **share/pool/reuse** it, call
`isTrustEligibleForOptimization(tier)` where `tier` came from the registry. Miss
that check and you get a correctness bug, so the interface is shaped to make the
check the obvious next step rather than easy to skip.

## Why this makes 4.4-4.7 materially faster (1.10's own success criterion)

- **4.4 (adaptive residency promotion by observed size/frequency)** — the
  size/frequency signals (`size_bytes`, `placement_access`, windowed count) and
  the promotion decision already exist; 4.4 is now "call `evaluatePromotion`
  then `promote` on the scheduler's cadence."
- **4.5 (promotion/demotion thresholds as tunable parameters)** — done as data:
  `placement_config` + the `config` argument. 4.5 is picking a source of truth
  and a reload strategy, not building the mechanism.
- **4.6 (capacity-aware LRU eviction among pinned entries)** —
  `evictLRUIfOverCapacity` is implemented and tested; 4.6 is scheduling when to
  run it and wiring the budget from autoscaling capacity planning.
- **4.7 (trust-tier gating, never share/pool/COW below production-proven)** —
  `isTrustEligibleForOptimization` + the documented caller contract give 4.7 a
  ready gate; 4.7's remaining work is fetching the tier from the registry (2.5/
  2.8) and placing the check at the share/pool/reuse call sites.
- **4.1/4.2/4.3** — `resolvePlacement`'s miss-is-not-an-error contract is
  exactly the affinity-hint-with-rehydrate-anywhere fallback 4.3 needs, over a
  table 4.1/4.2 can read for the fused decision.

## Transaction discipline (the DEEP-consolidation property)

Every write function takes a caller-owned `exec` (pg Client or Pool) and never
opens its own connection or issues BEGIN/COMMIT. `recordAccess` is specifically
built to run **inside the same transaction** as a session-log / durability-core
write — the property spike 1.2 demonstrated survives a mid-transaction crash.
The promotion test exercises this by recording three accesses inside one
explicit `BEGIN...COMMIT` on a caller-held client.

## Test evidence

`node test/run.js` against a real Postgres 16 (throwaway Docker container on
port 55544, stopped after the run): **30 assertions, 0 failures.** Covered:

- `resolvePlacement` on a never-seen hash → `{found:false, warm:false,
  reason:"no-placement"}`, no throw.
- interactive + `expensive` declared cost + 3 accesses in-window →
  `evaluatePromotion.promote === true`; evaluating does not mutate; `promote()`
  pins.
- `batch` binding at 6 accesses (2x threshold) → never promotes,
  reason `not-interactive`.
- hysteresis: idle 10 min (past 7-min promotion window, below 20-min demotion
  threshold) → not demoted; idle 25 min → demoted.
- capacity: 3 pinned (100B each) + 1 unpinned over a 250B budget → exactly the
  LRU pinned entry unpinned, its fact survives, more-recent pinned + the
  unpinned entry untouched, second run is a no-op.
- trust gate: only `production-proven` is eligible.
