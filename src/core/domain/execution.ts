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
