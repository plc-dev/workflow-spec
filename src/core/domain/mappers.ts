import type { Checkpoint } from "./checkpoint.js";
import type { Execution } from "./execution.js";
import type { PlacementConfig } from "./placement-config.js";
import type { Placement } from "./placement.js";
import type {
  CheckpointRow,
  ExecutionRow,
  PlacementConfigRow,
  PlacementRow,
  RunNodeOutputRow,
  SessionLogEntryRow,
  SessionPointerRow,
  WaitRow,
  WorkflowRunRow,
} from "./rows.js";
import type { RunNodeOutput } from "./run-node-output.js";
import type { SessionLogEntry } from "./session-log-entry.js";
import type { SessionPointer } from "./session-pointer.js";
import type { Wait } from "./wait.js";
import type { WorkflowRun } from "./workflow-run.js";

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
    runId: row.run_id === null ? null : Number(row.run_id),
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

export function mapPlacementRow(row: PlacementRow): Placement {
  return {
    contentHash: row.content_hash,
    replicaId: row.replica_id,
    sessionId: row.session_id,
    pinned: row.pinned,
    pinnedAt: row.pinned_at,
    interactivity: row.interactivity,
    accessCount: Number(row.access_count),
    firstAccessedAt: row.first_accessed_at,
    lastAccessedAt: row.last_accessed_at,
    declaredCostClass: row.declared_cost_class,
    observedRehydrationMs: row.observed_rehydration_ms,
    observedSampleCount: row.observed_sample_count,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// `config` is JSONB - already a plain object by the time `pg` returns it,
// no JSON.parse needed. Cast, not validated: this row is only ever
// written by this codebase's own seeded schema.sql data, never
// externally authored input (unlike workflow-spec/validate.ts's
// untrusted-document case).
export function mapPlacementConfigRow(row: PlacementConfigRow): PlacementConfig {
  return row.config as PlacementConfig;
}

export function mapWorkflowRunRow(row: WorkflowRunRow): WorkflowRun {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    spec: row.spec,
    input: row.input,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapRunNodeOutputRow(row: RunNodeOutputRow): RunNodeOutput {
  return {
    runId: Number(row.run_id),
    nodeId: row.node_id,
    output: row.output,
    completedAt: row.completed_at,
  };
}
