// Task 6.2a (docs/impl-plans/0006-interpreter-plain-steps.md): a
// completed top-level node's output within one workflow run - what
// `{from:"step", id}` bindings resolve against across node boundaries.
// Deliberately scoped to top-level node ids only (design.md D8c) - see
// core/database/schema.sql's own comment on run_node_outputs.

export interface RunNodeOutput {
  runId: number;
  nodeId: string;
  output: unknown;
  completedAt: Date;
}
