// Named SQL query constants (`SQL_` prefix) - one place to locate every
// query this repository issues, instead of inline strings scattered
// through the repository's methods.

export const SQL_ENQUEUE_EXECUTION = `
  INSERT INTO executions (session_id, step, input)
  VALUES ($1, $2, $3)
  RETURNING *
`;

// THE PATTERN's dispatcher (design.md D6): no broker, no leader election -
// `claim_execution()` does the SELECT ... FOR UPDATE SKIP LOCKED +
// promote-to-running round trip in one call (see core/schema.sql).
export const SQL_CLAIM_EXECUTION = "SELECT * FROM claim_execution($1, $2)";

export const SQL_FIND_EXECUTION_BY_ID = "SELECT * FROM executions WHERE id = $1";

// Idempotent: setting an already-`done` row's status to `done` again is a
// no-op write, not an error - engine.completeExecution relies on this to
// be safely callable twice for the same execution.
export const SQL_MARK_EXECUTION_DONE = `
  UPDATE executions
  SET status = 'done', updated_at = now()
  WHERE id = $1
`;
