import type { CoreRepos, Wait } from "../core/index.js";
import { logger } from "../shared/index.js";

// ADR-0002/ADR-0007: mirrors claim-complete.ts's shape - these two
// primitives operate on a `CoreRepos` already bound to an open
// transaction, never opening a connection of their own.

const LOG_EVENT_WAIT_FOR = "engine.waitFor";
const LOG_EVENT_SIGNAL_WAIT = "engine.signalWait";

// Durable sleep (design.md D6, task 6.1b): the counterpart to
// completeExecution for a step that needs to durably sleep rather than
// finish. Transitions the execution `running` -> `waiting` and records
// the wait row in the SAME transaction, so a mid-transaction crash rolls
// both back together (docs/impl-plans/0002-durable-sleep.md TC-6).
export async function waitFor(
  repos: CoreRepos,
  executionId: number,
  params: { waitKey?: string; wakeAt?: Date },
): Promise<Wait> {
  const wait = await repos.waits.create({ executionId, ...params });
  await repos.executions.markWaiting(executionId);
  logger.debug(
    { executionId, waitKey: params.waitKey ?? null, wakeAt: params.wakeAt ?? null },
    LOG_EVENT_WAIT_FOR,
  );
  return wait;
}

// Durably broadcasts wakeup to EVERY execution still waiting on `waitKey`
// (docs/impl-plans/0002-durable-sleep.md TC-4) - a thin pass-through to
// WaitsRepo.signal, which is itself backed by the signal_wait() SQL
// function's atomic mark-satisfied + promote-to-queued behavior.
export async function signalWait(repos: CoreRepos, waitKey: string): Promise<Wait[]> {
  const signaled = await repos.waits.signal(waitKey);
  logger.debug({ waitKey, signaledCount: signaled.length }, LOG_EVENT_SIGNAL_WAIT);
  return signaled;
}
