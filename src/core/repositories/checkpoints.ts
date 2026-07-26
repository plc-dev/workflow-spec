import type { PoolClient } from "pg";
import { type Checkpoint, type CheckpointRow, mapCheckpointRow } from "../types.js";

export interface CheckpointsRepo {
  // Idempotent: Postgres' UNIQUE(execution_id, step_id) constraint is what
  // actually enforces exactly-once (design.md D6/R7 - "Postgres enforces
  // exactly-once, not application code"). On conflict, this re-selects and
  // returns the EXISTING row rather than surfacing a conflict error, so
  // callers (engine.completeExecution) never have to branch on retry.
  insert(executionId: number, stepId: string, output: unknown): Promise<Checkpoint>;
  findByExecutionAndStep(executionId: number, stepId: string): Promise<Checkpoint | null>;
}

export function createCheckpointsRepo(client: PoolClient): CheckpointsRepo {
  async function findByExecutionAndStep(
    executionId: number,
    stepId: string,
  ): Promise<Checkpoint | null> {
    const result = await client.query<CheckpointRow>(
      "SELECT * FROM checkpoints WHERE execution_id = $1 AND step_id = $2",
      [executionId, stepId],
    );
    const row = result.rows[0];
    return row ? mapCheckpointRow(row) : null;
  }

  return {
    async insert(executionId, stepId, output) {
      const result = await client.query<CheckpointRow>(
        `INSERT INTO checkpoints (execution_id, step_id, output)
         VALUES ($1, $2, $3)
         ON CONFLICT (execution_id, step_id) DO NOTHING
         RETURNING *`,
        [executionId, stepId, JSON.stringify(output)],
      );
      const inserted = result.rows[0];
      if (inserted) return mapCheckpointRow(inserted);

      // Conflict hit - the checkpoint already exists (a retried
      // completion). Return the existing row rather than erroring.
      const existing = await findByExecutionAndStep(executionId, stepId);
      if (!existing) {
        throw new Error(
          `checkpoints.insert: conflict on (execution_id=${executionId}, step_id=${stepId}) but no existing row found`,
        );
      }
      return existing;
    },

    findByExecutionAndStep,
  };
}
