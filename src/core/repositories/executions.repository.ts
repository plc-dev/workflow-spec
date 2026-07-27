import type { PoolClient } from "pg";
import { ERROR_IDS, FatalError } from "../../shared/index.js";
import { DEFAULT_LEASE_SECONDS } from "../constants.js";
import { type Execution, type ExecutionRow, mapExecutionRow } from "../domain/index.js";
import {
  SQL_CLAIM_EXECUTION,
  SQL_ENQUEUE_EXECUTION,
  SQL_ENQUEUE_EXECUTION_FOR_RUN,
  SQL_FAIL_REMAINING_EXECUTIONS_FOR_RUN,
  SQL_FIND_EXECUTION_BY_ID,
  SQL_MARK_EXECUTION_DONE,
  SQL_MARK_EXECUTION_FAILED,
  SQL_MARK_EXECUTION_WAITING,
  SQL_PROMOTE_BLOCKED_TO_QUEUED,
} from "./queries/executions.queries.js";

export interface ExecutionsRepo {
  enqueue(input: { sessionId: string; step: string; input: unknown }): Promise<Execution>;
  claim(workerId: string, leaseSeconds?: number): Promise<Execution | null>;
  findById(id: number): Promise<Execution | null>;
  markDone(id: number): Promise<void>;
  // Task 6.1b (durable sleep) - the counterpart to markDone, used by
  // engine.waitFor.
  markWaiting(id: number): Promise<void>;
  // Package 0011 - the terminal, non-retrying counterpart to markDone,
  // used by apps/worker when a real dispatch reports a genuine failure.
  markFailed(id: number): Promise<void>;
  // Local-review fix (package 0011) - the counterpart to markFailed that
  // ALSO stops a failed run's other not-yet-claimed executions from
  // staying claimable. See SQL_FAIL_REMAINING_EXECUTIONS_FOR_RUN's own
  // comment for why 'running' rows are deliberately left untouched.
  failRemainingForRun(runId: number): Promise<void>;
  // Task 6.2a (docs/impl-plans/0006-interpreter-plain-steps.md) -
  // engine.submitRun's per-node insert, with an explicit caller-decided
  // initial status (blocked/queued) instead of enqueue's always-'queued'
  // default.
  enqueueForRun(input: {
    runId: number;
    nodeId: string;
    input: unknown;
    status: "blocked" | "queued";
    sessionId: string;
  }): Promise<Execution>;
  // Idempotent - see SQL_PROMOTE_BLOCKED_TO_QUEUED's own comment.
  promoteBlockedToQueued(runId: number, nodeId: string): Promise<void>;
}

// Bound to a caller-owned transaction client (ADR-0002) - never opens its
// own connection, so `session/`/`scheduler/`/`dataset-catalog/` can later
// interleave their own writes on the SAME transaction (ADR-0007).
export function createExecutionsRepo(client: PoolClient): ExecutionsRepo {
  return {
    async enqueue({ sessionId, step, input }) {
      const result = await client.query<ExecutionRow>(SQL_ENQUEUE_EXECUTION, [
        sessionId,
        step,
        JSON.stringify(input),
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.CORE_ENQUEUE_NO_ROW_RETURNED, {
          context: { sessionId, step },
        });
      }
      return mapExecutionRow(row);
    },

    async claim(workerId, leaseSeconds = DEFAULT_LEASE_SECONDS) {
      const result = await client.query<ExecutionRow>(SQL_CLAIM_EXECUTION, [
        workerId,
        leaseSeconds,
      ]);
      const row = result.rows[0];
      if (!row || row.id === null) return null;
      return mapExecutionRow(row);
    },

    async findById(id) {
      const result = await client.query<ExecutionRow>(SQL_FIND_EXECUTION_BY_ID, [id]);
      const row = result.rows[0];
      return row ? mapExecutionRow(row) : null;
    },

    async markDone(id) {
      await client.query(SQL_MARK_EXECUTION_DONE, [id]);
    },

    async markWaiting(id) {
      await client.query(SQL_MARK_EXECUTION_WAITING, [id]);
    },

    async markFailed(id) {
      await client.query(SQL_MARK_EXECUTION_FAILED, [id]);
    },

    async failRemainingForRun(runId) {
      await client.query(SQL_FAIL_REMAINING_EXECUTIONS_FOR_RUN, [runId]);
    },

    async enqueueForRun({ runId, nodeId, input, status, sessionId }) {
      const result = await client.query<ExecutionRow>(SQL_ENQUEUE_EXECUTION_FOR_RUN, [
        sessionId,
        runId,
        nodeId,
        JSON.stringify(input),
        status,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.CORE_ENQUEUE_NO_ROW_RETURNED, {
          context: { runId, nodeId },
        });
      }
      return mapExecutionRow(row);
    },

    async promoteBlockedToQueued(runId, nodeId) {
      await client.query(SQL_PROMOTE_BLOCKED_TO_QUEUED, [runId, nodeId]);
    },
  };
}
