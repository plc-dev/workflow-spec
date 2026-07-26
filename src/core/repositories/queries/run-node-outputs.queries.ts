// Named SQL query constants (`SQL_` prefix) - see executions.queries.ts
// for the rationale.

// Idempotent, mirrors SQL_INSERT_CHECKPOINT's own posture: on a repeated
// completion for the same (run_id, node_id) (e.g. a retried completeStep
// call), returns the EXISTING row rather than surfacing a conflict error.
export const SQL_INSERT_RUN_NODE_OUTPUT = `
  INSERT INTO run_node_outputs (run_id, node_id, output)
  VALUES ($1, $2, $3)
  ON CONFLICT (run_id, node_id) DO NOTHING
  RETURNING *
`;

export const SQL_FIND_RUN_NODE_OUTPUT = `
  SELECT * FROM run_node_outputs WHERE run_id = $1 AND node_id = $2
`;

export const SQL_LIST_COMPLETED_NODE_IDS = `
  SELECT node_id FROM run_node_outputs WHERE run_id = $1
`;
