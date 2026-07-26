# 0005: Placement - `core/`'s placement schema + `scheduler/`'s decision logic

## Status

`reviewed`

## Scope

This package promotes `archive/placement-resolver/` (task 1.10's already-
completed design/spike deliverable) into real, committed code following
this repo's current conventions (ADR-0002/0007/0012) - it is the one
promotion ADR-0007 names explicitly ("the one non-trivial promotion:
`archive/placement-resolver/` splits") and has not happened yet: nothing
under `src/` today owns a `placement` table or any placement decision
logic.

**New task item covered (added to `tasks.md` by this package, mirroring
how 6.1 was split into 6.1a/6.1b):**

- **4.1a NEW (split from 1.10/4.1-4.7):** Promote `archive/placement-
  resolver/`'s schema (`placement`, `placement_config`, `placement_access`)
  into `core/`'s consolidated schema (ADR-0002), and its decision/action
  logic (`resolvePlacement`, `recordAccess`, `evaluatePromotion`,
  `evaluateDemotion`, `promote`, `demote`, `evictLRUIfOverCapacity`,
  `effectiveRehydrationCostMs`, `isTrustEligibleForOptimization`) into a
  new top-level `scheduler/` module (ADR-0007), operating over `core/`'s
  placement repositories rather than owning any table itself.

**What this package does NOT close out, and leaves `[ ]` on purpose:**

- **4.1** (fuse capability metadata + DSL intent + runtime observations)
  and **4.2/4.3** (shared read-only path, affinity hinting) - this package
  builds the *mechanism* `resolvePlacement`/`recordAccess` are (the
  "runtime observation" leg), but there is no `registry/` client (capability
  metadata) or `dsl-compiler/`/`workflow-spec/`-derived intent feeding it yet, so
  nothing actually calls `scheduler/` end to end. 4.1-4.3 stay open until a
  real caller (a future `apps/worker` or an interim wiring package) exists.
- **4.4** (adaptive promotion) and **4.6** (LRU eviction) - `evaluatePromotion`/
  `promote`/`evictLRUIfOverCapacity` are implemented and tested here, but
  4.4/4.6 as written also imply a scheduling cadence (something calling
  these periodically) that doesn't exist without `apps/worker`. Left open,
  annotated with a pointer to this package as the now-ready mechanism -
  mirrors `archive/placement-resolver/FINDINGS.md`'s own framing ("4.4 is
  now 'call `evaluatePromotion` then `promote` on the scheduler's cadence'").
- **4.5** (thresholds as tunable scheduler parameters) - `placement_config`
  (data) + every decision function's `config` parameter are both
  implemented here; 4.5's own remaining text ("picking a source of truth
  and a reload strategy") is left open since there is still only ever one
  named profile (`'default'`) and no reload path beyond a fresh `load()`
  call per invocation.
- **4.7** (trust-tier gating) - `isTrustEligibleForOptimization` is
  promoted here exactly as archived (a pure, un-wired gate function); the
  actual gating still needs `registry/`'s `getPlacementFacts` (task 2.8),
  which does not exist as a real module yet (see 0004's own Scope note
  that `registry/` promotion is a separate, not-yet-done package).

## Sources

- **ADR-0002** (`core/` owns the consolidated schema): explicitly lists
  `placement`, `placement_config`, `placement_access` among the tables
  `core/` owns, and states that `scheduler/` "receives a transaction... and
  never opens its own connection or owns any schema."
- **ADR-0007** (module inventory): names `scheduler/` as "placement
  decisions: fuses registry/'s `getPlacementFacts` + execution-plan-declared intent +
  `core/`'s placement repo observations (the PROMOTED DECISION LOGIC half
  of `archive/placement-resolver/`)" and gives the exact split this package
  implements - tables into `core/`, `resolvePlacement`/`recordAccess`/
  `evaluatePromotion`/`evaluateDemotion`/`evictLRUIfOverCapacity`/
  `isTrustEligibleForOptimization` into `scheduler/`, which "calls `core/`'s
  placement repository rather than owning any table itself."
- **ADR-0012** (module-internal structure/naming): the `database/`/
  `repositories/`/`repositories/queries/`/`domain/` shape for `core/`'s new
  tables; `scheduler/` gets the same top-level shape minus `database/`
  (it's a logic module with no schema of its own, per ADR-0002's diagram -
  same posture as `session/`'s existing precedent).
- **design.md D4/D4a** (placement fused from three sources; the
  cache-admission promotion/demotion model; capacity-aware LRU eviction;
  starting-default thresholds as tunable data, not hardcoded constants)
  and **D5a** (trust tiers gate optimization, never a correctness default) -
  the correctness properties `archive/placement-resolver/` already
  implements and tests; this package re-implements them as committed code
  in current conventions, the same relationship 0001 had to spike 1.2.
- **`archive/placement-resolver/`** (task 1.10's deliverable - `schema.sql`,
  `src/resolver.js`, `FINDINGS.md`, 30/30 passing assertions against a real
  Postgres instance): the actual starting point, promoted-by-rewrite (not a
  verbatim port, per ADR-0001 decision 5) into TypeScript/current
  conventions, exactly as 0001 did for spike 1.2 and 0004 did for
  `archive/dsl/schema/`.

**Open questions these sources leave unresolved, resolved here as a call
this package makes:**

- **Which functions are "repository" (thin data ops) vs. "decision logic"
  (`scheduler/`)?** ADR-0007's own text lists `resolvePlacement` and
  `recordAccess` - which read/write the `placement`/`placement_access`
  tables fairly directly - among the functions promoted into `scheduler/`,
  not `core/`. Resolved by following ADR-0007's list literally: `core/`
  gets three thin repositories (one per table: `placement`,
  `placement_config`, `placement_access`) exposing plain CRUD/count
  operations; `scheduler/` implements every one of the eight named
  functions by composing those three repositories - `scheduler/` owns *all*
  decision-shaped and read/write orchestration, `core/` owns only the
  per-table primitives, mirroring how `session/appendEntry` composes
  `repos.sessionLog`/`repos.sessionPointer` rather than either repo
  containing multi-step logic itself.
- **One `PlacementRepo` for all three tables, or three?** Resolved: three
  separate repositories (`placement.repository.ts`,
  `placement-config.repository.ts`, `placement-access.repository.ts`),
  matching ADR-0012's "one file per aggregate" rule and this repo's own
  existing precedent (`session_log`/`session_pointer` - two closely related
  tables - are already two separate repository files, not one).
- **Does `core/`'s schema keep the archived `placement` dedicated SQL
  *namespace* (`CREATE SCHEMA placement`)?** No - same call 0001 already
  made for the durability core against spike 1.2's `spike` namespace: the
  archived isolation concern doesn't apply once `registry/`/`workflow-store/`
  have their own separate *databases* (ADR-0006) and there's no other
  Postgres-schema-level name collision risk. All three tables go into the
  default `public` schema alongside `executions`/`waits`/`session_log`.
- **Where does the TypeScript-side `PlacementConfig` type/shape live -
  `core/domain/` (it's a row-mapped table shape) or `scheduler/` (it's the
  decision logic's own input)?** Resolved: the row shape/mapped domain type
  (`PlacementConfig`) lives in `core/domain/` (mirrors every other
  row<->domain type in this codebase); the TypeScript-side *fallback*
  default (`DEFAULT_PLACEMENT_CONFIG`, mirroring the seeded SQL row, same
  "kept in sync by hand" posture as `core/constants.ts`'s
  `DEFAULT_LEASE_SECONDS`) lives in `scheduler/constants.ts`, since it's
  the decision logic's own fallback-when-no-profile-row-exists behavior,
  not a `core/` concern.

## Plan

### File/module layout

```
src/core/
  database/
    schema.sql                          (extended) placement, placement_config,
                                         placement_access tables (promoted from
                                         archive/placement-resolver/schema.sql,
                                         public schema, no dedicated SQL namespace)
  domain/
    placement.ts                        (new) Placement domain type
    placement-config.ts                 (new) PlacementConfig domain type
    rows.ts                             (extended) PlacementRow, PlacementConfigRow
    mappers.ts                          (extended) mapPlacementRow, mapPlacementConfigRow
    index.ts                            (extended barrel)
  repositories/
    placement.repository.ts             (new) PlacementRepo: findByContentHash,
                                         upsertAccess, setPinned, listPinnedOrderedByLru
    placement-config.repository.ts      (new) PlacementConfigRepo: load(name)
    placement-access.repository.ts      (new) PlacementAccessRepo: record,
                                         countWithinWindow, pruneOlderThan
    queries/
      placement.queries.ts              (new) SQL_* constants
      placement-config.queries.ts       (new)
      placement-access.queries.ts       (new)
  database/transactions.ts              (extended) CoreRepos gains placement,
                                         placementConfig, placementAccess
  constants.ts                          (extended) DEFAULT_PLACEMENT_ACCESS_PRUNE_HORIZON_MS?
                                         - see Open questions; likely unneeded, see below
  index.ts                              (extended barrel)

src/scheduler/                          (NEW top-level module - ADR-0007)
  index.ts                              (new) barrel
  constants.ts                          (new) DEFAULT_PLACEMENT_CONFIG (TS-side mirror
                                         of the seeded SQL row, same posture as
                                         core/constants.ts's DEFAULT_LEASE_SECONDS)
  trust.ts                              (new) TRUST_TIERS, isTrustEligibleForOptimization
                                         (pure, no I/O)
  placement.ts                         (new) resolvePlacement, recordAccess,
                                         effectiveRehydrationCostMs (pure),
                                         evaluatePromotion, evaluateDemotion,
                                         promote, demote, evictLRUIfOverCapacity
                                         - all take a CoreRepos, mirroring
                                         session/session-log.ts's shape

test/
  core/database/schema.test.ts          (extended) placement/placement_config/
                                         placement_access structural assertions
  core/repositories/placement.repository.test.ts        (new)
  core/repositories/placement-config.repository.test.ts (new)
  core/repositories/placement-access.repository.test.ts (new)
  scheduler/placement.test.ts           (new) - ports archive's 30 assertions
  scheduler/trust.test.ts               (new)
```

### Interfaces (signatures)

```ts
// src/core/domain/placement.ts
export interface Placement {
  contentHash: string;
  replicaId: string | null;
  sessionId: string | null;
  pinned: boolean;
  pinnedAt: Date | null;
  interactivity: "interactive" | "batch";
  accessCount: number;
  firstAccessedAt: Date | null;
  lastAccessedAt: Date | null;
  declaredCostClass: "trivial" | "cheap" | "moderate" | "expensive" | null;
  observedRehydrationMs: number | null;
  observedSampleCount: number;
  sizeBytes: number;
  createdAt: Date;
  updatedAt: Date;
}

// src/core/domain/placement-config.ts
export interface PlacementConfig {
  promotion: {
    frequencyThreshold: number;
    frequencyWindowMs: number;
    rehydrationCostThresholdMs: number;
  };
  demotion: { idleThresholdMs: number };
  capacity: { pinnedBudgetBytes: number };
  cost: {
    observedMinSamples: number;
    classPriorsMs: Record<"trivial" | "cheap" | "moderate" | "expensive", number>;
  };
}

// src/core/repositories/placement.repository.ts
export interface PlacementRepo {
  findByContentHash(contentHash: string): Promise<Placement | null>;
  // The upsert half of the archived recordAccess: inserts a first-seen row
  // or updates access bookkeeping + the incremental rehydration-cost mean
  // on conflict. Does NOT touch placement_access - that's
  // PlacementAccessRepo.record's job; scheduler.recordAccess composes both.
  upsertAccess(input: {
    contentHash: string;
    replicaId?: string | null;
    sessionId?: string | null;
    interactivity?: "interactive" | "batch" | null;
    sizeBytes?: number | null;
    declaredCostClass?: Placement["declaredCostClass"];
    observedRehydrationMs?: number | null;
    at?: Date;
  }): Promise<Placement>;
  setPinned(contentHash: string, pinned: boolean): Promise<Placement>;
  listPinnedOrderedByLru(): Promise<Placement[]>;
}

// src/core/repositories/placement-config.repository.ts
export interface PlacementConfigRepo {
  load(name: string): Promise<PlacementConfig | null>;
}

// src/core/repositories/placement-access.repository.ts
export interface PlacementAccessRepo {
  record(contentHash: string, at?: Date): Promise<void>;
  countWithinWindow(contentHash: string, windowMs: number): Promise<number>;
  pruneOlderThan(contentHash: string, windowMs: number): Promise<void>;
}

// src/scheduler/trust.ts
export const TRUST_TIERS = {
  UNVERIFIED: "unverified",
  CONFORMANCE_PASSED: "conformance-passed",
  PRODUCTION_PROVEN: "production-proven",
} as const;
export type TrustTier = (typeof TRUST_TIERS)[keyof typeof TRUST_TIERS];
export function isTrustEligibleForOptimization(tier: TrustTier): boolean;

// src/scheduler/constants.ts
export const DEFAULT_PLACEMENT_CONFIG: PlacementConfig; // TS mirror of the
  // seeded SQL 'default' placement_config row - kept in sync by hand,
  // same posture as core/constants.ts's DEFAULT_LEASE_SECONDS.

// src/scheduler/placement.ts
export interface PlacementResolution {
  found: boolean;
  warm: boolean;
  contentHash: string;
  reason: "no-placement" | "warm-replica" | "cold-fact";
  placement?: Placement;
}
export function resolvePlacement(
  repos: CoreRepos,
  contentHash: string,
): Promise<PlacementResolution>;

export function recordAccess(
  repos: CoreRepos,
  contentHash: string,
  opts?: {
    replicaId?: string | null;
    sessionId?: string | null;
    interactivity?: "interactive" | "batch" | null;
    sizeBytes?: number | null;
    declaredCostClass?: Placement["declaredCostClass"];
    observedRehydrationMs?: number | null;
    at?: Date;
    config?: PlacementConfig;
  },
): Promise<Placement>;

export function effectiveRehydrationCostMs(
  placement: Placement,
  config: PlacementConfig,
): { costMs: number | null; source: "observed" | "declared-prior" | "unknown" };

export interface PromotionDecision {
  promote: boolean;
  reason: "no-placement" | "already-pinned" | "not-interactive" | "cost-below-threshold" | "frequency-below-threshold" | "qualifies";
  detail?: Record<string, unknown>;
}
export function evaluatePromotion(
  repos: CoreRepos,
  contentHash: string,
  config?: PlacementConfig,
): Promise<PromotionDecision>;

export interface DemotionDecision {
  demote: boolean;
  reason: "no-placement" | "not-pinned" | "idle-past-threshold" | "still-within-idle-threshold";
  detail?: Record<string, unknown>;
}
export function evaluateDemotion(
  repos: CoreRepos,
  contentHash: string,
  config?: PlacementConfig,
): Promise<DemotionDecision>;

export function promote(repos: CoreRepos, contentHash: string): Promise<Placement>;
export function demote(repos: CoreRepos, contentHash: string): Promise<Placement>;

export function evictLRUIfOverCapacity(
  repos: CoreRepos,
  config?: PlacementConfig,
): Promise<string[]>; // evicted content hashes, LRU-first
```

### Data flow

```ts
import { withTransaction } from "../core/index.js";
import { evaluatePromotion, promote, recordAccess, resolvePlacement } from "../scheduler/index.js";

await withTransaction(pool, async (repos) => {
  // 1. A future apps/worker records one access, in the SAME transaction as
  //    whatever else it's doing this step (a session-log write, a
  //    checkpoint write) - the DEEP-consolidation property design.md D6
  //    already demonstrated via spike 1.2, now exercised for placement too.
  await recordAccess(repos, contentHash, { sessionId, interactivity: "interactive" });

  // 2. Elsewhere (a future scheduling cadence, not built here - see Scope):
  const decision = await evaluatePromotion(repos, contentHash);
  if (decision.promote) await promote(repos, contentHash);

  // 3. A future dispatch path consults the read side before routing:
  const resolution = await resolvePlacement(repos, contentHash);
  // resolution.warm tells the caller whether to prefer resolution.placement.replicaId
  // or fall back to rehydrate-anywhere (D4) - a miss is never an error.
});
```

`effectiveRehydrationCostMs`/`isTrustEligibleForOptimization` are the two
pure, no-I/O functions (no `CoreRepos` parameter) - callable directly on an
already-fetched `Placement`/`TrustTier` value.

### Sequencing rationale

- **Why now:** completes the D6 four-way consolidation story 0001-0003
  already built three-quarters of (`executions`/`checkpoints`/`waits`
  durability, `session_log`/`session_pointer` session state) - `placement`
  is the fourth and last piece `core/schema.sql`'s own header comment
  already flags as deliberately excluded pending "a future scheduler/
  package." It is also the one promotion ADR-0007 names explicitly by
  path, with a fully worked, already-tested reference implementation
  (`archive/placement-resolver/`, 30/30 assertions) to promote-by-rewrite -
  the same low-risk, well-specified shape 0001-0004 each had.
- **What it depends on:** `core/`'s `withTransaction`/`CoreRepos` shape
  (0001, already built) - this package only adds new repos to an existing
  `CoreRepos` object, touching no existing repo's behavior. Nothing from
  `registry/` or `dsl-compiler/`/`workflow-spec/`'s eventual execution-plan-to-engine compilation
  is required - `scheduler/`'s functions take plain primitive inputs
  (`contentHash`, `interactivity`, trust tier) exactly as the archived
  module already did, deferring "where do these values come from" to
  whichever future package wires a real caller.
- **What it unblocks:** a real `registry/` promotion (task 2.x) and a real
  `apps/worker` can now wire trust-tier gating (4.7) and the fused
  placement decision (4.1-4.3) against a `scheduler/` that already exists,
  rather than needing to build the decision mechanism themselves; 4.4-4.6
  become "call `evaluatePromotion`/`evictLRUIfOverCapacity` on a cadence,"
  per the archived `FINDINGS.md`'s own claim, now true against committed
  code instead of an archived spike.
- **What it deliberately does NOT unblock yet:** any actual dispatch
  routing decision (6.3/6.4/6.15, which need the exec-agent, ADR-0008) or
  the registry-sourced trust tier/capability metadata that would let 4.7's
  gate actually be exercised end to end - both remain future packages.

## Test design

Not collapsed with Phase 1 - this package extends `core/`'s consolidated
schema (foundational, per 0001/0002/0003's own precedent) and re-implements
a correctness-bearing model (D4a's promotion/demotion hysteresis, D5a's
trust gate) as committed code for the first time.

### Setup: default Vitest + testcontainers-node is sufficient

Every behavior below (upsert-on-conflict bookkeeping, windowed-count
queries, LRU eviction ordering) depends on real Postgres semantics
(`ON CONFLICT`, real timestamp arithmetic for the windowed/idle checks) -
the same class of test spike 1.2/`archive/placement-resolver/` already ran
successfully against a real, ephemeral Postgres instance. No new
concurrency or scale claim is introduced (no crash test, no contention
test): unlike `executions`/`waits`, nothing here is claimed by concurrent
workers via `SKIP LOCKED` - `resolvePlacement`/`recordAccess` are ordinary
reads/upserts, and `archive/placement-resolver/FINDINGS.md` never claimed a
concurrency property beyond "recordAccess can share a transaction," which
TC-9 below re-verifies directly. No dedicated load/scale test - this
mirrors 0001's reasoning (spike 1.2e already closed the operational-weight
question at the design level; this package doesn't reopen it) and
`archive/placement-resolver/`'s own scope (its FINDINGS.md never claimed a
scale result either).

### Test cases

| # | Test | Scope item | Correctness property verified |
|---|---|---|---|
| TC-1 | Apply `schema.sql` fresh; assert `placement`/`placement_config`/`placement_access` tables, `placement`'s `interactivity`/`declared_cost_class` CHECK constraints, the pinned-LRU partial index, and the seeded `'default'` `placement_config` row all exist | 4.1a schema | ADR-0002 - structural precondition; D4a's starting defaults exist as seeded data, not hardcoded |
| TC-2 | `resolvePlacement` on a never-seen content hash returns `{found:false, warm:false, reason:"no-placement"}`, never throws | 4.1a `scheduler.resolvePlacement` | D4 - "a resolver miss is never an error," the affinity-is-always-an-optimization contract |
| TC-3 | `recordAccess` on a first-seen hash creates a row with `access_count=1`; a second `recordAccess` with a different `sizeBytes`/`declaredCostClass` updates those fields via `COALESCE` while leaving previously-set fields the second call didn't supply intact | 4.1a `PlacementRepo.upsertAccess` / `scheduler.recordAccess` | archived judgment call #1 (COALESCE-based partial-update upsert) |
| TC-4 | Three `recordAccess` calls inside one explicit transaction on the same content hash; `effectiveRehydrationCostMs` after enough samples reports `source: "observed"` with the correct incremental mean; before enough samples it reports `source: "declared-prior"` from `classPriorsMs`; with neither, `source: "unknown"` and `costMs: null` | 4.1a `scheduler.effectiveRehydrationCostMs` | D4a's declared-prior-until-enough-observed-samples authority rule |
| TC-5 | An `interactive` binding with an `expensive` declared cost and 3 accesses inside the promotion window: `evaluatePromotion` returns `{promote:true}`; calling it again does not itself flip `pinned` (a pure read); `promote()` then sets `pinned=true` | 4.1a `scheduler.evaluatePromotion`/`promote` | D4a's promotion gate (all three conditions ANDed); decision/action separation |
| TC-6 | A `batch`-declared binding with 6 accesses (2x the frequency threshold) never promotes, `reason: "not-interactive"` | 4.1a `scheduler.evaluatePromotion` | D4a - "never auto-promote a batch-scoped binding, regardless of frequency" |
| TC-7 | A pinned entry idle 10 minutes (past a 7-minute promotion window, below a 20-minute demotion threshold) is not demoted; the same entry idle 25 minutes is demoted | 4.1a `scheduler.evaluateDemotion` | D4a's hysteresis (promote-quick, demote-slow) - the concrete gap between the two thresholds |
| TC-8 | Seed 3 pinned entries (100 bytes each) plus 1 unpinned entry that is older/larger than all of them, over a 250-byte pinned budget: `evictLRUIfOverCapacity` unpins exactly the LRU pinned entry, leaves the unpinned entry and the more-recently-accessed pinned entries untouched, and a second call is a no-op | 4.1a `scheduler.evictLRUIfOverCapacity` | D4a - capacity-aware LRU eviction scoped to the pinned set only; eviction unpins (survives as a cold fact) rather than deleting |
| TC-9 | `recordAccess` called with a caller-held transaction client (via `withTransaction`), interleaved with an ordinary `executions`/`checkpoints` write on the SAME transaction, commits both together on success and rolls back both together if the transaction throws before commit | 4.1a `scheduler.recordAccess` composability | ADR-0002's DEEP-consolidation property, now exercised for `placement` specifically (spike 1.2 demonstrated it for `executions`/`checkpoints`/`session_log`; this is the fourth concern) |
| TC-10 | `isTrustEligibleForOptimization` returns `true` only for `"production-proven"`, `false` for `"unverified"`/`"conformance-passed"` | 4.1a `scheduler.isTrustEligibleForOptimization` | D5a - "the scheduler only leans on a capability declaration once a service build has reached PRODUCTION-PROVEN" |
| TC-11 | `PlacementConfigRepo.load("default")` returns the seeded row's values (matching `DEFAULT_PLACEMENT_CONFIG`'s own values field-for-field); `load("does-not-exist")` returns `null` (caller, i.e. `scheduler/`'s own functions, falls back to `DEFAULT_PLACEMENT_CONFIG` - not this repo's job) | 4.1a `PlacementConfigRepo.load` | D4a - "starting defaults, exposed as tunable scheduler parameters" - the data-as-config mechanism itself |

TC-1 through TC-4, TC-9, TC-11 live under `test/core/repositories/` and
`test/core/database/schema.test.ts` (real Postgres, testcontainers);
TC-5 through TC-8, TC-10 live under `test/scheduler/` (TC-10 needs no
Postgres at all - plain Vitest unit test on a pure function; TC-5 through
TC-8 need real Postgres for the same reason 0001/0003's decision-shaped
tests did).

## Implementation notes

Built exactly as planned - no interface/behavior deviation from the
agreed plan. `core/database/schema.sql` gained `placement`/
`placement_config`/`placement_access` (public schema, seeded `'default'`
config row, promoted from `archive/placement-resolver/schema.sql` per the
namespacing call already made in Open questions); `core/domain/
{placement,placement-config}.ts` + `rows.ts`/`mappers.ts` extensions;
`core/repositories/{placement,placement-config,placement-access}
.repository.ts` + their `queries/*.queries.ts` files, each following
ADR-0012's shape exactly (one file per aggregate/table); `CoreRepos`
(`database/transactions.ts`) extended with `placement`/`placementConfig`/
`placementAccess`; both barrels (`core/index.ts`) updated. The new
top-level `scheduler/` module (`constants.ts`, `trust.ts`, `placement.ts`,
`index.ts`) implements all eight functions ADR-0007 names
(`resolvePlacement`, `recordAccess`, `evaluatePromotion`,
`evaluateDemotion`, `promote`, `demote`, `evictLRUIfOverCapacity`,
`effectiveRehydrationCostMs`, `isTrustEligibleForOptimization`), each
composing `core/`'s three new repositories via a `CoreRepos` parameter,
mirroring `session/session-log.ts`'s existing shape - no connection opened
by `scheduler/` itself.

- **Two new `ERROR_IDS`** (`CORE_PLACEMENT_UPSERT_NO_ROW_RETURNED`,
  `CORE_PLACEMENT_SET_PINNED_NOT_FOUND`) added to `shared/errors.ts`,
  following the existing "no-row-returned" pattern used by every other
  repository in this module.
- **No new environment variables** - verified by inspection
  (`grep -rn "process.env" src/scheduler src/core/repositories/
  placement*.ts src/core/domain/placement*.ts` returns no matches).
  `.example.env` needed no update.
- **Test file placement for TC-2/TC-3/TC-4/TC-9** deviates slightly from
  the plan's literal file-location sketch ("TC-2 through TC-4, TC-9...
  live under `test/core/repositories/`"): these four test cases exercise
  `scheduler/`'s wrapper functions (`resolvePlacement`/`recordAccess`/
  `effectiveRehydrationCostMs`), not raw repository calls, so they are
  colocated with the rest of the `scheduler/placement.ts` test suite in
  `test/scheduler/placement.test.ts` (mirroring "tests mirror `src/`",
  ADR-0012 SS6) rather than under `test/core/repositories/`. The
  underlying `PlacementRepo`/`PlacementAccessRepo` primitives those
  wrapper functions call are separately covered by their own dedicated
  repository-level tests (`upsertAccess`'s COALESCE behavior, a
  never-seen-hash miss, windowed counting/pruning) - no correctness
  property from the agreed Test design table is left unverified, only its
  file location differs from the sketch. Noted here rather than silently
  diverging.
- No new `biome.json` `noRestrictedImports` entries were needed: every
  cross-module import added by this package (`scheduler/` importing
  `core/`'s and `shared/`'s barrels; `core/database/transactions.ts`
  importing the three new repositories intra-module) either goes through
  a barrel already, or is an intra-module import ADR-0012 SS4 exempts.
  This will need new entries the first time a future package imports one
  of `scheduler/`'s or `core/`'s new internals by a deep, non-barrel path
  - not needed yet, mirroring 0004's own note.
- `npx tsc --noEmit`, `npx biome check .`, and `npx vitest run` all pass
  clean (133/133 tests across 21 files, up from 108 across 16 - the 25 new
  tests are this package's schema extension (4) + `PlacementRepo` (6) +
  `PlacementConfigRepo` (2) + `PlacementAccessRepo` (3) + `scheduler/
  placement.ts` (9) + `scheduler/trust.ts` (2)) - verified directly, not
  assumed. `biome check --write .` was run once to fix six purely
  mechanical formatting/import-order findings (line-wrapping and one
  import-sort) across five test files and `scheduler/placement.ts` - no
  logic changed by that pass.

No follow-up tasks spun off beyond what Scope already named as explicitly
deferred (4.1-4.7's remaining wiring, tracked with inline notes on each in
`tasks.md` rather than as new task items, since none of them describe a
new deliverable this package didn't already anticipate).

**Post-review fixes** (from the local code review pass immediately after
this section was first written - both within this package's own scope, no
plan/test-design change, all still covered by the existing test suite
passing unchanged):

- **`SQL_LIST_PINNED_PLACEMENTS_ORDERED_BY_LRU` used `ORDER BY
  last_accessed_at ASC NULLS FIRST`, which `placement_pinned_lru_idx`'s
  default-collated index (`NULLS LAST`) can't satisfy, forcing an
  unnecessary `Sort` node on every eviction scan.** Fixed by dropping
  `NULLS FIRST` (plain `ASC`) - a pinned row's `last_accessed_at` is never
  actually NULL in practice (`setPinned` requires an existing row, and the
  only path that creates one, `upsertAccess`, always sets it), so this is
  a query-shape fix with no behavior change; TC-8's eviction-ordering test
  still passes unchanged.
- **`scheduler/placement.ts`'s `RecordAccessOptions` hand-duplicated
  `PlacementRepo`'s `UpsertPlacementAccessInput` field-for-field and
  forwarded it via an untyped `...spread`**, bypassing TypeScript's
  excess-property checking - a future field rename/add on the repository
  side would have silently dropped data here instead of failing to
  compile. Fixed by making `RecordAccessOptions extends
  Omit<UpsertPlacementAccessInput, "contentHash">` instead of
  re-declaring the same fields; `UpsertPlacementAccessInput` is now
  exported through `core/index.ts`'s barrel so `scheduler/` can reference
  it without a deep import.
- **`scheduler/constants.ts`'s `DEFAULT_PLACEMENT_CONFIG_PROFILE_NAME`
  was dead code** - exported (and re-exported from the barrel) but never
  referenced anywhere in `src/`/`test/`. Removed, along with its barrel
  re-export.
- **Two review findings deliberately left as documented caveats, not
  fixed**, consistent with the repo owner's explicit choice to fix only
  the two warnings + dead code: (1) `recordAccess`'s access-log prune
  horizon defaults to the compiled `DEFAULT_PLACEMENT_CONFIG` unless a
  caller explicitly loads and passes the DB-tuned `placement_config` row -
  a DB-side `frequencyWindowMs` tuning change silently won't affect
  pruning unless every caller remembers to thread the loaded config
  through; (2) `placement_access` pruning is per-content-hash and
  access-triggered only, so a hash that stops being accessed keeps its
  access rows indefinitely (no global/hash-agnostic sweep). Both are
  inherited unchanged from `archive/placement-resolver/src/resolver.js`'s
  own design (confirmed by the review's business-logic track - this
  package's promotion is byte-level-faithful to that reference, not a new
  regression) and are exactly the kind of "needs a real scheduling
  cadence" gap this package's own Scope section already named as open
  (4.4/4.6's remaining wiring) - tracked there rather than duplicated as a
  new task item.

Re-ran `npx tsc --noEmit`, `npx biome check .`, and `npx vitest run`
immediately after these fixes: clean typecheck, clean lint, 133/133 tests
passing across 21 files (unchanged count - both fixes were internal-shape
changes with no new test needed, and no existing test needed updating).

## Review notes

Compared against the agreed plan (Phase 1) and agreed test design
(Phase 2), not a fresh read of the code in a vacuum:

- Every Scope item (new task 4.1a) is present: `core/`'s
  `placement`/`placement_config`/`placement_access` schema and three
  repositories, and `scheduler/`'s eight promoted functions
  (`resolvePlacement`, `recordAccess`, `evaluatePromotion`,
  `evaluateDemotion`, `promote`, `demote`, `evictLRUIfOverCapacity`,
  `effectiveRehydrationCostMs`, `isTrustEligibleForOptimization`), all
  re-exported through `core/index.ts` and `scheduler/index.ts`'s barrels.
- All 11 agreed test cases (TC-1 through TC-11) exist and pass -
  cross-checked against the Test design table's own scope/property
  mapping; the one file-location deviation (TC-2/TC-3/TC-4/TC-9 living in
  `test/scheduler/placement.test.ts` rather than `test/core/
  repositories/`) is recorded in Implementation notes with rationale, and
  every correctness property those test cases name is still verified
  (either directly, or by the dedicated repository-level tests that back
  the wrapper functions under test). Re-ran `npx tsc --noEmit`, `npx biome
  check .`, and `npx vitest run` immediately before writing this section:
  clean typecheck, clean lint, 133/133 tests passing across 21 files.
- A local code review pass (`/local-review-uncommitted`, six parallel
  tracks: security, performance, business logic, deploy safety,
  duplication, dead code) found two real, fixed issues (the LRU
  index/query sort-order mismatch; the untyped-spread duplication between
  `RecordAccessOptions` and `UpsertPlacementAccessInput`) and one dead
  export (`DEFAULT_PLACEMENT_CONFIG_PROFILE_NAME`) - see Implementation
  notes' "Post-review fixes" for detail. The business-logic track
  additionally confirmed this package's promotion is byte-level-faithful
  to `archive/placement-resolver/src/resolver.js`'s already-tested
  reference (promotion/demotion/eviction/cost-authority logic all match
  exactly), and the security track confirmed no SQL injection risk (every
  query is parameterized) and no weakening of the D5a trust gate. Two
  further findings (recordAccess's default-vs-loaded config for pruning;
  per-hash-only access-log pruning with no global sweep) were confirmed to
  be inherited unchanged from the archived reference, not new regressions
  - left as documented caveats per the repo owner's explicit choice,
  tracked against 4.4/4.6's already-open "needs a real scheduling cadence"
  gap rather than as new work. The split between `core/`'s thin per-table
  repositories and `scheduler/`'s decision/orchestration logic matches
  ADR-0007's own list exactly (no decision-shaped logic leaked into
  `core/`, no repository leaked SQL string literals outside its
  `queries/` file); every repository method that can fail to return a row
  throws a structured `FatalError` with a dedicated `errorId`, matching
  every other repository's existing convention; no magic numbers/strings
  were introduced outside `scheduler/constants.ts`/`core/database/
  schema.sql`'s seeded row (kept in sync by hand, documented as such,
  same posture as `core/constants.ts`'s `DEFAULT_LEASE_SECONDS`); no env
  vars were touched.
- No scope creep: 4.1-4.7's remaining wiring (registry integration, a
  real scheduling cadence, `apps/worker`) was not touched, consistent with
  the plan's explicit exclusions; `registry/` was not promoted as part of
  this package.
- `tasks.md` accurately reflects reality: new task 4.1a marked `[x]` with
  a pointer to the real files/tests; 4.1-4.7 each left `[ ]` with an
  inline note on exactly what mechanism this package now provides and
  what remains open, rather than either silently checked off or left with
  no pointer at all.

No further follow-up issues found. Package considered complete for its
stated scope.
