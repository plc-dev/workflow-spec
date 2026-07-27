import type { Pool } from "pg";
import type { CoreRepos } from "../../core/index.js";
import { withTransaction } from "../../core/index.js";
import {
  claimExecution,
  completeStep,
  findRunStepNode,
  resolveStepReads,
} from "../../engine/index.js";
import { ERROR_IDS, FatalError, RetryableError, logger } from "../../shared/index.js";
import {
  LOG_EVENT_RUN_ONCE_DISPATCH,
  LOG_EVENT_RUN_ONCE_TERMINAL_FAILURE,
  LOG_EVENT_RUN_ONCE_TRANSIENT_FAILURE,
  LOG_EVENT_WORKER_LOOP_STOPPED,
  STDERR_LOG_EXCERPT_LENGTH,
} from "./constants.js";
import { dispatchStep } from "./dispatch.js";

// docs/impl-plans/0011-worker-cli-dispatch.md's Plan, "Worker loop" -
// generalizes test/dsl-compiler/compile.integration.test.ts's proven
// manual loop into a run-id-agnostic function: a real worker doesn't
// hold one WorkflowRun in memory across iterations, it re-fetches
// whichever run a freshly claimed execution belongs to.

export interface WorkerDeps {
  agentBaseUrl: string;
  workerId: string;
  leaseSeconds: number;
  invokeTimeoutMs: number;
  /** Sent as the agent's Authorization: Bearer header - see
   * agent-client.ts's own comment (local-review fix,
   * docs/impl-plans/0011-worker-cli-dispatch.md). */
  agentAuthToken?: string;
}

/** One claim -> dispatch -> complete/fail cycle, one transaction.
 * Returns false if there was nothing to claim, or if dispatch hit a
 * RetryableError (agent unreachable) that rolled the whole transaction
 * back - either way, the caller should sleep and try again. Never lets
 * an error escape - a single step's failure can't crash the loop. */
export async function runOnce(pool: Pool, deps: WorkerDeps): Promise<boolean> {
  try {
    return await withTransaction(pool, async (repos) => {
      const execution = await claimExecution(repos, deps.workerId, {
        leaseSeconds: deps.leaseSeconds,
      });
      if (!execution) return false;

      if (execution.runId == null) {
        // Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md):
        // this worker only knows how to process workflow-run executions
        // (submitRun/completeStep) - a non-run execution (e.g. one
        // inserted via ExecutionsRepo.enqueue, run_id NULL) was just
        // claimed (status -> running, lease held, attempts incremented)
        // but there is nothing this loop can do with it. Returning
        // `false` here would COMMIT that claim and then abandon the row
        // - it would sit `running` until lease expiry, get reclaimed,
        // and repeat forever, burning `attempts` with no progress.
        // Throwing instead rolls the claim back so the row reverts to
        // its pre-claim, reclaimable status (a different, run-aware
        // caller can pick it up; RetryableError is the correct
        // classification since nothing here indicates a genuine,
        // non-retryable problem with the row itself).
        throw new RetryableError(ERROR_IDS.WORKER_EXECUTION_MISSING_RUN, {
          context: { executionId: execution.id },
        });
      }

      const run = await repos.workflowRuns.findById(execution.runId);
      if (!run) {
        // Structurally impossible per executions_run_id_fkey (core/
        // database/schema.sql) - defensive only.
        throw new FatalError(ERROR_IDS.WORKER_EXECUTION_MISSING_RUN, {
          context: { executionId: execution.id, runId: execution.runId },
        });
      }

      // Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md):
      // findRunStepNode/resolveStepReads now share the SAME
      // classification as dispatchStep below (a single try spanning
      // both), rather than being able to throw a FatalError that
      // escapes uncaught and only rolls back - which previously left a
      // deterministic error (e.g. an unsupported binding kind) as an
      // infinite retry poison-pill: the claim would revert, the same
      // worker (or another) would reclaim it, and hit the identical
      // error again on every single poll, forever.
      try {
        const node = findRunStepNode(run, execution.step);
        const resolvedInput = await resolveStepReads(repos, run, node);

        const dispatchResult = await dispatchStep(
          deps.agentBaseUrl,
          {
            executionId: execution.id,
            step: node,
            resolvedInput,
            timeoutMs: deps.invokeTimeoutMs,
          },
          { authToken: deps.agentAuthToken },
        );

        if (!dispatchResult.ok) {
          // The agent ran the CLI; it exited nonzero or timed out - a
          // real, reported failure, not a transport problem. Terminal
          // for this package's scope (task 6.6's retry/backoff policy
          // is not built) - fail the run.
          logger.error(
            {
              executionId: execution.id,
              nodeId: node.id,
              status: dispatchResult.response.status,
              exitCode: dispatchResult.response.exitCode,
              // Local-review fix: never log the full stdout/stderr
              // verbatim (up to the agent's 8 MiB cap) at error level -
              // pino's redact config can't reach free-form subprocess
              // output, and a step's real stdout/stderr may echo
              // sensitive payload data. A short, explicitly-bounded
              // stderr excerpt is enough to triage without risking a
              // secret/PII leak into the log sink.
              stderrExcerpt: dispatchResult.response.stderr.slice(0, STDERR_LOG_EXCERPT_LENGTH),
            },
            LOG_EVENT_RUN_ONCE_TERMINAL_FAILURE,
          );
          await failRun(repos, run.id, execution.id);
          return true;
        }

        await completeStep(repos, {
          run,
          executionId: execution.id,
          nodeId: node.id,
          output: dispatchResult.output,
        });
        logger.debug({ executionId: execution.id, nodeId: node.id }, LOG_EVENT_RUN_ONCE_DISPATCH);
        return true;
      } catch (err) {
        if (err instanceof RetryableError) {
          logger.warn({ executionId: execution.id, err }, LOG_EVENT_RUN_ONCE_TRANSIENT_FAILURE);
          // Rethrow: withTransaction rolls back the WHOLE transaction,
          // including the claim itself - the execution reverts to its
          // pre-claim, reclaimable status. At-least-once, no backoff
          // (task 6.6, not built here).
          throw err;
        }
        // A FatalError (our own validation, e.g. an invalid/unsafe arg,
        // a malformed InvokeResponse, or an unsupported binding kind) -
        // never safe to mechanically retry. Terminal for this run, same
        // posture as an agent-reported failure above.
        logger.error({ executionId: execution.id, err }, LOG_EVENT_RUN_ONCE_TERMINAL_FAILURE);
        await failRun(repos, run.id, execution.id);
        return true;
      }
    });
  } catch (err) {
    // A RetryableError re-thrown above (transaction already rolled
    // back by withTransaction) surfaces here as "did no work"; nothing
    // escapes to the caller.
    if (!(err instanceof RetryableError)) {
      logger.error({ err }, LOG_EVENT_RUN_ONCE_TERMINAL_FAILURE);
    }
    return false;
  }
}

// Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md): failing
// a run must also stop its OTHER not-yet-claimed executions from staying
// claimable - claim_execution() has no join to workflow_runs.status, so
// without this a sibling step would keep getting dispatched (real CLI
// side effects) against a run already marked failed. See
// ExecutionsRepo.failRemainingForRun's own comment for why 'running'
// rows are deliberately left untouched.
async function failRun(repos: CoreRepos, runId: number, executionId: number): Promise<void> {
  await repos.workflowRuns.markFailed(runId);
  await repos.executions.markFailed(executionId);
  await repos.executions.failRemainingForRun(runId);
}

export interface RunWorkerLoopOptions {
  pollIntervalMs: number;
  signal: AbortSignal;
}

/** Calls runOnce() forever until opts.signal fires; sleeps
 * opts.pollIntervalMs after any cycle that returned false (nothing to
 * claim, or a transient dispatch failure). */
export async function runWorkerLoop(
  pool: Pool,
  deps: WorkerDeps,
  opts: RunWorkerLoopOptions,
): Promise<void> {
  while (!opts.signal.aborted) {
    const didWork = await runOnce(pool, deps);
    if (!didWork && !opts.signal.aborted) {
      await sleep(opts.pollIntervalMs, opts.signal);
    }
  }
  logger.info({}, LOG_EVENT_WORKER_LOOP_STOPPED);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
