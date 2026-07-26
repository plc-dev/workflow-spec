# ADR-0003: The execution plan is the system spine (`workflow-spec/` today, `execution-plan/` after the compiler)

> **Terminology note (retitled from "the IR is the system spine"):** see
> `docs/glossary.md` for the full workflow-spec vs. execution-plan
> distinction. In short: the **workflow-spec** is the authored,
> human/UI-editable document (versioned by `workflowSpecVersion`); the
> **execution plan** is the compiled, engine-agnostic document the
> scheduler and interpreter consume. No `dsl-compiler/` exists yet, so
> today the two are byte-identical - `ExecutionPlan` is a temporary type
> alias for `WorkflowSpec` (see `src/workflow-spec/domain/workflow-
> spec.ts`), flagged with a `TODO` to split them once a real compile step
> exists (tasks 5.2/5.10).
>
> **Module naming follows the contents, not the concept.** The conceptual
> spine is the execution plan (that is what the engine runs), but every
> concrete artifact that exists today - the grammar types, the JSON Schema,
> `validate()`, `workflowSpecVersion` - is authoring-side, and stays
> authoring-side after the split, because it is what the compiler *reads*.
> So the module is **`workflow-spec/`**, and `execution-plan/` will be
> created as a new module when `dsl-compiler/` lands rather than by
> renaming this one. Everything below describes `workflow-spec/`; the
> "Consequences" section records the split checklist.

## Status

Proposed

## Context

D8 splits the workflow DSL into an authoring surface (what a workflow-writer
types, plural, non-deterministic-at-author-time) and a stable intermediate
representation, the execution plan (what the scheduler and execution engine
consume). D8a/D8c/D8d fix the concrete grammar (restricted YAML/JSON,
camelCase, digest-pinned service refs, `sessionState` declared once per key,
`yields` for map/branch results, `workflowSpecVersion` locked as the
authoring-surface version field name). D11 makes the workflow-spec a
whole-document-versioned artifact with lazy, forward-only,
fail-closed-on-too-new migration.

Every plane of the system touches the execution plan: the authoring surface
(and its compiler) produces it; the workflow-spec store (D13) persists and
forks the workflow-spec it's derived from; the scheduler (D4) pre-analyzes
its statically-declared branch/map shapes; the execution engine (D6)
interprets it. It is the one artifact that, if its contract is right, lets
every other component evolve independently - which is the entire rationale
D8 gives for the authoring/execution-plan split in the first place.

## Decision

A pure, zero-I/O package, **`workflow-spec/`**, owns the whole
workflow-spec/execution-plan contract (one module while the two are
identical - see the naming note above):

- **Types**: `WorkflowSpec` (the authored document; `ExecutionPlan` is
  currently an alias for it - see the terminology note above), `Step`,
  `Binding` (the discriminated union: `static | session | request | step |
  item | literal | compute | itemResource`), `WriteTarget`, `sessionState`
  declarations, `branch`, `map`/`forEach`, `yields`.
- **The canonical JSON Schema** (promoted from `archive/dsl/schema/`,
  JSON Schema draft 2020-12), validated against real example documents.
- **`validate(doc)`** - schema validation.
- **`migrate(doc) -> currentDoc`** - a chain of pure migrator functions,
  `v(n) -> v(n+1) -> ... -> current`, applied lazily on open; **fails closed**
  with a clear "unsupported version" error for any document newer than the
  reader understands (D11 - never guessed, never best-effort parsed).
- **`deriveSignature(doc)`** - walks the execution plan for `request`-scoped
  bindings to produce the caller-supplied parameter list, and detects any
  `session`-scoped binding to mark the workflow as session-requiring (D8's
  derived workflow signature, discoverable the same way a service's OpenAPI
  signature is).

`workflow-spec/` depends on nothing with I/O. It may depend on
`@wfx/logic` (for typing `compute` expressions, D10) and `@wfx/urn` (for
typing dataset/workflow references, D8a/D13) - both themselves pure.

## Consequences

- Authoring surface, workflow-spec store, scheduler, and engine share one
  type universe and one validator; there is no second, informally-typed
  copy of "what a workflow-spec looks like" anywhere in the system.
- `workflow-spec/` is the package to build first: `@wfx/dsl-compiler`
  produces it, `@wfx/workflow-store` persists it, `@wfx/scheduler` and
  `@wfx/engine` consume it, and none of those can be meaningfully built
  without it.
- The restricted-YAML profile itself (no anchors/aliases/merge keys/custom
  tags, per D8a) is **not** enforced by the JSON Schema and is not this
  package's job - it belongs to the parser in `@wfx/dsl-compiler` (mirrors
  the existing note carried over from task 1.7).
- **Follow-up when `@wfx/dsl-compiler` lands** (the split checklist, also
  recorded as a `TODO` on the `ExecutionPlan` alias itself):
  1. Create a new **`execution-plan/`** module owning `ExecutionPlan` as
     its own type, with its own version tag independent of
     `workflowSpecVersion` (per the D8d/D11 amendment in
     `openspec/changes/workflow-execution-platform/design.md`), and
     repoint `engine/` at it.
  2. **Nothing moves out of `workflow-spec/`**: the grammar types, the
     JSON Schema, `validate()`, and `workflowSpecVersion` are all
     authoring-side and are exactly what the compiler reads.
  3. `execution-plan/` imports the shared grammar types
     (`Binding`/`Step`/`Node`/...) from `workflow-spec/`'s barrel rather
     than duplicating them - this ADR's "one type universe, one validator"
     consequence applies across the split, so a third `grammar/` module is
     explicitly not the intended shape.
  4. Delete the `ExecutionPlan = WorkflowSpec` alias.

## Alternatives considered

- **Version the execution plan per-construct rather than as a whole
  document.** Rejected per D11 - adds complexity with no clear benefit
  while the workflow-spec is authored and synthesized as a whole document
  per workflow-spec, not assembled from independently-versioned fragments.
- **Kubernetes-style multi-version serving.** Rejected per D11 as premature -
  this is a closed, single-organization document format, not a public,
  multi-client API surface; a single stored version plus migrate-on-read is
  proportionate.
