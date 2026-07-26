// Named SQL query constants (`SQL_` prefix) - see executions.queries.ts
// for the rationale.

export const SQL_RECORD_PLACEMENT_ACCESS = `
  INSERT INTO placement_access (content_hash, accessed_at)
  VALUES ($1, COALESCE($2::timestamptz, now()))
`;

// design.md D4a: the windowed frequency test ("`>= 3` accesses within a
// 5-10 minute rolling window") is exact rather than an approximation of a
// cumulative counter - see placement.access_count for the latter.
export const SQL_COUNT_PLACEMENT_ACCESS_WITHIN_WINDOW = `
  SELECT count(*)::int AS count
  FROM placement_access
  WHERE content_hash = $1
    AND accessed_at >= now() - ($2::double precision / 1000 * interval '1 second')
`;

// Keeps the access log bounded - called with the widest configured
// window as the horizon (scheduler/placement.ts's recordAccess).
export const SQL_PRUNE_PLACEMENT_ACCESS_OLDER_THAN = `
  DELETE FROM placement_access
  WHERE content_hash = $1
    AND accessed_at < now() - ($2::double precision / 1000 * interval '1 second')
`;
