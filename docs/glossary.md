# Glossary

This document collects the platform's own terminology in one place, since
several terms are used precisely and inconsistently across `design.md`,
`docs/adr/`, and `docs/impl-plans/`. When a term below has its own
authoritative definition elsewhere, this entry points there rather than
restating it.

## workflow-spec

The **authored**, human/UI-editable document a workflow-writer produces:
metadata, `sessionState` declarations, steps, outputs (design.md D8/D8a).
Plural authoring surfaces are supported (a restricted-YAML/JSON document
today; potentially a code-based builder later) - see `workflow-dsl`'s
capability spec. Versioned by the whole-document `workflowSpecVersion`
field (design.md D8d/D11), which is **author-facing**: it exists because
the funded UI authoring tool has its own, independently-timed release
cadence and may lag behind whatever version the backend is producing
(design.md D11). This field was previously named `irVersion`; see
"IR" below for why it was renamed.

The `WorkflowSpec` TypeScript type (`src/workflow-spec/domain/workflow-
spec.ts`) models this document.

## execution plan

The **compiled, engine-agnostic** document the scheduler pre-analyzes and
the execution engine's interpreter runs - the output of D8's "synthesize
once, execute the plan" split (mirroring Terraform/Pulumi/CDK's "synthesize
a plan once, execute the plan" pattern).

**Current status: not yet a distinct artifact.** No `dsl-compiler/`
package exists yet to compile a workflow-spec into a separate execution
plan, so today the execution plan is byte-identical to the workflow-spec.
`src/workflow-spec/domain/workflow-spec.ts` reflects this with a
temporary `ExecutionPlan = WorkflowSpec` type alias, flagged with a `TODO`
for when a real compiler exists (tasks 5.2/5.10). At that point:

- `ExecutionPlan` should become its own type, distinct from `WorkflowSpec`,
  living in a **new `execution-plan/` module** that `engine/` depends on.
- Nothing moves out of `workflow-spec/`: the grammar types, the JSON
  Schema, `validate()`, and `workflowSpecVersion` are all authoring-side
  and are what the compiler reads. That is why the module is named after
  the workflow-spec, not the plan (see ADR-0003's naming note).
- `execution-plan/` imports the shared grammar types
  (`Binding`/`Step`/`Node`/...) from `workflow-spec/`'s barrel rather than
  duplicating them - ADR-0003's "one type universe, one validator".
- Execution-plan versioning becomes its own, separate concern from
  `workflowSpecVersion` - not necessarily bumped in lockstep with it (see
  design.md D11's terminology-amendment note).

## "IR"

Short for "intermediate representation" - the term this codebase originally
used for what is now split into **workflow-spec** and **execution plan**
above (see `docs/adr/0003-execution-plan-is-the-system-spine.md`, itself
renamed from "the IR is the system spine"). It was retired because:

- The artifact it named already had a better name (`WorkflowSpec`) for the
  authored side.
- "Intermediate representation" implies a transient compiler middle-end,
  but this artifact is durable, stored, versioned, and forkable - the
  opposite of transient.
- It didn't distinguish the authored document from the compiled one, which
  is exactly the distinction that matters once a real `dsl-compiler/`
  exists.

The module `src/workflow-spec/` (formerly `src/ir/`; `execution-plan/`
will be a separate, additional module once the compiler exists), the schema field
`workflowSpecVersion` (formerly `irVersion`), and the constant
`CURRENT_WORKFLOW_SPEC_VERSION` (formerly `CURRENT_IR_VERSION`) are the
renamed artifacts. Historical documents under `archive/` and past FINDINGS
files still use "IR" and are left as-is - they are a record of what was
written at the time, not the current source of truth.

## run

One execution of an execution plan - a row in `workflow_runs`
(`src/core/database/schema.sql`), tracked via `executions`/`checkpoints`.

## compose vs. nest

Two previously-conflated concerns, split by design.md D9:

- **Compose**: building a *workflow* out of steps over service
  functionality. A workflow-writer activity; the workflow-spec is stored
  in the **workflow-spec store** (D13), never a registry entry.
- **Nest**: a *service function*, while executing, invoking *other*
  registered services from inside its own container code. A
  service-author-declared possibility, recorded in the registry as
  `nesting_declaration` (D12).

## service image / registry entry

A **service image** is a dockerized, stateless-function service (REST API
+ CLI), discoverable via OpenAPI. A **registry entry** is the service
registry's metadata for one service image (capability declarations,
nesting declarations, trust tier) - registry entries are service images
only; a workflow-spec is never a registry entry (design.md D9a/D12).

## workflow-spec store

First-party storage for workflow-specs, distinct from the service
registry: namespaced URN identity + immutable version, exposing a derived
signature for discovery, reuse by **fork** (a self-contained copy with an
immutable lineage pin), never a live reference (design.md D13).
