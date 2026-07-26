// Named SQL query constants (`SQL_` prefix) - see executions.queries.ts
// for the rationale.

export const SQL_INSERT_WAIT = `
  INSERT INTO waits (execution_id, wait_key, wake_at)
  VALUES ($1, $2, $3)
  RETURNING *
`;

export const SQL_FIND_WAITS_BY_EXECUTION = "SELECT * FROM waits WHERE execution_id = $1";

// signal_wait() (core/database/schema.sql) does the atomic
// mark-satisfied + promote-execution-to-queued work for EVERY still
// pending wait on `p_wait_key`, in one call - see that function's own
// comment for why it uses blocking FOR UPDATE rather than SKIP LOCKED.
export const SQL_SIGNAL_WAIT = "SELECT * FROM signal_wait($1)";
