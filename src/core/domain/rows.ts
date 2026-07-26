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

export interface WaitRow {
  id: string; // BIGSERIAL comes back as a string from `pg` by default
  execution_id: string;
  wait_key: string | null;
  wake_at: Date | null;
  satisfied_at: Date | null;
  created_at: Date;
}

export interface SessionLogEntryRow {
  id: string; // BIGSERIAL comes back as a string from `pg` by default
  session_id: string;
  sequence: string; // BIGINT comes back as a string from `pg` by default
  input: unknown;
  created_at: Date;
}

export interface SessionPointerRow {
  session_id: string;
  current_sequence: string; // BIGINT comes back as a string from `pg` by default
  updated_at: Date;
}

export interface PlacementRow {
  content_hash: string;
  replica_id: string | null;
  session_id: string | null;
  pinned: boolean;
  pinned_at: Date | null;
  interactivity: "interactive" | "batch";
  access_count: string; // BIGINT comes back as a string from `pg` by default
  first_accessed_at: Date | null;
  last_accessed_at: Date | null;
  declared_cost_class: "trivial" | "cheap" | "moderate" | "expensive" | null;
  observed_rehydration_ms: number | null;
  observed_sample_count: number;
  size_bytes: string; // BIGINT comes back as a string from `pg` by default
  created_at: Date;
  updated_at: Date;
}

export interface PlacementConfigRow {
  name: string;
  config: unknown; // JSONB - narrowed to PlacementConfig by mapPlacementConfigRow
  updated_at: Date;
}
