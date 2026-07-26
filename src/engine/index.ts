import type { CoreRepos } from "../core/tx.js";
import type { Checkpoint, Execution } from "../core/types.js";
import { logger } from "../logger.js";

// ADR-0002/ADR-0007: `engine/` never opens its own connection - these two
// primitives operate on a `CoreRepos` already bound to an open transaction
// (via `core.withTransaction`), so a caller can interleave its OWN writes
// (future `session/`, `scheduler/`, `dataset-catalog/` packages) between
// them on the same transaction. Deliberately two composable functions, not
// a single hardcoded `processOneExecution` (contrast with spike 1.2's
// `worker.js`, which hardcoded the session-log/placement writes in between).

export async function claimExecution(
  repos: CoreRepos,
  workerId: string,
  opts: { leaseSeconds?: number } = {},
): Promise<Execution | null> {
  const execution = await repos.executions.claim(workerId, opts.leaseSeconds);
  logger.debug({ workerId, executionId: execution?.id ?? null }, "engine.claimExecution");
  return execution;
}

export async function completeExecution(
  repos: CoreRepos,
  params: { executionId: number; stepId: string; output: unknown },
): Promise<Checkpoint> {
  const { executionId, stepId, output } = params;
  const checkpoint = await repos.checkpoints.insert(executionId, stepId, output);
  await repos.executions.markDone(executionId);
  logger.debug({ executionId, stepId }, "engine.completeExecution");
  return checkpoint;
}
