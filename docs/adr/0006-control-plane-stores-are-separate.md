# ADR-0006: Control-plane stores are separate from `@wfx/core`

## Status

Proposed

## Context

D12 specifies the service registry as a first-party metadata index with
reads "split by consistency need": authoring-time reads (existence/
signature lookups) are interactive and cacheable, while the dispatch-time
read, `getPlacementFacts(digest, function)`, is hot-path and correctness-
critical but is still **a read** - it returns capability metadata, trust
tier, and hardware requirements as one atomic query, not a write that needs
to join any other transaction. D12 also establishes a structural privilege
split: `registerImage` (platform-developer-only) and `recordTrustTier`
(the platform's own conformance pipeline) live in disjoint modules, so
nothing runtime-facing can ever call `registerImage`.

D13 specifies the workflow-spec store as deliberately asymmetric with the
registry (different identity scheme, different writers, no trust model,
reuse by fork rather than by invocation) - explicitly *not* a parallel
registry for a different artifact type.

D6's four-way consolidation (ADR-0002) is about the engine durability layer,
the session log, the placement resolver, and the dataset-catalog *index*
sharing one transaction. Neither the registry nor the workflow-spec store
is in that list.

## Decision

`@wfx/registry` and `@wfx/workflow-store` (ADR-0007) each own their **own**
Postgres database/schema, entirely separate from `@wfx/core`. They are
queried via their own client interfaces (`getPlacementFacts`, `getEntry`,
workflow-spec lookup/fork), and those reads never join the step-completion
transaction that `@wfx/core` mediates. This is safe precisely because D12
already classifies the dispatch-time read as a read, not a write requiring
atomicity with anything else - consolidation (ADR-0002) is unviolated by
keeping these stores physically separate.

The registry's structural privilege split is preserved as a **package**
boundary, not just a module boundary within one package: `@wfx/registry`
exposes an `admin` entry point (`registerImage`) and a `conformance` entry
point (`recordTrustTier`) as separately importable surfaces, so no
data-plane package (`@wfx/engine`, `@wfx/scheduler`, `@wfx/session`, ...)
can depend on the `admin` surface at all - it simply isn't part of what
those packages import.

## Consequences

- The consolidated core schema (ADR-0002) stays scoped to exactly the four
  concerns D6 actually requires to be transactionally atomic; it does not
  grow to "everything Postgres-backed" by default.
- The registry and workflow-spec store can evolve their own schemas,
  migration cadence, and (if ever needed) even their own storage engine
  choice independently of the core's migration cadence - there is no shared-
  schema coupling forcing them to move together.
- `getPlacementFacts` results are cacheable at the scheduler (D12 already
  frames this as an interactive/cacheable read for authoring-time lookups,
  and even the dispatch-time read is a single atomic query the scheduler can
  reasonably cache with a short TTL) without any risk to the durability
  transaction it feeds into - it never becomes part of that transaction.

## Alternatives considered

- **Fold the registry and workflow-spec store into `@wfx/core`'s schema**
  (one Postgres schema for everything). Rejected: D12/D13 give both stores
  genuinely different consistency, privilege, and identity models than the
  four D6-consolidated concerns; folding them in would blur a boundary D12/
  D13 draw deliberately and buy nothing, since neither needs the same-
  transaction property ADR-0002 exists to provide.
