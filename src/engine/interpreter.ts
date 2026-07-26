import type { CoreRepos, WorkflowRun, WorkflowRunStatus } from "../core/index.js";
import { ERROR_IDS, FatalError, logger } from "../shared/index.js";
import type { Step, WorkflowSpec } from "../workflow-spec/index.js";
import type { BindingContext } from "./bindings.js";
import { resolveBinding } from "./bindings.js";
import { completeExecution } from "./claim-complete.js";
import { computeStepDependencies } from "./dependency-graph.js";

// Task 6.2a (docs/impl-plans/0006-interpreter-plain-steps.md), design.md
// D8/D6. Promoted-by-rewrite from archive/spikes/1.5-ir-interpreter/'s
// already-proven pattern - the generic dependency-graph interpreter for a
// WorkflowSpec whose `steps` are all plain Step nodes (no branch/map,
// task 6.2b). Composes 0001's claimExecution/completeExecution primitives
// unmodified; never opens its own connection (ADR-0002/ADR-0007).

const LOG_EVENT_SUBMIT_RUN = "engine.submitRun";
const LOG_EVENT_COMPLETE_STEP = "engine.completeStep";

/** Rejects (FatalError ENGINE_UNSUPPORTED_NODE_KIND) if any top-level
 * node has a `kind` (branch/map) - 6.2a's explicit scope boundary,
 * task 6.2b's job. Local-review fix: also rejects (FatalError
 * ENGINE_DUPLICATE_NODE_ID) a spec with a repeated top-level node id -
 * neither the workflow-spec JSON Schema nor `executions` enforces this,
 * and a
 * duplicate id previously let a run be marked `done` as soon as ONE of
 * the two same-id executions completed, while the other kept running
 * against an already-"done" run. */
function assertPlainSteps(spec: WorkflowSpec): Step[] {
  const seenIds = new Set<string>();
  return spec.steps.map((node) => {
    if ("kind" in node) {
      throw new FatalError(ERROR_IDS.ENGINE_UNSUPPORTED_NODE_KIND, {
        context: { nodeId: node.id, kind: node.kind },
      });
    }
    if (seenIds.has(node.id)) {
      throw new FatalError(ERROR_IDS.ENGINE_DUPLICATE_NODE_ID, { context: { nodeId: node.id } });
    }
    seenIds.add(node.id);
    return node;
  });
}

function findStepNode(steps: Step[], nodeId: string): Step {
  const step = steps.find((s) => s.id === nodeId);
  if (!step) {
    throw new FatalError(ERROR_IDS.ENGINE_NODE_NOT_FOUND, { context: { nodeId } });
  }
  return step;
}

/** One transaction: inserts the `workflow_runs` row, then one
 * `executions` row per top-level step - `queued` if it has no unmet
 * dependency, `blocked` otherwise - checked directly against `spec`
 * before any worker has run, per spike 1.5's own verified property.
 * Local-review fix: a spec with zero top-level steps (schema-valid - no
 * `minItems` on the top-level `steps` array) is marked `done` immediately
 * rather than left permanently `running` with nothing left to complete
 * it. */
export async function submitRun(
  repos: CoreRepos,
  spec: WorkflowSpec,
  input: Record<string, unknown>,
  opts: { sessionId?: string } = {},
): Promise<WorkflowRun> {
  const steps = assertPlainSteps(spec);

  const run = await repos.workflowRuns.create({
    sessionId: opts.sessionId ?? null,
    spec,
    input,
  });

  if (steps.length === 0) {
    await repos.workflowRuns.markDone(run.id);
    logger.debug({ runId: run.id, stepCount: 0 }, LOG_EVENT_SUBMIT_RUN);
    return { ...run, status: "done" };
  }

  // No real session exists for a workflow run submitted without one -
  // `executions.session_id` is NOT NULL, so a synthetic, run-scoped label
  // is used instead of forcing every caller to invent one.
  const sessionId = opts.sessionId ?? `workflow-run:${run.id}`;

  for (const step of steps) {
    const deps = computeStepDependencies(step);
    await repos.executions.enqueueForRun({
      runId: run.id,
      nodeId: step.id,
      input: {},
      status: deps.length === 0 ? "queued" : "blocked",
      sessionId,
    });
  }

  logger.debug({ runId: run.id, stepCount: steps.length }, LOG_EVENT_SUBMIT_RUN);
  return run;
}

/** Re-checks every still-blocked top-level node against the run's spec
 * plus the given, already-fetched set of completed node ids; promotes
 * any now-fully-satisfied node to `queued`. Called by completeStep in
 * the SAME transaction as the write that satisfied the dependency, and
 * AFTER completeStep has taken the per-run lock (see completeStep's own
 * comment) - `completedIds` is a parameter, not fetched here, so the one
 * query backing it is shared with completeStep's own run-completion
 * check rather than issued twice. */
export async function promoteReadyNodes(
  repos: CoreRepos,
  run: WorkflowRun,
  completedIds: ReadonlySet<string>,
): Promise<void> {
  const steps = assertPlainSteps(run.spec as WorkflowSpec);

  for (const step of steps) {
    if (completedIds.has(step.id)) continue;
    const deps = computeStepDependencies(step);
    if (deps.every((id) => completedIds.has(id))) {
      await repos.executions.promoteBlockedToQueued(run.id, step.id);
    }
  }
}

/** Resolves one step's `reads` bindings against the run's request input
 * plus its already-completed dependencies' recorded outputs. The caller
 * (a future apps/worker) resolves reads, dispatches to a real service,
 * then calls completeStep with the result. */
export async function resolveStepReads(
  repos: CoreRepos,
  run: WorkflowRun,
  node: Step,
): Promise<Record<string, unknown>> {
  const deps = computeStepDependencies(node);
  const nodeOutputs: Record<string, Record<string, unknown>> = {};
  for (const depId of deps) {
    const recorded = await repos.runNodeOutputs.get(run.id, depId);
    if (recorded) nodeOutputs[depId] = recorded.output as Record<string, unknown>;
  }

  const ctx: BindingContext = { input: run.input as Record<string, unknown>, nodeOutputs };
  return Object.fromEntries(
    Object.entries(node.reads ?? {}).map(([key, binding]) => [key, resolveBinding(binding, ctx)]),
  );
}

/** Composes completeExecution (0001) + RunNodeOutputsRepo.record +
 * promoteReadyNodes + (if this was the run's last node) markDone, all on
 * the caller's transaction.
 *
 * Local-review fix: takes a `FOR UPDATE` lock on the run's own
 * `workflow_runs` row FIRST, before reading `run_node_outputs`. Without
 * this, two sibling dependencies of the same downstream node (or a run's
 * last two nodes) completed by two genuinely concurrent transactions
 * could each read `run_node_outputs` before the other commits - neither
 * transaction would ever observe both outputs, so the downstream node
 * (or the run itself) would never get promoted/marked done. The lock
 * serializes completions per run (never across different runs), which is
 * the same "same-session-serializes" posture `session/appendEntry` and
 * `signal_wait()` already use elsewhere in this codebase for an
 * analogous same-key race. */
export async function completeStep(
  repos: CoreRepos,
  params: {
    run: WorkflowRun;
    executionId: number;
    nodeId: string;
    output: Record<string, unknown>;
  },
): Promise<void> {
  const { run, executionId, nodeId, output } = params;

  await repos.workflowRuns.lockForUpdate(run.id);

  await completeExecution(repos, { executionId, stepId: nodeId, output });
  await repos.runNodeOutputs.record(run.id, nodeId, output);

  const completedIds = new Set(await repos.runNodeOutputs.listCompletedNodeIds(run.id));
  await promoteReadyNodes(repos, run, completedIds);

  const steps = assertPlainSteps(run.spec as WorkflowSpec);
  if (steps.every((step) => completedIds.has(step.id))) {
    await repos.workflowRuns.markDone(run.id);
  }

  logger.debug({ runId: run.id, nodeId }, LOG_EVENT_COMPLETE_STEP);
}

/** Finds a run's own top-level node by id - the counterpart a future
 * apps/worker uses after claiming an execution (execution.step IS the
 * node id, see core/database/schema.sql's own comment on
 * executions.run_id) to look up what to actually dispatch. */
export function findRunStepNode(run: WorkflowRun, nodeId: string): Step {
  const steps = assertPlainSteps(run.spec as WorkflowSpec);
  return findStepNode(steps, nodeId);
}

/** Resolves `spec.outputs` (only once the run is `done`) the same way a
 * step's own `reads` are resolved - the workflow's final result. */
export async function getRunResult(
  repos: CoreRepos,
  run: WorkflowRun,
): Promise<{ status: WorkflowRunStatus; outputs?: Record<string, unknown> }> {
  const fresh = await repos.workflowRuns.findById(run.id);
  if (!fresh) {
    throw new FatalError(ERROR_IDS.ENGINE_RUN_NOT_FOUND, { context: { runId: run.id } });
  }
  if (fresh.status !== "done") {
    return { status: fresh.status };
  }

  const spec = fresh.spec as WorkflowSpec;
  const completedIds = await repos.runNodeOutputs.listCompletedNodeIds(fresh.id);
  const nodeOutputs: Record<string, Record<string, unknown>> = {};
  for (const nodeId of completedIds) {
    const recorded = await repos.runNodeOutputs.get(fresh.id, nodeId);
    if (recorded) nodeOutputs[nodeId] = recorded.output as Record<string, unknown>;
  }

  const ctx: BindingContext = { input: fresh.input as Record<string, unknown>, nodeOutputs };
  const outputs = Object.fromEntries(
    Object.entries(spec.outputs ?? {}).map(([key, binding]) => [key, resolveBinding(binding, ctx)]),
  );
  return { status: fresh.status, outputs };
}
