import type { PoolClient } from "pg";
import { ERROR_IDS, FatalError } from "../../shared/index.js";
import { DEFAULT_LEASE_SECONDS } from "../constants.js";
import { type Execution, type ExecutionRow, mapExecutionRow } from "../domain/index.js";
import {
  SQL_CLAIM_EXECUTION,
  SQL_ENQUEUE_EXECUTION,
  SQL_FIND_EXECUTION_BY_ID,
  SQL_MARK_EXECUTION_DONE,
} from "./queries/executions.queries.js";

export interface ExecutionsRepo {
  enqueue(input: { sessionId: string; step: string; input: unknown }): Promise<Execution>;
  claim(workerId: string, leaseSeconds?: number): Promise<Execution | null>;
  findById(id: number): Promise<Execution | null>;
  markDone(id: number): Promise<void>;
}

// Bound to a caller-owned transaction client (ADR-0002) - never opens its
// own connection, so `session/`/`scheduler/`/`dataset-catalog/` can later
// interleave their own writes on the SAME transaction (ADR-0007).
export function createExecutionsRepo(client: PoolClient): ExecutionsRepo {
  return {
    async enqueue({ sessionId, step, input }) {
      const result = await client.query<ExecutionRow>(SQL_ENQUEUE_EXECUTION, [
        sessionId,
        step,
        JSON.stringify(input),
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.CORE_ENQUEUE_NO_ROW_RETURNED, {
          context: { sessionId, step },
        });
      }
      return mapExecutionRow(row);
    },

    async claim(workerId, leaseSeconds = DEFAULT_LEASE_SECONDS) {
      const result = await client.query<ExecutionRow>(SQL_CLAIM_EXECUTION, [
        workerId,
        leaseSeconds,
      ]);
      const row = result.rows[0];
      if (!row || row.id === null) return null;
      return mapExecutionRow(row);
    },

    async findById(id) {
      const result = await client.query<ExecutionRow>(SQL_FIND_EXECUTION_BY_ID, [id]);
      const row = result.rows[0];
      return row ? mapExecutionRow(row) : null;
    },

    async markDone(id) {
      await client.query(SQL_MARK_EXECUTION_DONE, [id]);
    },
  };
}
