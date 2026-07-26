// Named SQL query constants (`SQL_` prefix) - see executions.queries.ts
// for the rationale.

export const SQL_INSERT_SESSION_LOG_ENTRY = `
  INSERT INTO session_log (session_id, sequence, input)
  VALUES ($1, $2, $3)
  RETURNING *
`;

// The abandoned forward tail left by a prior rewind (design.md D3a) - a
// no-op if afterSequence is already the log's own max sequence for this
// session.
export const SQL_DELETE_SESSION_LOG_ENTRIES_AFTER_SEQUENCE = `
  DELETE FROM session_log
  WHERE session_id = $1 AND sequence > $2
`;

export const SQL_FIND_SESSION_LOG_ENTRIES_BY_SESSION = `
  SELECT * FROM session_log
  WHERE session_id = $1
  ORDER BY sequence ASC
`;

// Local-review fix (docs/impl-plans/0003-session-log.md "Post-review
// fixes"): the "live" log ends at session_pointer.current_sequence - rows
// past it are an abandoned tail a prior rewind left behind, not yet
// deleted (deletion is deferred to the next appendEntry, design.md D3a).
// replaySession must never return those abandoned rows. Bounding via a
// subquery on session_pointer, in the SAME statement, keeps this a single
// round trip and means "no pointer row yet" (a session with zero entries)
// correctly yields zero rows (sequence <= NULL is UNKNOWN, matching no
// rows), with no separate existence check needed.
export const SQL_FIND_LIVE_SESSION_LOG_ENTRIES = `
  SELECT sl.* FROM session_log sl
  WHERE sl.session_id = $1
    AND sl.sequence <= (SELECT current_sequence FROM session_pointer WHERE session_id = $1)
  ORDER BY sl.sequence ASC
`;
