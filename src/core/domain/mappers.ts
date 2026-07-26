import type { Checkpoint } from "./checkpoint.js";
import type { Execution } from "./execution.js";
import type { CheckpointRow, ExecutionRow } from "./rows.js";

export function mapExecutionRow(row: ExecutionRow): Execution {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    step: row.step,
    input: row.input,
    status: row.status,
    workerId: row.worker_id,
    leaseUntil: row.lease_until,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCheckpointRow(row: CheckpointRow): Checkpoint {
  return {
    executionId: Number(row.execution_id),
    stepId: row.step_id,
    output: row.output,
    committedAt: row.committed_at,
  };
}
