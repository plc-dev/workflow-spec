// Named SQL query constants (`SQL_` prefix, ADR-0012/best-practices §2).

// registerImage "replaces the function rows for this digest" (archived
// admin.js's own framing) - DELETE-then-INSERT per digest, not a partial
// upsert, so a redeploy that drops a function from its OpenAPI contract
// doesn't leave a stale capability row behind.
export const SQL_DELETE_FUNCTION_CAPABILITIES_FOR_DIGEST =
  "DELETE FROM function_capabilities WHERE digest = $1";

export const SQL_INSERT_FUNCTION_CAPABILITY = `
  INSERT INTO function_capabilities
    (digest, function_name, mutates, materialization_cost_class,
     cow_support, change_detection_support, nesting_declaration)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING *
`;

export const SQL_LIST_FUNCTION_CAPABILITIES_BY_DIGEST = `
  SELECT * FROM function_capabilities WHERE digest = $1 ORDER BY function_name
`;
