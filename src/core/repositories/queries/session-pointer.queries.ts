// Named SQL query constants (`SQL_` prefix) - see executions.queries.ts
// for the rationale.

// SessionPointerRepo.lock, in ONE round trip (local-review fix, docs/
// impl-plans/0003-session-log.md "Post-review fixes" - the original
// two-statement ensure-then-lock form held the row's lock for one extra
// round trip's worth of the per-session critical section every
// appendEntry/rewindSession call goes through). `ON CONFLICT ... DO
// UPDATE` (rather than `DO NOTHING`) is what makes this a single
// statement: an `INSERT ... DO UPDATE` locks and returns the existing row
// exactly like `SELECT ... FOR UPDATE` would, whether or not a row
// already existed - serializing every call for this one session_id
// (design.md D3's linear-per-session-mutation guarantee). The `SET
// session_id = ...` is a no-op write (the column is the conflict target,
// so its value can't actually change) - it exists only because Postgres
// requires a SET clause on `DO UPDATE`.
export const SQL_LOCK_OR_CREATE_SESSION_POINTER = `
  INSERT INTO session_pointer (session_id)
  VALUES ($1)
  ON CONFLICT (session_id) DO UPDATE SET session_id = session_pointer.session_id
  RETURNING *
`;

export const SQL_SET_SESSION_POINTER_SEQUENCE = `
  UPDATE session_pointer
  SET current_sequence = $2, updated_at = now()
  WHERE session_id = $1
  RETURNING *
`;
