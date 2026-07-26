import type { ExecutionStatus } from "./execution.js";

// Raw `pg` row shapes (snake_case, as Postgres returns them) - kept
// separate from the camelCase domain types (execution.ts/checkpoint.ts) so
// the mapping between them lives in exactly one place (mappers.ts).
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
