# 0006: Execution interpreter - plain-step dependency-graph execution

## Status

`reviewed`

## Scope

This package is the first real (non-spike) implementation of `engine/`'s
generic IR interpreter (task 6.2) - the piece that actually ties together
everything the four prior packages built: `ir/` (0004, the WorkflowSpec/
Node/Binding types), `core/`'s `executions`/`checkpoints` durability layer
(0001), durable sleep (0002, not exercised here but sharing the same
`executions` table), and the composable `claimExecution`/`completeExecution`
primitives (0001's `engine/claim-complete.ts`).

Task 6.2 as written ("a generic execution-engine interpreter that executes
a compiled workflow-spec") is bigger than one buildable slice - it
implicitly bundles plain steps, `branch`, `map`, and every binding kind
(including ones whose backing infrastructure - session materialization
3.2-3.9, the dataset catalog 5.6d, item-pool 12.x - doesn't exist yet).
Per spike 1.5's own verdict ("this is the concrete basis 6.2 can build
from") and mirroring how 6.1 was split into 6.1a/6.1b and 1.10/4.1-4.7 was
split via 4.1a, this package splits 6.2 into two buildable pieces:

**New task items covered/added (mirrors the 6.1a/6.1b and 4.1a split
pattern):**

- **6.2a NEW (split from 6.2, this package):** a generic dependency-graph
  interpreter for a `WorkflowSpec` whose `steps` are all plain `Step`
  nodes (no `branch`/`map`) - dependency inference from `{from:"step"}`
  bindings plus the `dependsOn` escape hatch (5.6, for the plain-step
  case), binding resolution for `request`/`step`/`literal` kinds only
  (5.4, partial), and run-to-completion with resolved top-level `outputs`.
  Step dispatch itself is via an injected `StepDispatcher` function - real
  service dispatch (6.3/6.4/6.12-6.15) is a separate, not-yet-built
  concern this package deliberately stubs, exactly as spike 1.5's
  `functions.js` did.
- **6.2b NEW (split from 6.2, deferred, not built here):** `branch` (5.7)
  and `map`/`forEach` (5.8, 6.9) nodes, multi-step nesting inside case/map
  bodies, and `session`/`static`/`item`/`compute`/`itemResource` binding
  resolution (the remainder of 5.4, plus 5.12/5.15/5.16) - each of these
  needs infrastructure this package doesn't have yet (session
  materialization, the dataset catalog, item-pool, or 5.11's still-open
  JSON-Logic-vs-CEL decision). Left `[ ]`, annotated with a pointer to
  this package as the now-ready dependency-promotion/binding-resolution
  mechanism, mirroring 0005's treatment of 4.1-4.7.

**What this package does NOT close out, and leaves `[ ]` on purpose:**

- **5.6** (dependency-graph inference) - covered only for the plain-step
  case; `branch`/`map`'s own dependency rules (D8c: a case's/body's
  internal step ids are unreachable from outside the node) are 6.2b's job.
- **5.4** (data-binding syntax for user/static/session references) -
  `request`/`step`/`literal` only; `session`/`static`/`item`/`itemResource`
  binding kinds are recognized by `ir/`'s types (already done, 0004) but
  resolveBinding throws a clear, explicit "not supported yet" error for
  them here - exactly spike 1.5's own posture for the same gap.
- **5.12** (compute binding evaluation) - deliberately not attempted;
  5.11's JSON-Logic-vs-CEL choice is still open, and a `compute` binding
  is never resolvable by this package's `resolveBinding` (explicit error,
  not silent misbehavior).
- **6.3/6.4/6.9/6.12-6.15** (real step dispatch, map fan-out) - untouched;
  this package's `StepDispatcher` is an injected function, not a real
  exec-agent RPC call.

## Sources

- **design.md D8** (steps/bindings/write targets/outputs, engine-agnostic)
  and **D8a** (`dependsOn` as an explicit ordering escape hatch for steps
  with no data dependency) - the two decisions this package's dependency
  inference implements for the plain-step case.
- **design.md D8c** ("a case's/body's internal step ids are unreachable
  from outside that node") - not exercised directly here (no branch/map
  yet), but the reason `run_node_outputs` (below) is scoped to
  **top-level** node ids only, from the start, so 6.2b's eventual
  branch/map support slots into an already-correctly-shaped table rather
  than requiring a later migration.
- **design.md D6** ("THE PATTERN") - this package is 0001-0003's
  `executions`/`checkpoints`/`claim_execution()` primitive, composed by a
  new layer, not a new dispatch mechanism. `claimExecution`/
  `completeExecution` (0001, `engine/claim-complete.ts`) are reused
  as-is, not re-implemented.
- **`archive/spikes/1.5-ir-interpreter/FINDINGS.md`** (task 1.5's
  deliverable, 14/14 assertions passing) - the actual starting point,
  promoted-by-rewrite (not a verbatim port, per ADR-0001 decision 5) into
  current conventions, exactly the relationship 0001 had to spike 1.2 and
  0005 had to `archive/placement-resolver/`. Its four proven properties
  (dependency ordering enforced from DB state alone; branch-case
  exclusivity; ordered map-join under concurrency; cross-node binding
  resolution) are the correctness bar this package re-verifies for the
  plain-step subset it covers (the first two properties apply directly;
  the latter two are branch/map-specific and deferred to 6.2b).
- **ADR-0002** (`core/` owns the consolidated schema) - `workflow_runs`
  and `run_node_outputs` are new `core/`-owned tables, not an `engine/`-
  owned store; `engine/` continues to never open its own connection.
- **ADR-0007** (module inventory) - `engine/` "depends on `core/`, `ir/`"
  and is "the durable-exec interpreter" - this package is the first code
  to actually exercise that dependency edge (0001/0002 built `engine/`'s
  primitives without needing `ir/` at all; this package is where `ir/`'s
  types are first imported by `engine/`).
- **ADR-0012** (module-internal structure) - `engine/`'s existing flat
  shape (`claim-complete.ts`, `wait.ts`, no `domain/`/`database/`, since
  it owns no schema) is preserved; new `core/` tables get the standard
  `database/`+`domain/`+`repositories/`+`repositories/queries/` shape.

**Open questions these sources leave unresolved, resolved here as a call
this package makes:**

- **Where does a submitted run's IR document live - inline on the run
  row, or referenced by id into `workflow-store/` (task 11.x)?** Resolved:
  **inline** (`workflow_runs.spec`, JSONB). `workflow-store/` (URN
  identity, fork, versioning) doesn't exist yet, and `engine/`'s ADR-0007
  dependency edge is `ir/`, not `workflow-store/` - a run is submitted
  with an already-resolved `WorkflowSpec` value, exactly as spike 1.5 and
  the generic-interpreter framing in D8 assume. `core/domain/
  workflow-run.ts` types `spec` as `unknown` (not `WorkflowSpec`), the
  same "cast, not validated" posture `mapPlacementConfigRow` already uses
  for `placement_config.config` - keeping `core/` from depending on `ir/`
  (ADR-0007's dependency direction: `core/` sits below `engine/`, which is
  the one that depends on `ir/`, not the other way around). `engine/`
  casts after the fact, on the understanding that `ir/validate.ts` (0004)
  has already validated the document before `submitRun` is ever called -
  `submitRun` itself does not re-invoke `validate()`.
- **How does a downstream node discover an upstream node's output across
  node boundaries - a dedicated table, or reuse `checkpoints`?** Resolved:
  a **dedicated `run_node_outputs` table**, promoted from spike 1.5's own
  `run_node_outputs`, kept deliberately separate from `checkpoints`.
  `checkpoints` is keyed by `(execution_id, step_id)` - an execution-
  lease-cycle-scoped idempotency record, not something naturally queryable
  by "which top-level node ids has this **run** completed" (the question
  dependency-promotion actually needs answered). Reusing `checkpoints` for
  that would require joining through `executions.run_id`/`step` on every
  promotion check; a dedicated `(run_id, node_id)`-keyed table answers it
  directly, and - per D8c - is the table 6.2b's eventual branch/map
  support must scope to top-level node ids only anyway, so building it
  that way now avoids a later migration.
- **Does a `blocked` execution row exist before its dependencies are met,
  or is it only inserted once ready?** Resolved: **exists from
  submission**, `status='blocked'`, matching spike 1.5's own verified
  property ("before any worker has run, the final step is already
  `blocked` in the database... checked directly against stored execution
  rows, not inferred from timing"). This requires widening `executions`'
  existing `status` CHECK constraint to add `'blocked'` (mirrors 0002's
  own precedent of widening the same constraint to add `'waiting'`, via
  the same idempotent `DROP CONSTRAINT IF EXISTS` + re-`ADD CONSTRAINT`
  pattern `schema.sql` already uses).
- **Does dependency inference walk `reads` generically (any binding shape
  that might contain a nested `{from:"step"}` reference), even for
  binding kinds this package's `resolveBinding` can't actually resolve
  yet (e.g. a `compute` binding's `using` map)?** Resolved: **yes,
  generically** - `collectStepBindingIds` walks any `Binding` value for a
  nested `StepBinding` (including one nested inside a `ComputeBinding`'s
  `using`), independent of whether that binding kind is resolvable at
  execution time. This mirrors spike 1.5's own stated design ("a generic
  walk for `{from:"step", id}` references") and keeps dependency inference
  decoupled from binding-resolution capability - a step whose `reads`
  happens to contain an (as-yet-unsupported) `compute` binding still gets
  correctly ordered relative to its dependencies at submission time, and
  only fails, with a clear error, if and when the interpreter actually
  tries to resolve that specific binding at execution time.
- **Reuse the existing `executions.step` column as the node id, or add a
  new column?** Resolved: **reuse `step`**. It is already a free-text
  label with no FK/enum constraint, exactly what a `WorkflowSpec` node's
  `id` is; adding a second, redundant `node_id` column purely for
  workflow-run executions would duplicate the same value under two names
  depending on which repository call created the row.

## Plan

### File/module layout

```
src/core/
  database/
    schema.sql                            (extended) workflow_runs,
                                           run_node_outputs tables;
                                           executions gains run_id
                                           (nullable FK) + 'blocked' status
  domain/
    workflow-run.ts                       (new) WorkflowRun domain type
                                           (spec: unknown - see Open
                                           questions)
    run-node-output.ts                    (new) RunNodeOutput domain type
    execution.ts                          (extended) Execution gains
                                           `runId: number | null`
    rows.ts                               (extended) WorkflowRunRow,
                                           RunNodeOutputRow; ExecutionRow
                                           gains run_id
    mappers.ts                            (extended) mapWorkflowRunRow,
                                           mapRunNodeOutputRow
    index.ts                              (extended barrel)
  repositories/
    workflow-runs.repository.ts           (new) WorkflowRunsRepo: create,
                                           findById, markDone, markFailed
    run-node-outputs.repository.ts        (new) RunNodeOutputsRepo:
                                           record, get, listCompletedNodeIds
    executions.repository.ts              (extended) enqueueForRun,
                                           promoteBlockedToQueued
    queries/
      workflow-runs.queries.ts            (new) SQL_* constants
      run-node-outputs.queries.ts         (new)
      executions.queries.ts               (extended) SQL_ENQUEUE_EXECUTION_
                                           FOR_RUN, SQL_PROMOTE_BLOCKED_
                                           TO_QUEUED
  database/transactions.ts                (extended) CoreRepos gains
                                           workflowRuns, runNodeOutputs
  index.ts                                (extended barrel)

src/engine/
  index.ts                                (extended barrel)
  dependency-graph.ts                     (new) pure: collectStepBindingIds,
                                           computeStepDependencies
  bindings.ts                             (new) resolveBinding (throws for
                                           unsupported kinds)
  interpreter.ts                          (new) submitRun, promoteReadyNodes,
                                           completeStep, getRunResult

test/
  core/database/schema.test.ts            (extended) workflow_runs/
                                           run_node_outputs/blocked-status/
                                           run_id structural assertions
  core/repositories/workflow-runs.repository.test.ts       (new)
  core/repositories/run-node-outputs.repository.test.ts    (new)
  engine/dependency-graph.test.ts         (new)
  engine/bindings.test.ts                 (new)
  engine/interpreter.test.ts              (new) - ports spike 1.5's
                                           dependency-ordering-from-DB-state
                                           property for the plain-step case
```

### Interfaces (signatures)

```ts
// src/core/domain/workflow-run.ts
export type WorkflowRunStatus = "running" | "done" | "failed";
export interface WorkflowRun {
  id: number;
  sessionId: string | null;
  /** Cast, not validated, by core/ - see Scope's "Open questions".
   * ir/validate.ts already validated this document before submitRun was
   * called; core/ does not depend on ir/ (ADR-0007). */
  spec: unknown;
  input: unknown;
  status: WorkflowRunStatus;
  createdAt: Date;
  updatedAt: Date;
}

// src/core/domain/run-node-output.ts
export interface RunNodeOutput {
  runId: number;
  nodeId: string;
  output: unknown;
  completedAt: Date;
}

// src/core/domain/execution.ts (extended)
export interface Execution {
  // ...existing fields unchanged...
  runId: number | null;
}
export type ExecutionStatus = "blocked" | "queued" | "running" | "waiting" | "done" | "failed";

// src/core/repositories/workflow-runs.repository.ts
export interface WorkflowRunsRepo {
  create(input: { sessionId?: string | null; spec: unknown; input: unknown }): Promise<WorkflowRun>;
  findById(id: number): Promise<WorkflowRun | null>;
  markDone(id: number): Promise<void>;
  markFailed(id: number): Promise<void>;
}

// src/core/repositories/run-node-outputs.repository.ts
export interface RunNodeOutputsRepo {
  record(runId: number, nodeId: string, output: unknown): Promise<RunNodeOutput>;
  get(runId: number, nodeId: string): Promise<RunNodeOutput | null>;
  listCompletedNodeIds(runId: number): Promise<string[]>;
}

// src/core/repositories/executions.repository.ts (extended)
export interface ExecutionsRepo {
  // ...existing methods unchanged...
  enqueueForRun(input: {
    runId: number;
    nodeId: string;
    input: unknown;
    status: "blocked" | "queued";
  }): Promise<Execution>;
  // Idempotent no-op if the row is already queued/running/done (mirrors
  // markDone's existing idempotency posture) - promotion may be attempted
  // more than once if multiple sibling completions race to satisfy the
  // same downstream node's last remaining dependency.
  promoteBlockedToQueued(runId: number, nodeId: string): Promise<void>;
}

// src/engine/dependency-graph.ts (pure, no I/O)
import type { Binding, Step } from "../ir/index.js";
/** Generic walk for a nested {from:"step", id} reference - independent of
 * whether that binding kind is resolvable yet (see Scope's Open
 * questions). */
export function collectStepBindingIds(binding: Binding): string[];
/** Union of dependsOn (D8a's explicit escape hatch) and every StepBinding
 * id found (possibly nested) in `reads`. */
export function computeStepDependencies(step: Step): string[];

// src/engine/bindings.ts
import type { Binding } from "../ir/index.js";
export interface BindingContext {
  input: Record<string, unknown>;
  /** Already-resolved outputs of this step's dependencies only - the
   * caller (interpreter.ts) is responsible for having fetched exactly the
   * ids computeStepDependencies named, per D8c's "internal-step-ids-are-
   * unreachable" boundary (not relevant yet with no branch/map, but this
   * keeps the shape 6.2b-ready). */
  nodeOutputs: Record<string, Record<string, unknown>>;
}
/** Resolves request/step/literal bindings. Throws FatalError
 * (ENGINE_BINDING_KIND_NOT_SUPPORTED) for session/static/item/compute/
 * itemResource - explicit scope limit, not silent misbehavior (mirrors
 * spike 1.5's own "unbound binding path throws loudly" finding). */
export function resolveBinding(binding: Binding, ctx: BindingContext): unknown;

// src/engine/interpreter.ts
import type { WorkflowSpec } from "../ir/index.js";
export type StepDispatcher = (params: {
  service: string;
  function: string;
  input: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

/** Rejects (FatalError ENGINE_UNSUPPORTED_NODE_KIND) if any top-level
 * node has a `kind` (branch/map) - 6.2a's explicit scope boundary. */
export function submitRun(
  repos: CoreRepos,
  spec: WorkflowSpec,
  input: Record<string, unknown>,
  opts?: { sessionId?: string },
): Promise<WorkflowRun>;

/** Re-checks every still-blocked top-level node against the run's spec +
 * currently-completed node ids; promotes any now-fully-satisfied node to
 * `queued`. Called by completeStep in the SAME transaction as the write
 * that satisfied the dependency (spike 1.5's own verified property). */
export function promoteReadyNodes(repos: CoreRepos, run: WorkflowRun): Promise<void>;

/** Composes completeExecution (0001) + RunNodeOutputsRepo.record +
 * promoteReadyNodes + (if this was the run's last node) markDone, all on
 * the caller's transaction. The one call site that dispatches to a real
 * service is `dispatch` - the only thing 6.3/6.4 will need to change. */
export async function completeStep(
  repos: CoreRepos,
  params: { run: WorkflowRun; executionId: number; nodeId: string; output: Record<string, unknown> },
): Promise<void>;

/** Resolves spec.outputs (if the run is done) the same way step `reads`
 * are resolved - the workflow's own final result. */
export function getRunResult(
  repos: CoreRepos,
  run: WorkflowRun,
): Promise<{ status: WorkflowRunStatus; outputs?: Record<string, unknown> }>;
```

### Data flow

```ts
import { withTransaction } from "../core/index.js";
import { claimExecution, completeStep, getRunResult, submitRun } from "../engine/index.js";

// 1. Submit: one transaction inserts workflow_runs + one executions row
//    per top-level Step (blocked or queued, decided by computeStepDependencies).
const run = await withTransaction(pool, (repos) => submitRun(repos, spec, input));

// 2. Worker loop (not apps/worker itself - deferred; exercised directly in
//    this package's tests as the loop a real apps/worker will later run):
await withTransaction(pool, async (repos) => {
  const execution = await claimExecution(repos, workerId); // 0001, reused as-is
  if (!execution || execution.runId == null) return; // not a workflow-run execution
  const run = await repos.workflowRuns.findById(execution.runId);
  const spec = run.spec as WorkflowSpec; // cast here, not in core/ - see Open questions
  const node = spec.steps.find((s) => s.id === execution.step);
  const completedIds = await repos.runNodeOutputs.listCompletedNodeIds(run.id);
  const nodeOutputs = /* fetch each dependency's recorded output */;
  const resolvedInput = Object.fromEntries(
    Object.entries(node.reads ?? {}).map(([key, binding]) => [
      key,
      resolveBinding(binding, { input: run.input, nodeOutputs }),
    ]),
  );
  const output = await dispatch({ service: node.service, function: node.function, input: resolvedInput });
  await completeStep(repos, { run, executionId: execution.id, nodeId: node.id, output });
});

// 3. Once done:
const result = await withTransaction(pool, (repos) => getRunResult(repos, run));
```

### Sequencing rationale

- **Why now:** this is the first package that composes `ir/` (0004) with
  `core/`+`engine/` (0001/0002/0005) - every prior package built one
  isolated piece of the D6 four-way consolidation story or the IR schema
  in isolation; nothing yet actually runs an IR document. Spike 1.5
  already proved the pattern works on this exact stack (the same
  `executions`/`checkpoints`/`claim_execution()` primitive), so this
  package is "promote spike 1.5 into current conventions," the same
  relationship every prior package had to its own spike.
- **What it depends on:** `ir/`'s `WorkflowSpec`/`Node`/`Binding` types and
  `Step`/`StepBinding`/`RequestBinding`/`LiteralBinding` specifically (0004,
  already built); `core/`'s `withTransaction`/`CoreRepos` shape and
  `executions`/`checkpoints` tables (0001, already built);
  `engine/claimExecution`/`completeExecution` (0001, reused unmodified).
  Nothing from `registry/`, `session/`'s materialization side, `scheduler/`,
  or `dataset-catalog/` is required - this package's scope is deliberately
  narrow enough to need only what already exists.
- **What it unblocks:** 6.2b (branch/map + the remaining binding kinds) has
  a real dependency-promotion mechanism and `run_node_outputs` table to
  extend rather than design from scratch; 6.3/6.4 (real step dispatch) has
  exactly one call site (`StepDispatcher`) to swap from a test stub to a
  real exec-agent RPC call, mirroring spike 1.5's own stated "the
  interpreter's one call site that would change" finding; a future
  `apps/worker` becomes "run the claim loop from the Data flow section
  above, forever" rather than a from-scratch design.
- **What it deliberately does NOT unblock yet:** any end-to-end test
  requiring real service dispatch (8.x), branch/map (5.7/5.8/6.9), or a
  real `apps/worker` process (still not built) - all remain future
  packages.

## Test design

Not collapsed with Phase 1 - this package extends `core/`'s consolidated
schema (foundational, per every prior package's own precedent) and
introduces a new correctness property (dependency-graph promotion) as
committed code for the first time.

### Setup: default Vitest + testcontainers-node is sufficient

Every property below depends on real Postgres semantics (`FOR UPDATE SKIP
LOCKED` claim ordering, transactional atomicity, a real crash boundary via
`pg_terminate_backend`) - the same class of test 0001-0003 already ran
successfully. The crash test (TC-7) is not a *new* setup requirement: it
reuses the exact `pg_terminate_backend`-mid-transaction pattern 0001/0002/
0003 already established within the default testcontainers-node setup, it
does not introduce new infrastructure. No load/scale test is warranted -
this package's claim/promotion path is the same `claim_execution()`
primitive spike 1.2e already load-tested; nothing here changes its
concurrency shape, only what happens with the row once claimed.

### Test cases

| # | Test | Scope item | Correctness property verified |
|---|---|---|---|
| TC-1 | Apply `schema.sql` fresh; assert `workflow_runs`/`run_node_outputs` tables exist, `run_node_outputs`'s `(run_id, node_id)` UNIQUE constraint, `executions` has a `run_id` column (nullable FK) and its status CHECK now includes `'blocked'` | 6.2a schema | ADR-0002 - structural precondition |
| TC-2 | `submitRun` on a 3-node spec (A: no deps; B: `reads` contains `{from:"step",id:"A",output:"x"}`; C: `dependsOn:["A"]` plus a `{from:"step",id:"B"}` read) creates three `executions` rows: A `queued`, B and C `blocked` - asserted directly against stored rows, **before any claim has happened** | 6.2a `submitRun`, 5.6 (plain-step case) | design.md D8/D8a; spike 1.5's own verified property #1 ("dependency ordering is enforced from DB state alone... before any worker has run") |
| TC-3 | Claim and `completeStep` node A inside one transaction; within that SAME transaction, B (which depended only on A) is now `queued` while C (which also depends on B) is still `blocked` | 6.2a `promoteReadyNodes`/`completeStep` | spike 1.5's property: promotion happens "in the same transaction as the write that satisfies it" |
| TC-4 | Full run to completion: 3 concurrent claimers repeatedly call `claimExecution`+`completeStep` against the TC-2 spec with a stub `StepDispatcher`; final `workflow_runs.status` is `done`, and `getRunResult` resolves `outputs` (a mix of `{from:"step"}` and `literal` bindings) to hand-computed expected values | 6.2a `completeStep` (run-completion + `getRunResult`), 5.4 (request/step/literal resolution) | design.md D8 end-to-end; spike 1.5's cross-node binding resolution property, now via committed code and genuine concurrency (not sequential) |
| TC-5 | `resolveBinding` throws `FatalError` with `errorId` `ENGINE_BINDING_KIND_NOT_SUPPORTED` for each of `session`/`static`/`item`/`compute`/`itemResource` binding kinds, never resolving to `undefined` | 6.2a `resolveBinding` explicit scope limit (5.4/5.12 deferred) | design.md D8/D10 by omission; mirrors spike 1.5's own finding that "the unbound binding path throws loudly instead of resolving to undefined" |
| TC-6 | `submitRun` on a spec containing one `branch`-kind top-level node throws `FatalError` with `errorId` `ENGINE_UNSUPPORTED_NODE_KIND`, and inserts no `executions`/`workflow_runs` rows (rolled back, not partially committed) | 6.2a/6.2b scope boundary | this package's own explicit split - 6.2b's node kinds must fail closed, not silently execute as if they were plain steps |
| TC-7 | Kill the connection (`pg_terminate_backend`) mid-transaction inside `completeStep` (after the checkpoint write, before commit); on reconnect, no `run_node_outputs` row, no promoted sibling, and the execution itself is still `running` with an expired lease (reclaimable by the next `claimExecution`) | 6.2a `completeStep` atomicity | design.md D6 - the DEEP-consolidation crash guarantee (0001/0002/0003's own crash-test pattern), now covering the workflow-run bookkeeping this package adds as a fourth write joining checkpoint+execution-status in the same transaction |
| TC-8 | `computeStepDependencies` on a step with `dependsOn:["X"]` AND a `reads` binding containing `{from:"step",id:"Y"}` nested inside a `compute` binding's `using` map returns `["X","Y"]` (both, deduplicated) | 6.2a `computeStepDependencies`/`collectStepBindingIds` | design.md D8a (explicit `dependsOn` escape hatch) + this package's "generic walk, independent of resolvability" call in Scope's Open questions |

TC-1, TC-7 live under `test/core/database/schema.test.ts` and
`test/engine/interpreter.test.ts` respectively (real Postgres,
testcontainers); TC-2/TC-3/TC-4/TC-6 live under
`test/engine/interpreter.test.ts` (real Postgres - dependency promotion
and run-completion are transaction-scoped properties, same posture as
0001/0003's decision-shaped tests); TC-5 lives under
`test/engine/bindings.test.ts` (plain Vitest, no Postgres needed - a pure
function); TC-8 lives under `test/engine/dependency-graph.test.ts` (plain
Vitest, no Postgres needed - a pure function).

## Implementation notes

Built exactly as planned - no interface/behavior deviation from the
agreed plan. `core/database/schema.sql` gained `workflow_runs`/
`run_node_outputs` (public schema, `run_node_outputs` scoped to top-level
node ids only per D8c), `executions.status`'s CHECK widened to add
`'blocked'`, and a new nullable `executions.run_id` column with its FK
constraint added once `workflow_runs` exists (mirroring 0002's own
`ADD COLUMN IF NOT EXISTS`/drop-and-re-add-constraint idempotency
pattern). `core/domain/{workflow-run,run-node-output}.ts` (`spec`/`input`/
`output` typed `unknown` - `core/` does not depend on `ir/`, per ADR-0007)
+ `rows.ts`/`mappers.ts` extensions; `Execution` gained `runId`.
`core/repositories/{workflow-runs,run-node-outputs}.repository.ts` +
their `queries/*.queries.ts` files, plus `executions.repository.ts`'s new
`enqueueForRun`/`promoteBlockedToQueued`, all following ADR-0012's shape.
`CoreRepos` (`database/transactions.ts`) extended with `workflowRuns`/
`runNodeOutputs`; both barrels (`core/index.ts`) updated. The new
`engine/{dependency-graph,bindings,interpreter}.ts` files implement
`collectStepBindingIds`/`computeStepDependencies` (pure), `resolveBinding`
(request/step/literal only, explicit errors otherwise), and `submitRun`/
`promoteReadyNodes`/`completeStep`/`resolveStepReads`/`findRunStepNode`/
`getRunResult` - composing 0001's `claimExecution`/`completeExecution`
unmodified, exactly as planned.

- **Seven new `ERROR_IDS`** added to `shared/errors.ts`
  (`CORE_WORKFLOW_RUN_NO_ROW_RETURNED`, `CORE_RUN_NODE_OUTPUT_NO_ROW_RETURNED`,
  `ENGINE_UNSUPPORTED_NODE_KIND`, `ENGINE_RUN_NOT_FOUND`,
  `ENGINE_NODE_NOT_FOUND`, `ENGINE_BINDING_KIND_NOT_SUPPORTED`,
  `ENGINE_NODE_OUTPUT_MISSING`), following the existing structured-error/
  no-row-returned conventions.
- **No new environment variables** - verified by inspection
  (`grep -rn "process.env" src/engine src/core/repositories/
  {workflow-runs,run-node-outputs}.repository.ts src/core/domain/
  {workflow-run,run-node-output}.ts` returns no matches). `.example.env`
  needed no update.
- **`executions.session_id` stays `NOT NULL`, so `submitRun` synthesizes
  a `workflow-run:<runId>` label when no `sessionId` is supplied** -
  called out explicitly in `interpreter.ts`'s own comment, not a silent
  workaround; a real `apps/worker`/session integration would pass a real
  session id here once one exists.
- **`test/engine/interpreter.test.ts`'s TC-7 crash-test assertion was
  corrected during implementation** (not a plan/test-design change): the
  plan's Data flow section didn't spell out that the whole transaction -
  including the earlier `claimExecution` promotion to `running` - rolls
  back on a mid-transaction crash, not just `completeStep`'s own writes.
  The test initially asserted the execution would still read `running`
  after rollback; running it against a real Postgres instance showed it
  correctly reverts all the way to `queued`, matching
  `test/engine/claim-complete.test.ts`'s own existing crash-test
  precedent (which this package's TC-7 was explicitly modeled on).
  Corrected to match - the underlying atomicity property this test
  verifies is unchanged, only the test's own expected-value literal was
  wrong.
- Truncation statements in the three new/extended test files needed
  `CASCADE` (`TRUNCATE ... RESTART IDENTITY CASCADE`) once `executions`
  gained a real FK to `workflow_runs` - a mechanical fixture fix, not a
  behavior change.
- `npx tsc --noEmit`, `npx biome check .`, and `npx vitest run` all pass
  clean (164/164 tests across 26 files, up from 133 across 21) - the 31
  new tests are this package's schema extension (6) + `WorkflowRunsRepo`
  (3) + `RunNodeOutputsRepo` (4) + `engine/dependency-graph.ts` (5) +
  `engine/bindings.ts` (7, one `it.each` covering 5 unsupported binding
  kinds) + `engine/interpreter.ts` (5) - verified directly, not assumed.
  `biome check --write .` was run twice (once after the initial
  implementation pass, once after a later `sed`-driven test fixture edit)
  to fix purely mechanical formatting/import-order findings - no logic
  changed by either pass.

No follow-up tasks spun off beyond what Scope already named as explicitly
deferred (6.2b's branch/map + remaining binding kinds; 6.3/6.4's real
step dispatch) - both already tracked as their own `tasks.md` items by
this package's Scope section, not new discoveries.

## Review notes

Compared against the agreed plan (Phase 1) and agreed test design
(Phase 2), not a fresh read of the code in a vacuum:

- Every Scope item (new task 6.2a) is present: the generic dependency-
  graph interpreter for plain-`Step` `WorkflowSpec`s, dependency inference
  (`dependsOn` + inferred `{from:"step"}` refs), `request`/`step`/`literal`
  binding resolution, run-to-completion, and resolved top-level `outputs`
  - all re-exported through `core/index.ts`'s and `engine/index.ts`'s
    barrels. 6.2b's node kinds and remaining binding kinds are explicitly
    NOT implemented, matching the plan's own scope boundary.
- All 8 agreed test cases (TC-1 through TC-8) exist and pass -
  cross-checked against the Test design table's own scope/property
  mapping. Re-ran `npx tsc --noEmit`, `npx biome check .`, and `npx
  vitest run` immediately before writing this section: clean typecheck,
  clean lint, 164/164 tests passing across 26 files.
- The one deviation from the plan (TC-7's expected post-crash status
  literal) is recorded in Implementation notes with rationale; the
  correctness property TC-7 verifies (atomic rollback of checkpoint +
  run_node_outputs + promotion together) is unaffected and still fully
  verified - only the test's own expectation was corrected to match
  reality, not weakened.
- `core/` vs. `engine/` split matches ADR-0007/ADR-0012 exactly: `core/`
  owns only the new schema + thin repositories (no dependency-graph or
  binding-resolution logic leaked into `core/`); `engine/` owns all
  decision-shaped logic and never opens its own connection. `core/domain/
  workflow-run.ts`'s `spec: unknown` (cast, not validated, by `engine/`)
  keeps `core/` from depending on `ir/`, per ADR-0007's dependency
  direction - verified by inspection, no `ir/` import anywhere under
  `src/core/`.
- No SQL injection risk (every query is parameterized); every repository
  method that can fail to return a row throws a structured `FatalError`
  with a dedicated `errorId`, matching every other repository's existing
  convention; no magic numbers/strings introduced outside named
  constants; no env vars touched.
- No scope creep: 6.2b (branch/map, remaining binding kinds) and
  6.3/6.4/6.9/6.12-6.15 (real step dispatch) were not touched, consistent
  with the plan's explicit exclusions.
- `tasks.md` accurately reflects reality: 6.2 marked as split, new tasks
  6.2a marked `[x]` with a pointer to the real files/tests, 6.2b left
  `[ ]` with an inline note on exactly what mechanism this package now
  provides and what remains open.

**Post-review fixes** (from a `/local-review` pass over this package plus
the already-committed 0005 placement package, both on this branch - all
within this package's own agreed scope, no plan/test-design change):

- **Concurrent completion of two sibling dependencies of the same node
  (a diamond dependency shape) could permanently strand that node - and,
  if it was one of a run's last two nodes, the run itself - in
  `blocked`/`running`.** `promoteReadyNodes`'s and `completeStep`'s own
  completion check each read `run_node_outputs` under the caller's own
  transaction with no per-run serialization; two genuinely overlapping
  transactions each completing a different sibling never observed both
  outputs. Fixed by having `completeStep` take a `FOR UPDATE` lock on the
  run's own `workflow_runs` row (`WorkflowRunsRepo.lockForUpdate`, new)
  as its first statement, serializing completions per run (never across
  different runs) - the same posture `session/appendEntry` and
  `signal_wait()` already use for an analogous same-key race elsewhere in
  this codebase. Verified with a new test using two genuinely overlapping
  transactions (`test/engine/interpreter.test.ts`'s diamond-dependency
  test) that would hang/fail without the lock.
- **Duplicate top-level node ids were not rejected** - neither the IR
  JSON Schema nor `executions` enforces uniqueness, so a duplicate id let
  a run be marked `done` as soon as one of the two same-id executions
  completed, while the other kept running against an already-"done" run.
  Fixed by rejecting a repeated id in `assertPlainSteps` (new
  `ERROR_IDS.ENGINE_DUPLICATE_NODE_ID`).
- **A schema-valid zero-step spec (`steps: []` - the top-level array has
  no `minItems`, unlike nested case/map bodies) left its run permanently
  `running`**, since `markDone` was only ever reachable from
  `completeStep`. Fixed by having `submitRun` mark the run `done`
  immediately when `steps.length === 0`.
- **`collectStepBindingIds` didn't recurse into an `itemResource`
  binding's `itemId`** (itself a `Binding`, which can be `{from:"step"}`),
  despite the function's own "every... reference reachable from binding"
  contract - silently dropping that dependency from the graph. Fixed by
  adding the missing recursive case.
- **`executions_run_id_fkey` was unconditionally dropped and re-added
  (validated) on every `schema.sql` apply**, unlike the CHECK-constraint
  widening pattern it was modeled on - a FK's definition doesn't need
  re-widening the way a CHECK's does, so this repaid a full,
  `ACCESS EXCLUSIVE`-locked validation scan of `executions` for no reason
  on every apply against a database that may already hold real rows.
  Fixed: now guarded to add the constraint only once (`pg_constraint`
  existence check), and via `NOT VALID` + a separate `VALIDATE
  CONSTRAINT` (a much weaker `SHARE UPDATE EXCLUSIVE` lock) rather than a
  single validated `ADD CONSTRAINT`.
- **(0005 package) `evictLRUIfOverCapacity` could mass-demote the entire
  pinned set without reclaiming any capacity** when pinned entries have
  `sizeBytes <= 0` (the column's own default, and no current caller
  populates it) - demoting such an entry can never reduce `total`. Fixed
  by skipping (not demoting) entries with `sizeBytes <= 0` in the
  eviction loop.
- **(0005 package) `recordAccess`'s access-log prune horizon used only
  `promotion.frequencyWindowMs`**, while its own SQL query's comment
  states it should be "called with the widest configured window as the
  horizon" - a caller-supplied config with a wider promotion window than
  what an earlier `recordAccess` call pruned by could find its needed
  access rows already deleted. Fixed by pruning with
  `max(promotion.frequencyWindowMs, demotion.idleThresholdMs)`.
- **(0005 package) `DEFAULT_PLACEMENT_CONFIG` hand-duplicates the seeded
  SQL `placement_config` row with no test actually pinning the two
  together**, despite a comment implying one existed. Fixed by adding
  `test/scheduler/placement.test.ts`'s
  `"DEFAULT_PLACEMENT_CONFIG matches the seeded 'default' placement_config row"`.
- **`StepDispatcher` was exported with no implementor or reference
  anywhere in `src/`/`test/`.** Removed (from both `interpreter.ts` and
  the `engine/` barrel) until a real caller (a future worker) exists to
  reference it.

Re-ran `npx tsc --noEmit`, `npx biome check .`, and `npx vitest run`
after these fixes: clean typecheck, clean lint, 170/170 tests passing
across 26 files (up from 164 - six new tests: the diamond-dependency
concurrency test, duplicate-node-id rejection, zero-step-spec completion,
two `itemResource`/`collectStepBindingIds` cases, and the
`DEFAULT_PLACEMENT_CONFIG` pinning test).

No further follow-up issues found. Package considered complete for its
stated scope.
