# ADR-0003: The IR is the system spine (`@wfx/ir`)

## Status

Proposed

## Context

D8 splits the workflow DSL into an authoring surface (what a workflow-writer
types, plural, non-deterministic-at-author-time) and a stable intermediate
representation, the IR (what the scheduler and execution engine consume).
D8a/D8c/D8d fix the concrete grammar (restricted YAML/JSON, camelCase,
digest-pinned service refs, `sessionState` declared once per key, `yields`
for map/branch results, `irVersion` locked as the version field name). D11
makes the IR a whole-document-versioned artifact with lazy, forward-only,
fail-closed-on-too-new migration.

Every plane of the system touches the IR: the authoring surface (and its
compiler) produces it; the workflow-spec store (D13) persists and forks it;
the scheduler (D4) pre-analyzes its statically-declared branch/map shapes;
the execution engine (D6) interprets it. It is the one artifact that, if its
contract is right, lets every other component evolve independently - which
is the entire rationale D8 gives for the authoring/IR split in the first
place.

## Decision

A pure, zero-I/O package, **`@wfx/ir`**, owns the whole IR contract:

- **Types**: `WorkflowSpec`, `Step`, `Binding` (the discriminated union:
  `static | session | request | step | item | literal | compute |
  itemResource`), `WriteTarget`, `sessionState` declarations, `branch`,
  `map`/`forEach`, `yields`.
- **The canonical JSON Schema** (promoted from `archive/dsl/schema/`,
  JSON Schema draft 2020-12), validated against real example documents.
- **`validate(doc)`** - schema validation.
- **`migrate(doc) -> currentDoc`** - a chain of pure migrator functions,
  `v(n) -> v(n+1) -> ... -> current`, applied lazily on open; **fails closed**
  with a clear "unsupported version" error for any document newer than the
  reader understands (D11 - never guessed, never best-effort parsed).
- **`deriveSignature(doc)`** - walks the IR for `request`-scoped bindings to
  produce the caller-supplied parameter list, and detects any `session`-
  scoped binding to mark the workflow as session-requiring (D8's derived
  workflow signature, discoverable the same way a service's OpenAPI
  signature is).

`@wfx/ir` depends on nothing with I/O. It may depend on `@wfx/logic` (for
typing `compute` expressions, D10) and `@wfx/urn` (for typing dataset/
workflow references, D8a/D13) - both themselves pure.

## Consequences

- Authoring surface, workflow-spec store, scheduler, and engine share one
  type universe and one validator; there is no second, informally-typed
  copy of "what a workflow-spec looks like" anywhere in the system.
- `@wfx/ir` is the package to build first: `@wfx/dsl-compiler` produces it,
  `@wfx/workflow-store` persists it, `@wfx/scheduler` and `@wfx/engine`
  consume it, and none of those can be meaningfully built without it.
- The restricted-YAML profile itself (no anchors/aliases/merge keys/custom
  tags, per D8a) is **not** enforced by the JSON Schema and is not this
  package's job - it belongs to the parser in `@wfx/dsl-compiler` (mirrors
  the existing note carried over from task 1.7).

## Alternatives considered

- **Version the IR per-construct rather than as a whole document.** Rejected
  per D11 - adds complexity with no clear benefit while the IR is authored
  and synthesized as a whole document per workflow-spec, not assembled from
  independently-versioned fragments.
- **Kubernetes-style multi-version serving.** Rejected per D11 as premature -
  this is a closed, single-organization document format, not a public,
  multi-client API surface; a single stored version plus migrate-on-read is
  proportionate.
