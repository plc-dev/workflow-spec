// Named SQL query constants (`SQL_` prefix) - see executions.queries.ts
// for the rationale.

// Idempotent: Postgres' UNIQUE(execution_id, step_id) constraint is what
// actually enforces exactly-once (design.md D6/R7 - "Postgres enforces
// exactly-once, not application code"). On conflict, the repository
// re-selects and returns the EXISTING row rather than surfacing a
// conflict error, so callers (engine.completeExecution) never have to
// branch on retry.
export const SQL_INSERT_CHECKPOINT = `
  INSERT INTO checkpoints (execution_id, step_id, output)
  VALUES ($1, $2, $3)
  ON CONFLICT (execution_id, step_id) DO NOTHING
  RETURNING *
`;

export const SQL_FIND_CHECKPOINT_BY_EXECUTION_AND_STEP =
  "SELECT * FROM checkpoints WHERE execution_id = $1 AND step_id = $2";
