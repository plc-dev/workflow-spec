import type { PoolClient } from "pg";
import { type Execution, type ExecutionRow, mapExecutionRow } from "../types.js";

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
      const result = await client.query<ExecutionRow>(
        `INSERT INTO executions (session_id, step, input)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [sessionId, step, JSON.stringify(input)],
      );
      const row = result.rows[0];
      if (!row) throw new Error("enqueue: INSERT ... RETURNING produced no row");
      return mapExecutionRow(row);
    },

    async claim(workerId, leaseSeconds = 30) {
      // THE PATTERN's dispatcher (design.md D6): no broker, no leader
      // election - `claim_execution()` does the SELECT ... FOR UPDATE SKIP
      // LOCKED + promote-to-running round trip in one call.
      const result = await client.query<ExecutionRow>("SELECT * FROM claim_execution($1, $2)", [
        workerId,
        leaseSeconds,
      ]);
      const row = result.rows[0];
      if (!row || row.id === null) return null;
      return mapExecutionRow(row);
    },

    async findById(id) {
      const result = await client.query<ExecutionRow>("SELECT * FROM executions WHERE id = $1", [
        id,
      ]);
      const row = result.rows[0];
      return row ? mapExecutionRow(row) : null;
    },

    async markDone(id) {
      // Idempotent: setting an already-`done` row's status to `done` again
      // is a no-op write, not an error - completeExecution relies on this
      // to be safely callable twice for the same execution (TC-5).
      await client.query(
        `UPDATE executions SET status = 'done', updated_at = now() WHERE id = $1`,
        [id],
      );
    },
  };
}
