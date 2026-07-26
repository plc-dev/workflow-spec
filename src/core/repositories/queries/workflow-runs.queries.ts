// Named SQL query constants (`SQL_` prefix) - see executions.queries.ts
// for the rationale.

export const SQL_INSERT_WORKFLOW_RUN = `
  INSERT INTO workflow_runs (session_id, spec, input)
  VALUES ($1, $2, $3)
  RETURNING *
`;

export const SQL_FIND_WORKFLOW_RUN_BY_ID = "SELECT * FROM workflow_runs WHERE id = $1";

// Local-review fix (docs/impl-plans/0006-interpreter-plain-steps.md):
// serializes concurrent completeStep calls against the SAME run - without
// this, two sibling dependencies of one node completed by two genuinely
// concurrent transactions could each read run_node_outputs before the
// other commits, so neither ever observes both outputs and the
// downstream node (or the run itself) never gets promoted/marked done.
export const SQL_LOCK_WORKFLOW_RUN_FOR_UPDATE =
  "SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE";

// Idempotent, mirrors SQL_MARK_EXECUTION_DONE's own posture - a run
// already 'done'/'failed' being marked done again is a no-op write.
export const SQL_MARK_WORKFLOW_RUN_DONE = `
  UPDATE workflow_runs
  SET status = 'done', updated_at = now()
  WHERE id = $1
`;

export const SQL_MARK_WORKFLOW_RUN_FAILED = `
  UPDATE workflow_runs
  SET status = 'failed', updated_at = now()
  WHERE id = $1
`;
