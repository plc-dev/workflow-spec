# ADR-0002: `@wfx/core` owns the consolidated transactional schema

## Status

Proposed

## Context

D6 requires that four concerns - the execution engine's durability layer,
the D3 session input-history log, the D4 placement resolver, and the D8b
dataset-catalog *index* - be able to commit within **one Postgres
transaction**, not merely live in the same database instance. This DEEP
consolidation property is what spike 1.2 (see `archive/spikes/`) actually
demonstrated (a mid-transaction-crash test showed all four writes
commit-or-rollback together), and it is the property that ruled out every
other execution-engine candidate evaluated in D6 (Hatchet's gRPC
worker/Engine split, for example, caps out at SHALLOW consolidation - two
separate commits, in any topology).

This means the internal contract between these four concerns is **a shared
transaction handle**, not an API call. `archive/placement-resolver/`
already anticipates this: its `recordAccess` function accepts a
caller-owned Postgres client rather than opening its own connection, so it
can be composed into someone else's transaction.

Naive one-package-per-capability modularity (a package per D3/D4/D6/D8b)
would fragment ownership of what is, physically, a single schema, and would
turn "these four things commit atomically" into a coordination problem
solved anew by whichever caller happens to compose them, rather than a
structural guarantee.

## Decision

A single package, **`@wfx/core`**, owns:

- the consolidated Postgres **schema** and its **migrations** for:
  `executions`, `checkpoints`, `waits` (durability, D6); `session_log`,
  `session_pointer` (D3); `placement`, `placement_config`,
  `placement_access` (D4/D4a); the dataset-catalog `index` table
  (URN -> digest -> object key, D8b); and the memoization cache
  (`(input-hash, operation) -> output-hash`, D2/D3).
- a `withTransaction(fn)` primitive.
- a set of **typed repositories**, each bound to a transaction client,
  covering CRUD/query operations over the tables above.

Higher-level concerns - `@wfx/engine`, `@wfx/session`, `@wfx/scheduler` (see
ADR-0007) - are **logic** packages. They receive a transaction (or a
repository already bound to one) from a caller and never open their own
connection or own any schema. The contract between `@wfx/core` and its
callers is the transaction handle itself, plus the repository's typed
method signatures.

```
                    @wfx/core
        owns schema + migrations + repos
        exposes withTransaction(tx) -> { executions, checkpoints,
                                          waits, sessionLog, placement,
                                          datasetIndex, memoization }
                         |
     (operate within a tx handed to them; never own schema)
        +----------------+----------------+------------------+
   @wfx/engine       @wfx/session     @wfx/scheduler   @wfx/dataset-catalog
   (durability,      (D3 snapshot     (D4/D4a          (logic only - the
    dispatch)         chains, GC,      placement        index lives in
                       memoization      decisions)       @wfx/core; byte
                       lookups)                          access is a
                                                          separate concern,
                                                          see ADR-0006)
```

## Consequences

- Atomic, same-transaction commits across the four D6-consolidated concerns
  are structural (enforced by `@wfx/core`'s API shape), not a convention
  every caller has to remember to uphold.
- Schema ownership is unambiguous: exactly one package runs migrations
  against this schema.
- `@wfx/core` becomes a nexus dependency. Discipline is required to keep it
  a thin repository/transaction layer - no placement-decision logic,
  session-rewind logic, or engine-interpreter logic belongs here; those
  live in the packages that consume `@wfx/core`.
- The service registry and workflow-spec store are **deliberately not**
  part of this schema - see ADR-0006 for why that split is safe under D6.

## Alternatives considered

- **Per-concern schema fragments with a composing migration orchestrator**
  (each of D3/D4/D6/D8b owns its own tables; a higher-level tool applies all
  fragments and coordinates transactions across package boundaries).
  Rejected: turns "who owns this schema" into a distributed question, and
  makes the one-transaction guarantee something every caller must
  re-assemble correctly rather than something one package hands out
  already-satisfied.
