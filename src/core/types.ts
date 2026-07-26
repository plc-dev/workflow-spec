export type ExecutionStatus = "queued" | "running" | "done" | "failed";

export interface Execution {
  id: number;
  sessionId: string;
  step: string;
  input: unknown;
  status: ExecutionStatus;
  workerId: string | null;
  leaseUntil: Date | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Checkpoint {
  executionId: number;
  stepId: string;
  output: unknown;
  committedAt: Date;
}

// Raw `pg` row shapes (snake_case, as Postgres returns them) - kept
// separate from the camelCase domain types above so the mapping between
// them lives in exactly one place (each repository's own row-mapper).
export interface ExecutionRow {
  id: string; // BIGSERIAL comes back as a string from `pg` by default
  session_id: string;
  step: string;
  input: unknown;
  status: ExecutionStatus;
  worker_id: string | null;
  lease_until: Date | null;
  attempts: number;
  created_at: Date;
  updated_at: Date;
}

export interface CheckpointRow {
  execution_id: string;
  step_id: string;
  output: unknown;
  committed_at: Date;
}

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
