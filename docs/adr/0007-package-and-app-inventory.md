# ADR-0007: Module inventory and dependency direction

## Status

Proposed (revised - see "Revision note" below)

## Context

ADR-0001 through ADR-0006 each establish one seam of the software design
(the single-package/language decision, the consolidated core, the execution-plan spine,
binding resolution, step-dispatch transport, and the control-plane/core
split). This ADR draws the concrete module list those seams imply, including
the one non-trivial promotion decision they force: `archive/placement-
resolver/` splits across two modules rather than promoting as a single
unit, because its tables and its decision logic sit on opposite sides of the
ADR-0002 boundary.

**Revision note.** This ADR originally listed these as separate npm
packages under `packages/`. Per ADR-0001's revision, there is now a single
package; the list below is a **directory/module inventory**, not a package
list. The dependency-direction rules are unchanged - only the enforcement
mechanism changes, from `package.json` `exports` maps to convention, code
review, and lint rules (see ADR-0001 decision 6 for why that's an accepted
trade rather than a weaker one in the way that actually matters).

## Decision

```
src/ (single package, all modules)

  workflow-spec/     pure: WorkflowSpec/Step/Binding types, JSON Schema,
                      validate, migrate, deriveSignature            [ADR-0003]
                      (execution-plan/ splits out of this once
                      dsl-compiler/ exists - see ADR-0003)
  logic/             pure: JSON-Logic evaluator for `compute`         [D10]
  urn/               pure: URN parse/format (dataset + workflow schemes)
                                                                      [D8a, D13]
  core/              ★ consolidated schema + migrations + tx repos
                      (executions/checkpoints/waits, session_log/pointer,
                      placement/*, dataset-catalog index, memoization)
                                                                      [ADR-0002]
  engine/            durable-exec interpreter; the ONE dispatch
                      primitive (tracked-child-execution insert); the
                      outer CLI-dispatch invocation path, via the
                      exec-agent RPC client (ADR-0008)                [ADR-0005]
                      (depends on core/, workflow-spec/)
  scheduler/         placement decisions: fuses registry/'s
                      getPlacementFacts + execution-plan-declared intent +
                      core/'s placement repo observations
                      (the PROMOTED DECISION LOGIC half of
                      archive/placement-resolver/)                    [D4/D4a]
  session/           snapshot chains, COW/full-copy materialization,
                      memoization lookups, rewind (D3/D3a); operates over
                      core/'s session_log/placement/memoization repos
  dataset-catalog/   URN -> digest -> object-key logic; the INDEX lives
                      in core/ (ADR-0002), byte access goes through a
                      dedicated object-storage adapter, mirroring D8b's
                      own index/byte-store split
  secrets/           broker-agnostic interface + an OpenBao adapter
                      (task 1.6); implements the agent-RPC-relayed
                      secret-delivery path from ADR-0008
  nesting/           allowlist/governor + MCP-gateway logic for D9b/D9c
                      inner dispatch; calls engine/'s dispatch primitive,
                      never a raw endpoint
  item-pool/         D15/D16 resolve + flatten; writes into
                      dataset-catalog/ and core/'s memoization cache
  identity/          relying-party assertion verification (D14);
                      extracts an opaque writerId, maintains no profile
  registry/          control-plane store, OWN database                [ADR-0006]
                      (promoted from archive/registry/); `admin.ts`
                      (registerImage) and `conformance.ts`
                      (recordTrustTier) as separate files - importing
                      `admin.ts` from anywhere data-plane-facing is a
                      lint/review violation, not a compiler error (see
                      ADR-0001 decision 6)
  workflow-store/    control-plane store, OWN database                [ADR-0006]
                      (D13: URN identity, fork, lineage pin)
  dsl-compiler/      restricted-YAML/JSON authoring surface -> execution
                      plan (D8a/D8c); promotes archive/dsl/'s JSON Schema
                      via workflow-spec/; offline/authoring-plane only

  apps/ (entrypoints, not packages - each bundled into its own Docker image)

    worker/           runs engine/'s interpreter loop; composes
                      scheduler/, session/, secrets/, nesting/,
                      item-pool/; performs the ADR-0005 outer dispatch by
                      calling the ADR-0008 exec-agent's Invoke RPC against
                      target containers
    dispatch-api/      the platform's own dispatch endpoint (the HTTP
                      projection used for nesting inserts per D9c, and
                      for external invocation); identity/ middleware at
                      the boundary
    mcp-gateway/       MCP projection of the dispatch primitive, scoped
                      per invocation to an allowlist (D9c)

agent/ (separate Go module - see ADR-0001 decision 3, ADR-0008)

  the in-pod exec-agent binary; built and deployed independently of the
  TypeScript package above; consumed by worker/ only as a network RPC
  client (engine/'s dispatch path), never as an in-process import
```

**Dependency direction (unchanged from the original form of this ADR -
only the enforcement mechanism changed):**

```
pure (workflow-spec/, logic/, urn/)
   ^
   | (typed against, no I/O)
domain logic (session/, scheduler/, dataset-catalog/, nesting/,
              item-pool/, secrets/, identity/)
   ^
   | (operate within a transaction/repo it hands out)
core/
   ^
   | (composes)
engine/  ->  apps/worker, apps/dispatch-api, apps/mcp-gateway

registry/ and workflow-store/ are leaves with their own databases,
depended on via their client interfaces only (never their schemas) - see
ADR-0006.

RULE: no data-plane module or app may import registry/admin.ts
(registerImage) - only a separate, not-yet-specified platform-developer
tool does. Enforced by code review and (where practical) a Biome lint
rule restricting cross-directory imports of that specific file - NOT by
package-level privacy, per ADR-0001's revision.
```

**The one non-trivial promotion: `archive/placement-resolver/` splits.**
Its Postgres tables (`placement`, `placement_config`, `placement_access`)
are part of the D6 four-way consolidation and move into `core/`'s schema
(ADR-0002). Its decision logic (`resolvePlacement`, `recordAccess`,
`evaluatePromotion`, `evaluateDemotion`, `evictLRUIfOverCapacity`,
`isTrustEligibleForOptimization`) is promoted into `scheduler/`, which
calls `core/`'s placement repository rather than owning any table itself.
This is a genuine refactor of the archived code, not a mechanical move -
the archived version conflated schema ownership and decision logic in one
component precisely because it predates the ADR-0002 boundary.

**`dataset-catalog/` straddles the ADR-0006 boundary on purpose, mirroring
D8b.** Only the URN -> digest -> object-key **index** is consolidated into
`core/`; the resolved **bytes** live in dedicated object storage (S3/GCS/
MinIO-shaped, product deferred per D8b), reached through an adapter this
module owns. `dataset-catalog/` itself has no database connection of its
own - it calls `core/`'s index repo for lookups and the object-storage
adapter for byte access.

## Consequences

- Every module listed has an unambiguous single reason to exist, traceable
  to a specific ADR or design.md decision - there is no "misc utilities"
  module.
- The promotion of the three archived components is not a lift-and-shift:
  `archive/dsl/` becomes `workflow-spec/` + `dsl-compiler/` (a schema is not a
  compiler); `archive/registry/` becomes `registry/` largely as-is (its
  structure already matches D12's privilege split); `archive/placement-
  resolver/` splits across `core/` and `scheduler/` as described above.
- `apps/worker` is the single place that actually calls the ADR-0008
  exec-agent's `Invoke`/`Evict` RPCs - the CLI-exec transport question and
  the secrets-injection question ADR-0005 originally left open are both
  resolved by ADR-0008, and `worker/` is where that resolution gets
  exercised, not where it still needs deciding.

## Alternatives considered

- **Promote `archive/placement-resolver/` as a single module, with `core/`
  merely re-exporting its tables.** Rejected: this would leave decision
  logic and schema ownership bundled together, working against ADR-0002's
  explicit separation and reintroducing the "who owns this schema"
  ambiguity ADR-0002 exists to close.
- **Give `registry/`'s privilege split compiler-enforced privacy via a
  separate package (the original form of this ADR).** Rejected per
  ADR-0001's revision - see that ADR's Revision note for why this would
  only simulate enforcement the design already expects a real
  authorization layer to provide.
