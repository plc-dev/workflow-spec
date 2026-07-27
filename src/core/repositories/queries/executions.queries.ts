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

// Task 6.1b (durable sleep): transitions an execution to `waiting` - the
// counterpart to SQL_MARK_EXECUTION_DONE, used by engine.waitFor instead
// of engine.completeExecution when a step needs to durably sleep rather
// than finish.
export const SQL_MARK_EXECUTION_WAITING = `
  UPDATE executions
  SET status = 'waiting', updated_at = now()
  WHERE id = $1
`;

// Package 0011 (docs/impl-plans/0011-worker-cli-dispatch.md): the
// terminal counterpart to SQL_MARK_EXECUTION_DONE - used by
// apps/worker when a real dispatch (via the exec-agent) reports a
// genuine, non-transient failure (a nonzero exit or a timeout, per
// ADR-0008), rather than a transport-level problem that should instead
// roll back the claim and retry. 'failed' was already a valid
// executions.status CHECK-constraint value (core/database/schema.sql)
// with no writer until this package.
export const SQL_MARK_EXECUTION_FAILED = `
  UPDATE executions
  SET status = 'failed', updated_at = now()
  WHERE id = $1
`;

// Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md): failing
// ONE step's execution (SQL_MARK_EXECUTION_FAILED above) does nothing
// about that run's OTHER not-yet-claimed executions - claim_execution()
// selects purely on executions.status, with no join to workflow_runs, so
// they would otherwise stay claimable (and get dispatched, running real
// CLI side effects) against a run apps/worker has already marked failed.
// Only 'blocked'/'queued'/'waiting' are touched - deliberately NOT
// 'running' (another worker may already be mid-dispatch on that row;
// racing to fail it here would conflict with that worker's own
// completeStep/markFailed call for the SAME row).
export const SQL_FAIL_REMAINING_EXECUTIONS_FOR_RUN = `
  UPDATE executions
  SET status = 'failed', updated_at = now()
  WHERE run_id = $1 AND status IN ('blocked', 'queued', 'waiting')
`;

// Task 6.2a (docs/impl-plans/0006-interpreter-plain-steps.md): inserts one
// execution row for a workflow run's top-level node, with an explicit
// caller-decided status ('blocked' if the node has unmet dependencies at
// submission time, 'queued' otherwise) rather than SQL_ENQUEUE_EXECUTION's
// always-'queued' DEFAULT. Reuses the `step` column as the node id (see
// schema.sql's own comment on executions.run_id).
export const SQL_ENQUEUE_EXECUTION_FOR_RUN = `
  INSERT INTO executions (session_id, run_id, step, input, status)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING *
`;

// Idempotent no-op if the row is already past 'blocked' (queued/running/
// done/failed) - promoteReadyNodes may legitimately re-check and
// re-attempt this for a node whose dependencies were already satisfied
// by an earlier sibling completion.
export const SQL_PROMOTE_BLOCKED_TO_QUEUED = `
  UPDATE executions
  SET status = 'queued', updated_at = now()
  WHERE run_id = $1 AND step = $2 AND status = 'blocked'
`;
