# ADR-0012: Module-internal structure, cross-cutting `shared/`, and naming conventions

## Status

Proposed

## Context

ADR-0007 fixed the **top-level** module inventory (`workflow-spec/`, `core/`,
`engine/`, `scheduler/`, ... plus `src/apps/*`) and the dependency
direction between those modules. ADR-0001 decided those boundaries are
enforced by convention, review, and lint rules rather than package
privacy. Neither ADR said anything about:

- what a module looks like **inside** (package 0001 landed `core/` as a
  flat directory mixing connection/transaction plumbing, repositories,
  domain types, raw row shapes, row mappers, and constants at one level),
- where genuinely **cross-cutting** files live (ADR-0009 named
  `src/config.ts` and `src/errors.ts` as top-level singletons, and package
  0001 added `src/logger.ts` next to them - three unrelated files
  accumulating directly under `src/`),
- **naming conventions** (package 0001 produced `tx.ts` and `db.ts`, whose
  meaning is not recoverable from the filename).

With ~13 modules still to be built, "whatever the first package happened to
do" is not a good default for the other twelve.

Two alternatives were weighed explicitly before this decision (see
"Alternatives considered"): a root-level layer-first split
(`controllers/`/`services/`/`repositories/`/`models/`), and keeping
cross-cutting files at the top level rather than grouping them.

## Decision

**1. Top-level layout is unchanged (ADR-0007 stands).** Modules are
domain/feature-first. This ADR only adds structure *inside* modules, plus
one new cross-cutting module described in point 3.

**2. Every module follows one repeatable internal shape.** Not every module
needs every element - a pure module (`workflow-spec/`, `logic/`, `urn/`) has no
`database/` - but where an element exists, it goes in the same place with
the same name:

```
src/<module>/
  index.ts          the module's PUBLIC surface (a barrel; no logic)
  constants.ts      module-wide named constants (see point 5)
  database/         schema.sql, connection/pool wiring, transaction primitives
  repositories/     one file per aggregate: <name>.repository.ts
    queries/        one file per repository: <name>.queries.ts (SQL_* constants)
  domain/           domain types, raw row shapes, row<->domain mappers
  <feature>.ts      the module's actual logic, in named files - never in index.ts
```

Concretely, for `core/` (per ADR-0002 the schema/transaction/repository
owner):

```
src/core/
  index.ts
  constants.ts
  database/
    schema.sql              this store's one canonical schema (ADR-0009)
    transactions.ts         was tx.ts - now a thin wrapper over
                             shared/database/'s generic withTransaction
                             (see this ADR's revision below); no
                             connection-pool.ts of its own any more - pool
                             creation itself is shared/database/'s
                             createPool (was core/database/db.ts)
  repositories/
    executions.repository.ts
    checkpoints.repository.ts
    queries/
      executions.queries.ts
      checkpoints.queries.ts
  domain/
    execution.ts            domain types (Execution, ExecutionStatus)
    checkpoint.ts
    rows.ts                 raw snake_case `pg` row shapes
    mappers.ts               row -> domain mapping
```

`domain/` splitting matters specifically because package 0001's single
`types.ts` conflated three distinct concerns (domain model, wire/row shape,
and the mapping between them).

`repositories/queries/` is a subdirectory rather than `*.queries.ts` files
sitting beside their repositories, so a module with many repositories
doesn't bury its repository files among an equal number of query files.

**3. Cross-cutting concerns live in `src/shared/`, not at the top level.
This amends ADR-0009.**

```
src/shared/
  index.ts                  the barrel every other module imports from
  config.ts                 zod schema over process.env (was src/config.ts)
  errors.ts                 PlatformError/RetryableError/FatalError (was src/errors.ts)
  observability/
    logger.ts               shared pino instance + redact config (was src/logger.ts)
    index.ts                (and, later, the ADR-0009 OpenTelemetry wiring)
```

ADR-0009's decisions themselves are unchanged in substance - there is still
exactly ONE config module, ONE error taxonomy, ONE logger instance. Only
their location changes, from `src/*.ts` to `src/shared/`.

**`shared/` is a CLOSED set, not a utility bucket.** The standard objection
to a `shared/`/`common/` directory - that it becomes a dumping ground - is
real, and ADR-0007's "no misc utilities module" rule exists to prevent
exactly that. It is accepted here anyway, because the alternative in
practice is that the dumping ground becomes `src/` itself, which is
strictly worse (it pollutes the namespace that ADR-0007's module inventory
is supposed to define). The mitigation is a hard rule rather than good
intentions:

> Every entry in `src/shared/` must be a named cross-cutting concern with
> its own stated reason to exist, listed in this ADR. Adding a new entry
> requires amending this ADR. `shared/misc.ts`, `shared/utils.ts`,
> `shared/helpers.ts`, and any equivalent grab-bag file are forbidden.

Current sanctioned entries: `config` (ADR-0009 env configuration),
`errors` (ADR-0009 error taxonomy), `observability` (ADR-0009 logging, and
later tracing), `database` and `trust-tier` (added by the revision below).

**Revision (`docs/impl-plans/0008-shared-database-consolidation.md`): two
new sanctioned entries.** A local code-review pass on `docs/impl-plans/
0007-registry.md` found that `core/` and `registry/` - the first two
modules to each own a database (ADR-0002/ADR-0006) - had already produced
two copies of the same Postgres connection/transaction plumbing, one of
which was missing a robustness fix (tolerant rollback + a swallowed
`'error'` listener for a forcibly terminated backend) the other had
already earned. Since a third own-database module (`workflow-store/`) is
still to come per ADR-0007's inventory, this was judged a genuine
cross-cutting concern - infrastructure every database-owning module needs
identically, not a domain module's own logic - rather than something to
leave as an accepted N-way duplication.

```
src/shared/
  database/
    index.ts                 barrel
    connection-pool.ts        createPool(config?) -> Pool - a thin `new
                              Pool(config)` wrapper (raw `pg`, no ORM,
                              per ADR-0009/D6a), with no schema/module
                              opinion of its own
    queryable.ts              the `Queryable` interface (`{ query }`) -
                              the minimal shape a repository needs to run
                              a parameterized query against EITHER a
                              plain `Pool` or an open transaction's
                              `PoolClient`, without committing to which
    transactions.ts           a GENERIC `withTransaction<Repos, T>(pool,
                              buildRepos, fn)`: opens a client, attaches/
                              detaches the tolerant `'error'` listener,
                              BEGINs, calls `buildRepos(client)` to get a
                              caller-shaped repo set, runs `fn(repos)`,
                              COMMITs on success, and ROLLBACKs
                              (swallowing a rollback-on-a-dead-connection
                              failure rather than letting it mask the
                              original error) on failure - always
                              releasing the client
  trust-tier.ts               `TRUST_TIERS`/`TrustTier` (design.md D5a) -
                              the three-value trust-tier vocabulary,
                              needed verbatim by BOTH `registry/` (which
                              stores/validates it, D5a/task 2.5) and
                              `scheduler/` (which gates on it, task 4.1a)
                              with neither depending on the other
                              (ADR-0007's fixed dependency direction has
                              `scheduler/` depend on `registry/`, never
                              the reverse) - `shared/` is the only place
                              both can pull the same three literal values
                              from without inverting that direction or
                              coupling the two modules directly
```

**Why `database/` earns cross-cutting status but domain modules'
`database/` subdirectories (schema.sql, that module's own repositories)
do not move here.** `shared/database/` holds ONLY the pool/transaction
*mechanism* - it has no schema, no domain repositories, no SQL of its own.
Each database-owning module keeps its own `database/schema.sql` and its
own `repositories/` exactly as ADR-0002/ADR-0006/this ADR's point 2
already specify; it now additionally imports the *mechanism* pieces
(`createPool`, `Queryable`, `withTransaction`) from `shared/database/`
instead of redefining them. Concretely: `core/database/transactions.ts`'s
public `withTransaction(pool, fn) -> CoreRepos` and `registry/database/
transactions.ts`'s public `withRegistryTransaction(pool, fn) ->
RegistryRepos` both keep their existing, module-specific signatures and
repo shapes - they are now thin wrappers that call `shared/database/`'s
generic `withTransaction` with their own `buildRepos` callback, rather
than each reimplementing the BEGIN/COMMIT/ROLLBACK/error-listener
mechanics by hand. `core/`'s repositories keep requiring `PoolClient`
specifically (a deliberate ADR-0002 constraint: everything in `core/`
runs inside a transaction `core/` itself hands out) - `Queryable` is used
by `registry/` (and, prospectively, `workflow-store/`), not retrofitted
onto `core/`'s existing repositories, since `PoolClient` already
structurally satisfies `Queryable` wherever a caller needs one.

**Why `trust-tier` earns cross-cutting status but `registry/`'s other
enums (`MATERIALIZATION_COST_CLASSES`, `NestingTransport`) do not move
here.** Only `TRUST_TIERS`/`TrustTier` was found duplicated across two
modules; the other two enums exist in exactly one place
(`registry/constants.ts`) with no second copy anywhere, so moving them
would violate this section's own closed-set rule (no cross-cutting
concern, no reason to be in `shared/`). `registry/constants.ts` and
`scheduler/trust.ts` both now import `TRUST_TIERS`/`TrustTier` from
`shared/` and re-export it through their own module's existing public
surface (so no importer of either module's barrel needs to change) -
`scheduler/trust.ts` keeps its own `isTrustEligibleForOptimization` logic
(that function is not a duplicate of anything and stays exactly where
ADR-0007 already put it).

**4. Cross-module imports go through barrels only.** A module may import
another module *only* via that module's `index.ts` - never a deep path into
its internals. `index.ts` files contain re-exports only, never logic. This
is what makes ADR-0007's dependency-direction rules partially mechanically
checkable rather than purely review-only (ADR-0001 decision 6 accepted
review-only enforcement; this narrows, but does not close, the gap).
Within a single module, deep relative imports between its own files are
expected and fine.

**Concrete mechanism and its real limitation.** Biome 1.9.4's
`noRestrictedImports` (nursery) matches on the **literal import specifier
string** as written, not a resolved path or a glob - there is no "ban any
deep path under `core/`" rule available in this Biome version. The lint
rule in `biome.json` therefore lists every currently-existing non-barrel
file under each module, once per relative-depth variant actually used in
this codebase (a same-level module importing another, e.g.
`../core/database/transactions.js`, and an `apps/*/main.ts` importing a
module, e.g. `../../core/database/transactions.js`). This is real,
verified enforcement for what's listed - but it is **not** self-maintaining:
adding a new internal file to a module, or introducing a new import depth
(e.g. a nested module two directories deep), requires a corresponding new
entry, by hand, or the rule silently doesn't cover it. Review remains the
actual backstop for anything the list hasn't caught up to yet - this rule
narrows, rather than replaces, that backstop.

**5. Naming conventions.**

- **No abbreviations in filenames or directory names.** `tx`, `db`, `cfg`,
  `util`, `svc`, `mgr` and similar are forbidden - `transactions.ts`,
  `connection-pool.ts`, `config.ts`.
- **kebab-case** for file and directory names.
- **Role suffixes** where a file has a structural role:
  `*.repository.ts`, `*.queries.ts`, `*.test.ts`. No suffix for plain
  domain/logic files.
- **Plural for collections, singular for the thing itself**: repositories
  and their query files are named after the table they own
  (`executions.repository.ts`), domain type files after the single entity
  (`domain/execution.ts`).
- `index.ts` is reserved for barrels. A file named `index.ts` containing
  logic is a review violation.

**6. Tests mirror `src/`.** `test/` keeps its own tree mirroring the source
layout (`test/core/repositories/executions.repository.test.ts`), rather than
colocating `*.test.ts` next to sources. This keeps `src/` free of test
files and matches the existing Vitest `include` pattern (ADR-0009).

## Consequences

- Every module built from here on has one obvious internal shape, so
  "where does this file go" is answered by convention rather than
  per-package improvisation.
- ADR-0009's `src/config.ts`/`src/errors.ts` paths are superseded by
  `src/shared/config.ts`/`src/shared/errors.ts` (substance unchanged).
  ADR-0009's own text carries a revision note pointing here.
- Package 0001's already-landed `core/` layout is refactored to match
  (`tx.ts` -> `database/transactions.ts`, `db.ts` ->
  `database/connection-pool.ts`, `types.ts` split across `domain/`,
  `*.queries.ts` into `repositories/queries/`). Its plan document
  (`docs/impl-plans/0001-durable-core.md`) keeps its original paths as a
  historical record, with a pointer to this ADR.
- The barrel-only rule adds one constraint to live with, and means each
  module must actively curate its `index.ts` - which is the point: a
  module's public surface becomes an explicit, reviewable artifact.
- `shared/` carries a permanent risk of erosion; the closed-set rule above
  is the control, and it depends on review actually enforcing it.
- (Revision, `docs/impl-plans/0008-shared-database-consolidation.md`)
  `core/database/connection-pool.ts` and `registry/database/
  connection-pool.ts` are both removed - `createPool`/`Queryable` now live
  only in `shared/database/`. `core/database/transactions.ts`'s
  `withTransaction` and `registry/database/transactions.ts`'s
  `withRegistryTransaction` keep their existing public signatures/repo
  shapes but are now thin wrappers over `shared/database/`'s generic
  version - `registry/`'s copy gains the tolerant-rollback/error-listener
  handling `core/`'s copy already had, closing a real robustness gap the
  two independent copies had silently diverged on. `registry/constants.ts`
  and `scheduler/trust.ts` both now source `TRUST_TIERS`/`TrustTier` from
  `shared/trust-tier.ts` rather than each defining their own copy of the
  same three values.

## Alternatives considered

- **Root-level layer-first structure** (`src/controllers/`,
  `src/services/`, `src/repositories/`, `src/models/`). Rejected: it
  contradicts ADR-0007 and, more importantly, destroys its enforcement
  story - once every module's pieces are scattered across four root
  directories, "which modules may import which" is no longer expressible
  as an import rule. It is also a poor fit for this system's actual shape:
  its "controllers" are three thin app entrypoints (`apps/worker`,
  `apps/dispatch-api`, `apps/mcp-gateway`), while its substance is deep,
  heterogeneous domain logic (an execution-plan compiler, a placement resolver, an MCP
  gateway) that is not "services over models". Adding a module would mean
  touching four directories instead of one.
- **Keep cross-cutting files at the top level** (`src/config.ts`,
  `src/errors.ts`, `src/logger.ts`, as ADR-0009 originally wrote them).
  Rejected: it makes `src/`'s top level a mix of ADR-0007's module
  inventory and an open-ended set of loose files - the same
  dumping-ground failure mode, just in a worse location.
- **Colocated tests** (`src/**/foo.test.ts`). Not rejected on principle -
  it makes missing coverage visible at a glance - but rejected here to keep
  `src/` free of non-shipping files and to avoid rewriting ADR-0009's
  existing Vitest configuration for no correctness gain.
- **`*.queries.ts` beside its repository** (package 0001's original
  choice). Rejected as the module grows: N repositories plus N query files
  in one flat directory obscures which files are the actual repositories.
