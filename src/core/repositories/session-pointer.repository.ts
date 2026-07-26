import type { PoolClient } from "pg";
import { ERROR_IDS, FatalError } from "../../shared/index.js";
import {
  type SessionPointer,
  type SessionPointerRow,
  mapSessionPointerRow,
} from "../domain/index.js";
import {
  SQL_LOCK_OR_CREATE_SESSION_POINTER,
  SQL_SET_SESSION_POINTER_SEQUENCE,
} from "./queries/session-pointer.queries.js";

export interface SessionPointerRepo {
  // Ensures a pointer row exists for sessionId (current_sequence = 0 if
  // newly created), then locks and returns it via SELECT ... FOR UPDATE -
  // the caller holds this lock for the rest of its transaction,
  // serializing every mutation/rewind for this one session (design.md D3
  // "linear-per-session-mutation").
  lock(sessionId: string): Promise<SessionPointer>;
  setSequence(sessionId: string, sequence: number): Promise<SessionPointer>;
}

// Bound to a caller-owned transaction client (ADR-0002), mirroring
// ExecutionsRepo/CheckpointsRepo/WaitsRepo - never opens its own
// connection.
export function createSessionPointerRepo(client: PoolClient): SessionPointerRepo {
  return {
    async lock(sessionId) {
      const result = await client.query<SessionPointerRow>(SQL_LOCK_OR_CREATE_SESSION_POINTER, [
        sessionId,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.CORE_SESSION_POINTER_NO_ROW_RETURNED, {
          context: { sessionId },
        });
      }
      return mapSessionPointerRow(row);
    },

    async setSequence(sessionId, sequence) {
      const result = await client.query<SessionPointerRow>(SQL_SET_SESSION_POINTER_SEQUENCE, [
        sessionId,
        sequence,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.CORE_SESSION_POINTER_NO_ROW_RETURNED, {
          context: { sessionId, sequence },
        });
      }
      return mapSessionPointerRow(row);
    },
  };
}
