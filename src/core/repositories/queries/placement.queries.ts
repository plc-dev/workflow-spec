// Named SQL query constants (`SQL_` prefix) - see executions.queries.ts
// for the rationale.

export const SQL_FIND_PLACEMENT_BY_CONTENT_HASH = "SELECT * FROM placement WHERE content_hash = $1";

// Upsert half of the archived resolver's `recordAccess` (design.md D4a):
// inserts a first-seen row, or on conflict updates access bookkeeping +
// the incremental rolling mean of observed rehydration timings. COALESCE
// lets a caller supply only the fields it has an opinion about - a null
// argument leaves the existing value intact (access-count/timestamp
// bookkeeping always advances regardless). Does NOT touch
// `placement_access` - PlacementAccessRepo.record is a separate call,
// composed by scheduler.recordAccess.
export const SQL_UPSERT_PLACEMENT_ACCESS = `
  INSERT INTO placement (
    content_hash, replica_id, session_id, interactivity,
    access_count, first_accessed_at, last_accessed_at,
    declared_cost_class, size_bytes,
    observed_rehydration_ms, observed_sample_count,
    created_at, updated_at
  )
  VALUES (
    $1, $2, $3, COALESCE($4, 'batch'),
    1, COALESCE($7::timestamptz, now()), COALESCE($7::timestamptz, now()),
    $5, COALESCE($6, 0),
    $8::double precision, CASE WHEN $8::double precision IS NULL THEN 0 ELSE 1 END,
    now(), now()
  )
  ON CONFLICT (content_hash) DO UPDATE SET
    replica_id        = COALESCE($2, placement.replica_id),
    session_id        = COALESCE($3, placement.session_id),
    interactivity      = COALESCE($4, placement.interactivity),
    access_count       = placement.access_count + 1,
    last_accessed_at   = COALESCE($7::timestamptz, now()),
    declared_cost_class = COALESCE($5, placement.declared_cost_class),
    size_bytes          = COALESCE($6, placement.size_bytes),
    -- Incremental rolling mean: new_avg = (old_avg*n + sample) / (n+1).
    -- Only advances when a new sample ($8) is supplied.
    observed_rehydration_ms = CASE
      WHEN $8::double precision IS NULL THEN placement.observed_rehydration_ms
      WHEN placement.observed_rehydration_ms IS NULL THEN $8::double precision
      ELSE (placement.observed_rehydration_ms * placement.observed_sample_count
              + $8::double precision)
           / (placement.observed_sample_count + 1)
    END,
    observed_sample_count = placement.observed_sample_count
      + CASE WHEN $8::double precision IS NULL THEN 0 ELSE 1 END,
    updated_at = now()
  RETURNING *
`;

export const SQL_SET_PLACEMENT_PINNED = `
  UPDATE placement
  SET pinned = $2,
      pinned_at = CASE WHEN $2 THEN now() ELSE NULL END,
      updated_at = now()
  WHERE content_hash = $1
  RETURNING *
`;

// Eviction scans the PINNED set ordered LRU-first (design.md D4a) - the
// `placement_pinned_lru_idx` partial index (schema.sql) backs this scan.
// Plain `ASC` (not `ASC NULLS FIRST`), matching the index's own default
// NULLS LAST collation - the index can otherwise satisfy this ordering
// without an extra Sort node. A pinned row is never NULL here in
// practice (setPinned requires an existing row, and the only path that
// creates one - upsertAccess - always sets last_accessed_at), but this
// keeps the query's declared order index-satisfiable regardless.
export const SQL_LIST_PINNED_PLACEMENTS_ORDERED_BY_LRU = `
  SELECT * FROM placement
  WHERE pinned = true
  ORDER BY last_accessed_at ASC
`;
