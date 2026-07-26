// Task 6.2a (docs/impl-plans/0006-interpreter-plain-steps.md): one row
// per WorkflowSpec invocation submitted via engine.submitRun.

export type WorkflowRunStatus = "running" | "done" | "failed";

export interface WorkflowRun {
  id: number;
  sessionId: string | null;
  /** Cast, not validated, by core/ - `core/` does not depend on `ir/`
   * (ADR-0007's dependency direction runs the other way: `engine/`
   * depends on both). `engine/`'s `submitRun` caller is responsible for
   * having already run `ir.validate()` on this document; `core/` only
   * stores and returns it opaquely, mirroring `mapPlacementConfigRow`'s
   * existing "cast, not validated" posture for `placement_config.config`. */
  spec: unknown;
  input: unknown;
  status: WorkflowRunStatus;
  createdAt: Date;
  updatedAt: Date;
}
