import type { Checkpoint } from "./checkpoint.js";
import type { Execution } from "./execution.js";
import type {
  CheckpointRow,
  ExecutionRow,
  SessionLogEntryRow,
  SessionPointerRow,
  WaitRow,
} from "./rows.js";
import type { SessionLogEntry } from "./session-log-entry.js";
import type { SessionPointer } from "./session-pointer.js";
import type { Wait } from "./wait.js";

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

export function mapWaitRow(row: WaitRow): Wait {
  return {
    id: Number(row.id),
    executionId: Number(row.execution_id),
    waitKey: row.wait_key,
    wakeAt: row.wake_at,
    satisfiedAt: row.satisfied_at,
    createdAt: row.created_at,
  };
}

export function mapSessionLogEntryRow(row: SessionLogEntryRow): SessionLogEntry {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    input: row.input,
    createdAt: row.created_at,
  };
}

export function mapSessionPointerRow(row: SessionPointerRow): SessionPointer {
  return {
    sessionId: row.session_id,
    currentSequence: Number(row.current_sequence),
    updatedAt: row.updated_at,
  };
}
