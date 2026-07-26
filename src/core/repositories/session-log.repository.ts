import type { PoolClient } from "pg";
import { ERROR_IDS, FatalError } from "../../shared/index.js";
import {
  type SessionLogEntry,
  type SessionLogEntryRow,
  mapSessionLogEntryRow,
} from "../domain/index.js";
import {
  SQL_DELETE_SESSION_LOG_ENTRIES_AFTER_SEQUENCE,
  SQL_FIND_LIVE_SESSION_LOG_ENTRIES,
  SQL_FIND_SESSION_LOG_ENTRIES_BY_SESSION,
  SQL_INSERT_SESSION_LOG_ENTRY,
} from "./queries/session-log.queries.js";

export interface SessionLogRepo {
  append(input: { sessionId: string; sequence: number; input: unknown }): Promise<SessionLogEntry>;
  // Deletes every session_log row for sessionId with sequence >
  // afterSequence (the abandoned forward tail left by a prior rewind,
  // design.md D3a) - a no-op if nothing is past afterSequence.
  deleteAfter(sessionId: string, afterSequence: number): Promise<void>;
  // Every row for sessionId, INCLUDING any abandoned tail a prior rewind
  // hasn't been truncated yet (deletion is deferred to the next append) -
  // ordered by sequence ascending. Intended for inspecting the table's raw
  // state (e.g. tests); session.replaySession uses listLive, not this, for
  // the actual "current session state" read.
  listBySession(sessionId: string): Promise<SessionLogEntry[]>;
  // Only rows with sequence <= session_pointer.current_sequence - the
  // "live" log a rewind's not-yet-truncated tail is deliberately excluded
  // from (design.md D3a). Ordered by sequence ascending - the replay
  // order (design.md D3). Returns [] for a session with no pointer row
  // yet (no entries ever appended).
  listLive(sessionId: string): Promise<SessionLogEntry[]>;
}

// Bound to a caller-owned transaction client (ADR-0002), mirroring
// ExecutionsRepo/CheckpointsRepo/WaitsRepo - never opens its own
// connection.
export function createSessionLogRepo(client: PoolClient): SessionLogRepo {
  return {
    async append({ sessionId, sequence, input }) {
      const result = await client.query<SessionLogEntryRow>(SQL_INSERT_SESSION_LOG_ENTRY, [
        sessionId,
        sequence,
        JSON.stringify(input),
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.CORE_SESSION_LOG_NO_ROW_RETURNED, {
          context: { sessionId, sequence },
        });
      }
      return mapSessionLogEntryRow(row);
    },

    async deleteAfter(sessionId, afterSequence) {
      await client.query(SQL_DELETE_SESSION_LOG_ENTRIES_AFTER_SEQUENCE, [sessionId, afterSequence]);
    },

    async listBySession(sessionId) {
      const result = await client.query<SessionLogEntryRow>(
        SQL_FIND_SESSION_LOG_ENTRIES_BY_SESSION,
        [sessionId],
      );
      return result.rows.map(mapSessionLogEntryRow);
    },

    async listLive(sessionId) {
      const result = await client.query<SessionLogEntryRow>(SQL_FIND_LIVE_SESSION_LOG_ENTRIES, [
        sessionId,
      ]);
      return result.rows.map(mapSessionLogEntryRow);
    },
  };
}
