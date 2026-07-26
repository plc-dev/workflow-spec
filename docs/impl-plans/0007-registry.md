# 0007: Registry - `registry/`'s own metadata-index database

## Status

`reviewed`

## Scope

This package promotes `archive/registry/` (task 2.x's already-completed,
already-tested spike-era deliverable) into real, committed code in
`src/registry/`, following this repo's current conventions (ADR-0006/0007/
0012) - the same "promote by rewrite, not by copy" treatment already given
to `archive/spikes/1.2-.../` (0001/0002), `archive/dsl/schema/` (0004), and
`archive/placement-resolver/` (0005). Nothing under `src/` today owns a
`service_images`/`function_capabilities` table or a registry client of any
kind - `scheduler/`'s own plan doc (0005) explicitly named this gap:

> 4.1 ... this task remains open because there is no `registry/` client
> (capability metadata) ... feeding it yet.
> 4.7 ... this task remains open pending `registry/`'s `getPlacementFacts`
> (2.8) as a real module to source the trust tier from.

**No new `tasks.md` line item is added.** Unlike 0005 (which had to invent
4.1a because `archive/placement-resolver/` split across two ADR-0007
modules), the tasks this package covers already exist and are already
marked `[x]` - their "Done" notes currently point at the pre-restructuring
`registry/` paths (written before `archive/` existed), which this package's
Phase 3 will update to point at the real `src/registry/` files/tests -
exactly the treatment 0004 already gave task 5.1 when it promoted
`archive/dsl/schema/` into `src/workflow-spec/`.

**Tasks.md line items covered (notes to be updated in Phase 3, not newly
checked):**

- **2.1** - service-registry metadata index (`service_images`, per-digest
  `openapi_spec`/`oci_ref`).
- **2.1a** - per-function capability metadata (`function_capabilities`:
  mutates, materialization-cost-class, COW-support, change-detection).
- **2.1b** - per-image hardware requirements (`hardware_requirements`
  JSONB, structurally separate from the trust-tier model).
- **2.1c** - per-function `nesting_declaration` (transport + targets).
- **2.2** - registry validation (enum/required-field checks, plus the
  referential check that capability metadata's function keys exist in the
  entry's own `openapi_spec` operations).
- **2.5** - trust tiers keyed to image digest, defaulting to `unverified`.
- **2.8** - `getPlacementFacts(digest, function)` as one atomic read.
- **2.10** - privilege-split write paths (`registerImage` vs.
  `recordTrustTier`) as a structural, not runtime-checked, boundary.

**Left `[ ]`, unchanged, out of scope for this package:**

- **2.3** (backfill real images), **2.4**/**2.6**/**2.7** (conformance
  probing/CI-gating/runtime invariant checking - all need real running
  service images to probe, per their own existing deferral notes),
  **2.9** (digest-pinned resolution at authoring time - a `dsl-compiler/`
  concern), **2.11** (re-pin/upgrade flow - design.md D12 itself flags this
  as not yet designed), **2.12** (the CLI heavy-data onboarding contract -
  a registry *content* requirement on future backfilled entries, not a
  schema/module change this package would make).
- **4.1/4.7** - this package is the "real `registry/` client" 0005 named as
  the missing piece, but nothing calls it yet (`scheduler/` isn't wired to
  it, and no `apps/worker` exists) - 4.1/4.7 stay open pending that wiring,
  same posture 0005 left them in.

## Sources

- **ADR-0006** (control-plane stores are separate): `registry/` owns its
  **own** Postgres database, entirely separate from `core/`'s consolidated
  schema - its reads (`getPlacementFacts`, `getEntry`) never join the D6
  step-completion transaction, and its privilege split (`registerImage` vs.
  `recordTrustTier`) is a **separately importable surface**, not merely a
  module-internal check.
- **ADR-0007** (module inventory): names `registry/` as "control-plane
  store, OWN database ... `admin.ts` (registerImage) and `conformance.ts`
  (recordTrustTier) as separate files - importing `admin.ts` from anywhere
  data-plane-facing is a lint/review violation, not a compiler error," and
  states the explicit rule: "no data-plane module or app may import
  `registry/admin.ts`."
- **ADR-0012** (module-internal structure/naming): the `database/`/
  `repositories/`/`repositories/queries/`/`domain/`/`constants.ts`/
  barrel-`index.ts` shape, applied to `registry/` for the first time
  against a module that is a **leaf with its own database** rather than a
  `core/`-composing module.
- **design.md D12** (the service registry is a first-party metadata index,
  not an image byte store): the ENTRY shape (`openapi_spec` as sole stored
  contract, per-function capability metadata, per-digest trust tier,
  per-image hardware requirements outside the trust model, per-function
  `nesting_declaration`), the consistency split (authoring-time reads vs.
  the one-atomic-query dispatch-time read), and the privilege split
  (`registerImage` platform-developer-only; `recordTrustTier` the
  platform's own conformance pipeline).
- **design.md D5/D5a**: the exact capability-metadata fields and the
  trust-tier enum/semantics (`unverified` default; scheduler only leans on
  a declaration once `production-proven`) `registry/` stores and exposes.
- **`archive/registry/`** (task 2.1/2.1a-c/2.2/2.5/2.8/2.10's already-built,
  already-tested deliverable - `schema.sql`, `src/{admin,conformance,db,
  query,validate}.js`, `test.js`, 27/27 assertions passing against a real
  Postgres instance): the actual starting point, promoted-by-rewrite (per
  ADR-0001 decision 5) into TypeScript/current conventions - same
  relationship 0001 had to spike 1.2 and 0005 had to
  `archive/placement-resolver/`.

**Open questions these sources leave unresolved, resolved here as a call
this package makes:**

- **Does `registry/`'s own database keep the archived `CREATE SCHEMA
  registry` namespace?** No - 0005 already anticipated this exact case
  when it dropped spike 1.2's dedicated SQL namespace for `core/`'s tables:
  "the archived isolation concern doesn't apply once `registry/`/
  `workflow-store/` have their own separate *databases* (ADR-0006)." Since
  `registry/` now genuinely gets its own database (not merely its own
  schema-within-a-shared-database), its two tables go into that database's
  default `public` schema, with no dedicated Postgres namespace.
- **Do `getEntry`/`getPlacementFacts` take a `core/`-style `Repos` object
  bound to an open transaction (mirroring `session/`, `scheduler/`), or a
  plain `Pool`?** Resolved: a plain `Pool` (or any object satisfying a
  minimal `Queryable` shape - see Plan). ADR-0006 is explicit that these
  reads "never join the step-completion transaction," and D12 frames the
  authoring-time read as merely "interactive and cacheable" - there is no
  cross-concern atomicity requirement here to justify the composability
  machinery `core/`'s consolidated schema exists for. `getPlacementFacts`
  itself still preserves its own required atomicity (one JOIN query, one
  MVCC snapshot) - that guarantee comes from being a single SQL statement,
  not from a caller-supplied transaction.
- **Are `admin.ts`/`conformance.ts` re-exported from `registry/index.ts`?**
  No - this is the concrete mechanism behind ADR-0006/0007's privilege
  split. `index.ts` (the barrel every other module is required to import
  through, per ADR-0012 SS4) exports only the read/validation surface
  (`getEntry`, `getPlacementFacts`, `validateRegistration`,
  `validateTrustTier`, domain types, constants). `registerImage` and
  `recordTrustTier` are reached only by importing `registry/admin.js` /
  `registry/conformance.js` **directly by path** - a deliberate, named
  exception to the barrel-only rule, not an oversight. No `biome.json`
  `noRestrictedImports` entry is added yet for `registry/admin.js`/
  `registry/conformance.js` themselves (mirrors 0005's own precedent: no
  rule is added until a real caller elsewhere in `src/` actually exists to
  restrict) - the structural boundary (nothing importable via the barrel)
  is what's real today; a future lint rule narrows enforcement further
  once `apps/worker`/a real conformance pipeline exist.
- **Do `ServiceImagesRepo`/`FunctionCapabilitiesRepo` duplicate
  `scheduler/trust.ts`'s `TRUST_TIERS`/`TrustTier`?** Yes, deliberately.
  ADR-0007's dependency direction has `scheduler/` depend on `registry/`
  (via `getPlacementFacts`), never the reverse - `registry/` cannot import
  from `scheduler/` without inverting that direction or introducing a new
  shared module ADR-0007's fixed inventory doesn't name. `registry/`
  therefore defines its own `TRUST_TIERS`/`TrustTier` (identical values,
  independent source), matching what `archive/registry/src/validate.js`
  already did independently of `archive/placement-resolver/`'s own trust
  vocabulary before either was promoted.
- **Local dev docker-compose**: does `registry/` get its own
  `docker-compose.dev.yml` service? Yes, for the same reason `core/`'s
  `postgres` service was added when 0001 landed even before any app
  entrypoint read a connection string via `shared/config.ts` - local dev
  convenience is independent of app wiring. A second `postgres`-image
  service (`registry-postgres`, distinct port, mounting `registry/
  database/schema.sql`) is added; no `shared/config.ts`/`.example.env`
  change is needed yet (mirrors `core/`'s own still-open deferral note -
  no app entrypoint consumes a connection string yet for either database).

## Plan

### File/module layout

```
src/registry/                          (NEW top-level module - ADR-0007)
  index.ts                              barrel: read/validation surface only
                                         (NOT registerImage/recordTrustTier)
  admin.ts                              registerImage - PLATFORM-DEVELOPER-ONLY
                                         surface, deliberately NOT re-exported
                                         from index.ts (ADR-0006)
  conformance.ts                        recordTrustTier - WORKFLOW-PLATFORM
                                         (conformance pipeline) surface,
                                         deliberately NOT re-exported from
                                         index.ts (ADR-0006)
  get-entry.ts                          getEntry(pool, digest) - composed
                                         authoring-time read
  get-placement-facts.ts                getPlacementFacts(pool, digest, fn) -
                                         ONE atomic JOIN query (D12)
  validate.ts                           validateRegistration, validateTrustTier,
                                         operationIdsFromOpenApi (pure, no I/O)
  constants.ts                          MATERIALIZATION_COST_CLASSES,
                                         TRUST_TIERS, NESTING_TRANSPORTS + types
  database/
    schema.sql                          service_images, function_capabilities
                                         (own database, public schema, no
                                         dedicated SQL namespace)
    connection-pool.ts                  createPool; exports the Queryable
                                         shape (`{ query }`) repos are typed
                                         against
    transactions.ts                     withRegistryTransaction(pool, fn) ->
                                         { serviceImages, functionCapabilities,
                                         client } - used only by admin.ts's
                                         two-table registerImage write; not
                                         exported from index.ts
  domain/
    service-image.ts                    ServiceImage
    function-capability.ts              FunctionCapability
    nesting-declaration.ts              NestingDeclaration
    registry-entry.ts                   RegistryEntry (getEntry's return shape)
    placement-facts.ts                  PlacementFacts (getPlacementFacts's
                                         return shape)
    rows.ts                             ServiceImageRow, FunctionCapabilityRow
    mappers.ts                          mapServiceImageRow, mapFunctionCapabilityRow
    index.ts                            domain barrel
  repositories/
    service-images.repository.ts        upsert (never touches trust_tier on
                                         conflict), findByDigest, updateTrustTier
    function-capabilities.repository.ts replaceForDigest, listByDigest
    queries/
      service-images.queries.ts
      function-capabilities.queries.ts
      get-placement-facts.queries.ts    SQL_GET_PLACEMENT_FACTS (the one
                                         JOIN query - lives outside the two
                                         per-table repos on purpose, so its
                                         one-query atomicity can't be
                                         accidentally decomposed later)

test/
  helpers/postgres.ts                   (extended) startTestPostgres now
                                         takes an optional { schemaPath }
                                         (defaults to core/'s schema.sql,
                                         preserving every existing call site)
  registry/database/schema.test.ts      (new)
  registry/repositories/service-images.repository.test.ts        (new)
  registry/repositories/function-capabilities.repository.test.ts (new)
  registry/get-entry.test.ts             (new)
  registry/get-placement-facts.test.ts   (new)
  registry/admin.test.ts                 (new)
  registry/conformance.test.ts           (new)
  registry/validate.test.ts              (new)
  registry/index.test.ts                 (new) - the privilege-split guard

docker-compose.dev.yml                  (extended) new `registry-postgres`
                                         service, distinct port, mounting
                                         registry/database/schema.sql
```

### Interfaces (signatures)

```ts
// src/registry/constants.ts
export const MATERIALIZATION_COST_CLASSES = ["negligible", "heavy"] as const;
export type MaterializationCostClass = (typeof MATERIALIZATION_COST_CLASSES)[number];
export const TRUST_TIERS = ["unverified", "conformance-passed", "production-proven"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];
export const NESTING_TRANSPORTS = ["sdk", "http", "cli", "mcp"] as const;
export type NestingTransport = (typeof NESTING_TRANSPORTS)[number];

// src/registry/domain/nesting-declaration.ts
export interface NestingDeclaration {
  via: NestingTransport;
  targets: string[] | "open";
}

// src/registry/domain/function-capability.ts
export interface FunctionCapability {
  digest: string;
  functionName: string;
  mutates: boolean;
  materializationCostClass: MaterializationCostClass;
  cowSupport: boolean;
  changeDetectionSupport: boolean;
  nestingDeclaration: NestingDeclaration | null;
}

// src/registry/domain/service-image.ts
export interface ServiceImage {
  digest: string;
  ociRef: string;
  openapiSpec: Record<string, unknown>;
  hardwareRequirements: Record<string, unknown>;
  trustTier: TrustTier;
  registeredAt: Date;
  updatedAt: Date;
}

// src/registry/domain/registry-entry.ts
export interface RegistryEntry extends ServiceImage {
  functions: Record<string, Omit<FunctionCapability, "digest" | "functionName">>;
}

// src/registry/domain/placement-facts.ts
export interface PlacementFacts {
  digest: string;
  function: string;
  capability: Omit<FunctionCapability, "digest" | "functionName">;
  trustTier: TrustTier;
  hardwareRequirements: Record<string, unknown>;
}

// src/registry/database/connection-pool.ts
export interface Queryable {
  query: Pool["query"];
}
export function createPool(config?: PoolConfig): Pool;

// src/registry/repositories/service-images.repository.ts
export interface ServiceImagesRepo {
  upsert(input: {
    digest: string;
    ociRef: string;
    openapiSpec: Record<string, unknown>;
    hardwareRequirements: Record<string, unknown>;
  }): Promise<ServiceImage>; // INSERT ... ON CONFLICT (digest) DO UPDATE,
                              // never touching trust_tier - a redeploy to
                              // the same digest doesn't reset earned trust,
                              // and register() never grants it either
  findByDigest(digest: string): Promise<ServiceImage | null>;
  updateTrustTier(digest: string, tier: TrustTier): Promise<ServiceImage | null>; // null = unregistered digest
}
export function createServiceImagesRepo(client: Queryable): ServiceImagesRepo;

// src/registry/repositories/function-capabilities.repository.ts
export interface FunctionCapabilitiesRepo {
  replaceForDigest(
    digest: string,
    capabilityMetadata: Record<string, Omit<FunctionCapability, "digest" | "functionName">>,
  ): Promise<FunctionCapability[]>; // DELETE-then-INSERT per digest, matching archive's
                                     // "replace the function rows for this digest" semantics
  listByDigest(digest: string): Promise<FunctionCapability[]>;
}
export function createFunctionCapabilitiesRepo(client: Queryable): FunctionCapabilitiesRepo;

// src/registry/database/transactions.ts (internal - not exported from index.ts)
export interface RegistryRepos {
  serviceImages: ServiceImagesRepo;
  functionCapabilities: FunctionCapabilitiesRepo;
  client: PoolClient;
}
export function withRegistryTransaction<T>(
  pool: Pool,
  fn: (repos: RegistryRepos) => Promise<T>,
): Promise<T>;

// src/registry/validate.ts (pure, no I/O)
export function operationIdsFromOpenApi(openapiSpec: unknown): Set<string>;
export function validateRegistration(input: {
  digest?: string;
  ociRef?: string;
  openapiSpec?: unknown;
  capabilityMetadata?: Record<string, unknown>;
  hardwareRequirements?: unknown;
}): { valid: boolean; errors: string[] };
export function validateTrustTier(tier: unknown): { valid: boolean; errors: string[] };

// src/registry/admin.ts - exports ONLY registerImage
export interface RegisterImageInput {
  digest: string;
  ociRef: string;
  openapiSpec: Record<string, unknown>;
  capabilityMetadata?: Record<string, Omit<FunctionCapability, "digest" | "functionName">>;
  hardwareRequirements?: Record<string, unknown>;
}
export function registerImage(
  pool: Pool,
  input: RegisterImageInput,
): Promise<{ digest: string; trustTier: TrustTier }>;

// src/registry/conformance.ts - exports ONLY recordTrustTier
export function recordTrustTier(
  pool: Pool,
  digest: string,
  tier: TrustTier,
): Promise<{ digest: string; trustTier: TrustTier }>;

// src/registry/get-entry.ts
export function getEntry(pool: Queryable, digest: string): Promise<RegistryEntry | null>;

// src/registry/get-placement-facts.ts
export function getPlacementFacts(
  pool: Queryable,
  digest: string,
  functionName: string,
): Promise<PlacementFacts | null>;

// src/registry/index.ts (barrel) - re-exports getEntry, getPlacementFacts,
// validateRegistration, validateTrustTier, operationIdsFromOpenApi,
// createPool, every domain type, and constants.ts's exports. Deliberately
// omits admin.ts and conformance.ts entirely.
```

New `ERROR_IDS` (`src/shared/errors.ts`):

```ts
REGISTRY_VALIDATION_FAILED: "registry.registration.validation_failed"
REGISTRY_TRUST_TIER_INVALID: "registry.trust_tier.invalid"
REGISTRY_TRUST_TIER_UNKNOWN_DIGEST: "registry.trust_tier.unknown_digest"
```

All three are `FatalError` (bad input / an operation the caller must not
mechanically retry - registering the same bad payload again fails the same
way; retrying `recordTrustTier` against a digest that was never registered
won't start succeeding on its own).

### Data flow

```ts
import { registerImage } from "../registry/admin.js";           // deep import - by design
import { recordTrustTier } from "../registry/conformance.js";    // deep import - by design
import { getEntry, getPlacementFacts } from "../registry/index.js"; // via barrel

// A platform developer's own tooling (not built in this repo yet):
await registerImage(registryPool, {
  digest, ociRef, openapiSpec, capabilityMetadata, hardwareRequirements,
});
// -> { digest, trustTier: "unverified" }

// The platform's own conformance pipeline (not built in this repo yet, task 2.4):
await recordTrustTier(registryPool, digest, "conformance-passed");

// A future scheduler/ caller (task 4.1/4.7, not wired in this package):
const facts = await getPlacementFacts(registryPool, digest, "loadDump");
// facts: { capability, trustTier, hardwareRequirements } - one atomic read,
// exactly the shape scheduler.isTrustEligibleForOptimization(facts.trustTier)
// and D4's capability-fusion leg are waiting for.
```

`registryPool` is a **separate** `Pool` from `core/`'s - `registry/` never
receives a `core/`-issued transaction client and never opens a connection
against `core/`'s database.

### Sequencing rationale

- **Why now:** `scheduler/` (0005) is fully implemented but has no real
  input for its capability-metadata leg - 4.1/4.7 are explicitly blocked on
  exactly this package existing. It is also the one other component (besides
  `placement-resolver/`) `archive/` already has a fully-built, fully-tested
  (27/27 assertions) reference implementation for, making this a low-risk
  promotion rather than new design, the same profile 0001/0004/0005 already
  had.
- **What it depends on:** nothing that doesn't already exist - `registry/`
  is a leaf per ADR-0007's dependency diagram, with its own database and no
  dependency on `core/`, `scheduler/`, or `workflow-spec/`. `shared/errors.ts`
  is the only cross-module dependency (already built, 0001).
- **What it unblocks:** a real capability-metadata/trust-tier input for
  `scheduler/`'s 4.1 (placement decision fusion) and 4.7 (trust-tier
  gating), whenever a real caller (`apps/worker`, or an interim wiring
  package) is built; the D12-mandated structural privilege split becomes
  committed code a future platform-developer tool and conformance pipeline
  can import directly.
- **What it deliberately does NOT unblock yet:** 4.1/4.7 themselves (no
  real caller exists to wire this into - same posture 0005 left them in);
  2.3/2.4/2.6/2.7 (all need real running service images, unaffected by this
  package existing); any dispatch mechanism (6.3/6.4/6.15, which need the
  exec-agent, ADR-0008, a separate future package).

## Test design

**Gate collapsed into Phase 1's approval.** This package qualifies as
small/low-risk per the process's own collapse criterion: it promotes an
already-built, already-tested (27/27 assertions against a real Postgres
instance) reference implementation with no new correctness property beyond
what `archive/registry/test.js` already exercised; it is a leaf module with
its own database, not part of ADR-0002's D6 four-way consolidation
(unlike 0001/0002/0003, which extended `core/`'s foundational,
consolidation-critical schema and were kept as separate gates for exactly
that reason); and its own scope table above shows every remaining open item
(4.1/4.7's real wiring, conformance probing) explicitly deferred to future
packages, not attempted here.

### Setup: default Vitest + testcontainers-node is sufficient

Every behavior below depends on real Postgres semantics (`ON CONFLICT`,
`REFERENCES ... ON DELETE CASCADE`, `CHECK` constraints) - the same class of
test 0001-0005 already ran successfully against a real, ephemeral Postgres
instance. No new concurrency, crash, or scale claim is introduced:
`archive/registry/test.js` never claimed one either (`registerImage`'s
transaction is a plain two-statement-group write with no concurrent-writer
scenario design.md D12/D5 asks this package to prove), and nothing here is
claimed by `SKIP LOCKED`-style concurrent workers the way `executions`/
`waits` are. A **second, separate** ephemeral Postgres container is used
(via `startTestPostgres({ schemaPath: REGISTRY_SCHEMA_PATH })`) - never the
`core/` one - so this package's own tests double as a structural check that
`registry/` really doesn't share a database with `core/`.

### Test cases

| # | Test | Scope item | Correctness property verified |
|---|---|---|---|
| TC-1 | Apply `registry/database/schema.sql` fresh; assert `service_images`/`function_capabilities` tables, `service_images.trust_tier`'s CHECK constraint, `function_capabilities.materialization_cost_class`'s CHECK constraint, and the `function_capabilities -> service_images` `ON DELETE CASCADE` FK all exist/behave | 2.1/2.1a/2.5 schema | D12's ENTRY shape as a structural precondition |
| TC-2 | `ServiceImagesRepo.upsert` on a new digest inserts with `trust_tier='unverified'`; a second `upsert` on the SAME digest (changed `openapiSpec`/`hardwareRequirements`) updates those fields but leaves an already-promoted `trust_tier` untouched | 2.1/2.5 `ServiceImagesRepo.upsert` | D5a - "register never touches trust... a regression in a new build does not inherit an older build's earned trust" is preserved the other direction too: re-registering the SAME digest doesn't reset it either |
| TC-3 | `FunctionCapabilitiesRepo.replaceForDigest` called twice for the same digest with different function sets: the second call's rows entirely replace the first's (no stale leftover function) | 2.1a `FunctionCapabilitiesRepo.replaceForDigest` | archived "replace the function rows for this digest" semantics |
| TC-4 | `registerImage` stores a two-function entry (one non-mutating/negligible/no-nesting, one mutating/heavy/COW-capable/`nesting_declaration:{via:"http",targets:"open"}`) exactly, retrievable via `getEntry` | 2.1/2.1a/2.1b/2.1c | D5/D12's per-function capability granularity + per-function nesting declaration |
| TC-5 | `getEntry` on an unregistered digest returns `null` | 2.1 `getEntry` | miss-is-not-an-error, matching every other resolver-shaped read in this repo (`resolvePlacement`, etc.) |
| TC-6 | `getPlacementFacts(digest, fn)` returns capability metadata, trust tier, and hardware requirements together in one call; returns `null` for a function absent from `function_capabilities` even though the digest itself is registered | 2.8 `getPlacementFacts` | D12 - "returns capability metadata, trust tier, and hardware requirements together, so callers never observe them skewed relative to one another" |
| TC-7 | After `recordTrustTier` transitions a digest `unverified -> conformance-passed -> production-proven`, an immediately following `getPlacementFacts` call reflects the new tier | 2.5/2.8 composability | D5a's tier transition is visible to the D12 atomic read with no staleness |
| TC-8 | `recordTrustTier` on an unregistered digest throws `FatalError(REGISTRY_TRUST_TIER_UNKNOWN_DIGEST)`; `recordTrustTier` with an invalid tier string throws `FatalError(REGISTRY_TRUST_TIER_INVALID)` before ever issuing a query | 2.5/2.10 `recordTrustTier` | D12 - "the runtime cannot conjure an entry - only annotate an existing one" |
| TC-9 | `validateRegistration` rejects: capability metadata referencing a function absent from `openapiSpec`'s `operationId`s; an invalid `materializationCostClass` enum value; a malformed `nestingDeclaration` (`via` outside `sdk\|http\|cli\|mcp`) - each with an error message naming the offending field | 2.2 `validate.ts` | D12's "sole stored contract" rule - capability metadata can't drift from what the OpenAPI contract actually declares |
| TC-10 | `registerImage` with a payload `validateRegistration` would reject throws `FatalError(REGISTRY_VALIDATION_FAILED)` before issuing any query (no partial write) | 2.2/2.1 `admin.ts` composability | validation is actually wired into the write path, not just a standalone checker |
| TC-11 | `Object.keys` of the `registry/index.ts` barrel's namespace import does NOT include `registerImage` or `recordTrustTier` | 2.10 structural privilege split | ADR-0006 - "no data-plane package can depend on the admin surface at all - it simply isn't part of what those packages import" |
| TC-12 | `Object.keys` of a namespace import of `registry/admin.js` is exactly `["registerImage"]`; of `registry/conformance.js` is exactly `["recordTrustTier"]` | 2.10 | ports `archive/registry/test.js`'s own two assertions verbatim - the one thing the archived suite already checked directly |

TC-1 lives in `test/registry/database/schema.test.ts`; TC-2/TC-3 in
`test/registry/repositories/*.repository.test.ts`; TC-4/TC-5 in
`test/registry/get-entry.test.ts`; TC-6/TC-7 in
`test/registry/get-placement-facts.test.ts`; TC-8/TC-10 split across
`test/registry/conformance.test.ts`/`test/registry/admin.test.ts`; TC-9 in
`test/registry/validate.test.ts` (no Postgres needed - pure functions);
TC-11/TC-12 in `test/registry/index.test.ts` (no Postgres needed either).

## Implementation notes

Built exactly as planned - no interface/behavior deviation from the agreed
plan. `src/registry/database/schema.sql` (`service_images`/
`function_capabilities`, own database, no dedicated SQL namespace, per the
plan's resolved open question); `src/registry/database/{connection-pool,
transactions}.ts` (`Queryable`, `withRegistryTransaction`);
`src/registry/domain/{service-image,function-capability,nesting-
declaration,registry-entry,placement-facts,rows,mappers}.ts`;
`src/registry/repositories/{service-images,function-
capabilities}.repository.ts` + their `queries/*.queries.ts` files (plus
`queries/get-placement-facts.queries.ts`, deliberately outside either
repository per the plan); `src/registry/{constants,validate,get-entry,
get-placement-facts}.ts`; `src/registry/admin.ts` (`registerImage`,
exports ONLY that) and `src/registry/conformance.ts` (`recordTrustTier`,
exports ONLY that), neither re-exported from `src/registry/index.ts`'s
barrel. `docker-compose.dev.yml` gained a `registry-postgres` service
(port 5433, own volume, own schema mount) alongside the existing
`postgres` service.

- **Three new `ERROR_IDS`** added to `shared/errors.ts`:
  `REGISTRY_VALIDATION_FAILED`, `REGISTRY_TRUST_TIER_INVALID`,
  `REGISTRY_TRUST_TIER_UNKNOWN_DIGEST`, plus a fourth defensive one not
  named in the original plan text, `REGISTRY_SERVICE_IMAGE_UPSERT_NO_ROW_RETURNED`
  (mirrors every other repository's existing "no-row-returned" pattern,
  e.g. `CORE_PLACEMENT_UPSERT_NO_ROW_RETURNED`) - added during
  implementation once `ServiceImagesRepo.upsert` needed to satisfy
  `noUncheckedIndexedAccess` without a non-null assertion; a minor
  addition within the plan's own stated shape, not a scope change.
- **One behavior improvement over the archived reference, noted since it
  is an observable difference**: `archive/registry/src/admin.js`'s
  `registerImage` always returned a hardcoded `trustTier: "unverified"`
  in its result, even when re-registering an already-`production-proven`
  digest (the archived write path itself never touched trust either - only
  its return value was stale). `src/registry/admin.ts`'s `registerImage`
  returns the row's actual current `trustTier` from the upsert's
  `RETURNING` clause instead, which is strictly more correct and required
  no plan change (the plan's own signature only specified `{ digest,
  trustTier }`, not a hardcoded value) - recorded here rather than left
  silent, per the "small deviations noted as you go" instruction.
- **No new environment variables** - verified by inspection
  (`grep -rn "process.env" src/registry` returns no matches, matching the
  plan's stated posture that `core/`'s own Postgres connection string
  still isn't read via `shared/config.ts` either, since no app entrypoint
  exists yet for either database). `.example.env` needed no update.
- **`test/helpers/postgres.ts`'s `startTestPostgres` extension** was
  additive only (`schemaPath` is optional, defaulting to `core/`'s schema
  path) - none of the existing 19 call sites needed a change, verified by
  the full suite passing unchanged for every non-`registry/` test file.
- No new `biome.json` `noRestrictedImports` entries were added, matching
  the plan's own resolved open question: nothing under `src/` outside
  `registry/` itself imports any `registry/` file yet (deep or via
  barrel), so there is nothing yet to restrict - this will need entries
  the first time a future package (e.g. `scheduler/`'s 4.1/4.7 wiring)
  imports `registry/index.ts`'s barrel or, if it ever mistakenly reached
  for it, `registry/admin.js`.
- `npx tsc --noEmit`, `npx biome check .`, and `npx vitest run` all pass
  clean (201/201 tests across 35 files, up from 164 across 26 - the 37 new
  tests are this package's schema (4) + `ServiceImagesRepo` (4) +
  `FunctionCapabilitiesRepo` (3) + `getEntry` (2) + `getPlacementFacts` (3)
  + `registerImage` (2) + `recordTrustTier` (3) + `validate` (6) + the
  privilege-split guard (3), plus TC-9's four sub-assertions counted
  individually by Vitest) - verified directly, not assumed. One round of
  `biome check --write .` (9 files, import-order/line-wrapping only) and
  one round of `biome check --write --unsafe .` (1 file,
  `noUnusedTemplateLiteral` - a template literal with no interpolation
  replaced with a plain string literal, no behavior change) were run to
  fix purely mechanical formatting/lint findings; no logic changed by
  either pass.

No follow-up tasks spun off beyond what Scope already named as explicitly
deferred (2.3/2.4/2.6/2.7/2.9/2.11/2.12, and 4.1/4.7's remaining wiring -
tasks.md's inline notes on 4.1/4.7 were updated to point at this package
as the now-available capability-metadata/trust-tier source, not newly
checked).

**Post-review fixes** (from the local code review pass immediately after
this section was first written - all within this package's own scope, no
plan/test-design change, all still covered by the test suite):

- **`schema.sql` used `DROP TABLE IF EXISTS ... CASCADE` at the top**,
  diverging from `core/database/schema.sql`'s established convention
  (`CREATE TABLE IF NOT EXISTS`, never a destructive `DROP`) for a file
  that is both applied to disposable testcontainers instances AND mounted
  into `docker-compose.dev.yml`'s **persistent** `registry-postgres`
  volume. A manual/CI re-apply against a database that already had real
  data would have silently deleted every row, including earned
  `trust_tier` values `registerImage` deliberately never resets. Fixed:
  both `CREATE TABLE` statements now use `IF NOT EXISTS`; the two `DROP`
  statements were removed.
- **`get-placement-facts.ts` hand-rolled a third, independent row
  shape/column list** (`SQL_GET_PLACEMENT_FACTS`'s explicit `SELECT`
  column list, plus its own inline row-to-domain mapping) instead of
  reusing `rows.ts`/`mappers.ts`'s canonical `ServiceImageRow`/
  `FunctionCapabilityRow`/`mapServiceImageRow`/`mapFunctionCapabilityRow` -
  `rows.ts`'s own header comment states the mapping "lives in exactly one
  place (mappers.ts)," which this violated. A field added to
  `FunctionCapability`/`ServiceImage` later could silently come back as
  `undefined` from just this one read path (the one the scheduler's
  trust/placement decisions actually depend on) without any test failing,
  since the prior test only asserted a few spot fields. Fixed:
  `SQL_GET_PLACEMENT_FACTS` now selects `si.*, fc.*`; `get-placement-
  facts.ts` reuses `mapServiceImageRow`/`mapFunctionCapabilityRow` against
  the joined row (typed `ServiceImageRow & FunctionCapabilityRow`); its
  test now deep-equals the full `capability` object against
  `CAPABILITY_METADATA.loadDump` rather than spot-checking individual
  fields, so a future column-list drift would fail the test.
- **`RegistryRepos.client` (the raw `PoolClient` field, mirroring `core/`'s
  `CoreRepos.client` escape hatch) was dead** - nothing in `admin.ts` (its
  only caller) or any test read it, unlike `core/`'s equivalent field,
  which several crash tests genuinely need. Removed from both the
  interface and `withRegistryTransaction`'s returned object; `PoolClient`
  dropped from `database/transactions.ts`'s `pg` import as it became
  unused.
- **Two drift-guard tests added** (`test/registry/database/
  schema.test.ts`): every `TRUST_TIERS`/`MATERIALIZATION_COST_CLASSES`
  value round-trips successfully into the real schema's CHECK
  constraints. `registry/constants.ts`'s enums and `schema.sql`'s CHECK
  constraints are two independent copies of the same vocabulary with
  nothing TypeScript-checkable linking them (by design, per this
  package's dependency-direction constraints for the `TRUST_TIERS` case
  specifically - see "Open questions") - without this, a value
  `validate.ts` accepts but the CHECK constraint rejects would surface as
  an unmapped raw `pg` error instead of the intended structured
  `FatalError`, only discoverable at write time in production rather than
  in this package's own test suite.

Re-ran `npx tsc --noEmit`, `npx biome check .`, and `npx vitest run`
immediately after these fixes: clean typecheck, clean lint, 203/203 tests
passing across 35 files (up from 201 - the two new drift-guard tests).

**Pointer forward (docs/impl-plans/0008-shared-database-consolidation.md):**
several things recorded above were later revised by that package -
`database/connection-pool.ts` and `Queryable` moved to
`shared/database/`; `database/transactions.ts`'s `withRegistryTransaction`
became a thin wrapper over `shared/database/`'s generic version, which
also fixed a robustness gap this section didn't catch (missing tolerant-
rollback/`'error'`-listener handling under a real mid-transaction crash -
0007's own test design never exercised one); `RegistryRepos.client`,
removed above as dead code, was reintroduced once a crash test genuinely
needed it; `constants.ts`'s `TRUST_TIERS`/`TrustTier` were re-exported
from `shared/trust-tier.ts` instead of defined locally;
`FunctionCapabilityInput` was deduplicated across five sites. This
paragraph is a pointer only; the sections above are left as this
package's own historical record of what it actually built and reviewed
at the time.

## Review notes

Compared against the agreed plan (Phase 1) and agreed test design
(Phase 2), not a fresh read of the code in a vacuum:

- Every Scope item (2.1, 2.1a, 2.1b, 2.1c, 2.2, 2.5, 2.8, 2.10) is present
  and matches the agreed interfaces: `src/registry/database/schema.sql`'s
  `service_images`/`function_capabilities` tables; `getEntry`/
  `getPlacementFacts` (the latter still a single, atomic JOIN query after
  the post-review fix, now reusing the canonical row mappers instead of a
  third hand-rolled shape); `validate.ts`'s enum/required-field/
  referential checks; the structural privilege split (`admin.ts`/
  `conformance.ts` exporting exactly one function each, neither
  re-exported from `index.ts`).
- All 12 agreed test cases (TC-1 through TC-12) exist and pass, plus two
  drift-guard tests added during review (not in the original agreed test
  design, but strictly additive coverage within the same package, noted in
  Implementation notes). Re-ran `npx tsc --noEmit`, `npx biome check .`,
  and `npx vitest run` immediately before writing this section: clean
  typecheck, clean lint, 203/203 tests passing across 35 files.
- A local code review pass (`/local-review-uncommitted`, six parallel
  tracks: security, performance, business logic, deploy safety,
  duplication, dead code) found:
  - **Security**: no findings - all SQL is parameterized, the privilege
    split is structurally intact (no cross-import of `admin.ts`/
    `conformance.ts`), untrusted JSON (`openapiSpec`/`capabilityMetadata`)
    is never `eval`'d or used to build SQL, and no credentials were added
    beyond the pre-existing dev-only `wfx/wfx` pattern already used by
    `core/`'s own docker-compose service.
  - **Performance**: no findings - `getPlacementFacts` is confirmed to
    issue exactly one query; every query predicate is served by an
    existing primary key; no per-call `Pool` construction; the
    DELETE-then-loop-INSERT in `replaceForDigest` is bounded by one
    image's function count on a platform-developer-only path, not a
    realistic-scale N+1.
  - **Business logic**: no findings - all six named invariants (trust
    tier never touched by re-registration, `getPlacementFacts`'s
    atomicity, `recordTrustTier`'s fail-on-unregistered-digest,
    validate-before-write with no partial writes, the referential check,
    and replace-not-merge capability semantics) verified directly against
    the code, plus consistent `JSON.stringify`-on-write/pg-auto-parse-on-
    read handling for every JSONB column.
  - **Deploy safety**: one real finding, fixed (see Implementation
    notes) - `schema.sql`'s `DROP TABLE ... CASCADE` diverged from
    `core/`'s idempotent, re-appliable convention and would have been
    destructive against `docker-compose.dev.yml`'s persistent
    `registry-postgres` volume on a manual/CI re-apply. Confirmed as
    non-findings: the port mapping (5433, no collision with `core/`'s
    5432), the new-volume-name guarantee (`docker-entrypoint-initdb.d`
    cannot fire against pre-populated data), and the `ON DELETE CASCADE`
    FK (nothing in this package's code path ever deletes a
    `service_images` row, so no unexpected cascade loss is reachable).
  - **Duplication**: two lower-severity findings not independently fixed
    as code changes (the deliberate `TRUST_TIERS`/
    `MATERIALIZATION_COST_CLASSES` duplication against `schema.sql`'s
    CHECK constraints, and `TRUST_TIERS` against `scheduler/trust.ts`'s
    independent copy) - addressed via the two new drift-guard tests
    (schema.sql side) rather than removing the duplication itself, since
    the duplication against `scheduler/trust.ts` specifically is a
    deliberate consequence of ADR-0007's fixed dependency direction (see
    "Open questions"), not an accident to eliminate. One genuine
    duplication finding (`get-placement-facts.ts`'s hand-rolled row
    shape/mapping) was fixed directly - see Implementation notes.
  - **Dead code**: one finding, fixed (see Implementation notes) -
    `RegistryRepos.client`, an unused escape-hatch field mirroring
    `core/`'s `CoreRepos.client` (which IS used, by several crash tests) -
    removed here since nothing in this package needed it.
- No scope creep: no new task-scope item was implemented beyond what
  Scope named; the review's fixes are all within this package's own
  already-agreed file set (no new files beyond the two new test cases).
- `tasks.md` accurately reflects reality: 2.1/2.1a/2.1b/2.1c/2.2/2.5/2.8/
  2.10's "Done" notes point at the real `src/registry/` files and
  `test/registry/` tests; 4.1/4.7's notes were updated to reflect that a
  real `registry/` client now exists, still correctly left `[ ]` pending a
  real caller.

No further follow-up issues found. Package considered complete for its
stated scope.
