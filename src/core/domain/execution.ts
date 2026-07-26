export type ExecutionStatus = "blocked" | "queued" | "running" | "waiting" | "done" | "failed";

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
  /** Task 6.2a: the `workflow_runs` row this execution was created for by
   * `engine.submitRun`, or null for every execution not created by the
   * interpreter (durable-sleep/session-log tests, and any future
   * non-workflow-run use of `executions`). */
  runId: number | null;
}
