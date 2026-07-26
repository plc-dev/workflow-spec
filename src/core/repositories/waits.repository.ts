import type { PoolClient } from "pg";
import { ERROR_IDS, FatalError } from "../../shared/index.js";
import { WAIT_KEY_MAX_LENGTH } from "../constants.js";
import { type Wait, type WaitRow, mapWaitRow } from "../domain/index.js";
import {
  SQL_FIND_WAITS_BY_EXECUTION,
  SQL_INSERT_WAIT,
  SQL_SIGNAL_WAIT,
} from "./queries/waits.queries.js";

export interface WaitsRepo {
  create(input: { executionId: number; waitKey?: string; wakeAt?: Date }): Promise<Wait>;
  findByExecutionId(executionId: number): Promise<Wait[]>;
  // Marks every still-pending wait row for `waitKey` satisfied and
  // promotes each one's execution from `waiting` back to `queued`,
  // atomically, via the signal_wait() SQL function (schema.sql). Returns
  // every Wait actually signaled - an empty array if none were pending
  // (a safe no-op, not an error - see docs/impl-plans/0002-durable-
  // sleep.md TC-5).
  signal(waitKey: string): Promise<Wait[]>;
}

// Bound to a caller-owned transaction client (ADR-0002), mirroring
// ExecutionsRepo/CheckpointsRepo - never opens its own connection.
export function createWaitsRepo(client: PoolClient): WaitsRepo {
  return {
    async create({ executionId, waitKey, wakeAt }) {
      // Rejected here, before the INSERT, with a clear structured error -
      // rather than letting an oversized key reach signal_wait() later,
      // where pg_notify()'s 8000-byte payload cap would abort that ENTIRE
      // call (rolling back every other wait it was about to satisfy).
      // schema.sql's own CHECK(length(wait_key) <= 256) is the backstop
      // for any other writer of this table; this is the primary check for
      // this repository's own callers.
      if (waitKey !== undefined && waitKey.length > WAIT_KEY_MAX_LENGTH) {
        throw new FatalError(ERROR_IDS.CORE_WAIT_KEY_TOO_LONG, {
          context: { executionId, waitKeyLength: waitKey.length, max: WAIT_KEY_MAX_LENGTH },
        });
      }

      const result = await client.query<WaitRow>(SQL_INSERT_WAIT, [
        executionId,
        waitKey ?? null,
        wakeAt ?? null,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.CORE_WAIT_NO_ROW_RETURNED, {
          context: { executionId, waitKey, wakeAt },
        });
      }
      return mapWaitRow(row);
    },

    async findByExecutionId(executionId) {
      const result = await client.query<WaitRow>(SQL_FIND_WAITS_BY_EXECUTION, [executionId]);
      return result.rows.map(mapWaitRow);
    },

    async signal(waitKey) {
      const result = await client.query<WaitRow>(SQL_SIGNAL_WAIT, [waitKey]);
      return result.rows.map(mapWaitRow);
    },
  };
}
