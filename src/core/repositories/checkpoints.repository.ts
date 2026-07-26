import type { PoolClient } from "pg";
import { ERROR_IDS, FatalError } from "../../shared/index.js";
import { type Checkpoint, type CheckpointRow, mapCheckpointRow } from "../domain/index.js";
import {
  SQL_FIND_CHECKPOINT_BY_EXECUTION_AND_STEP,
  SQL_INSERT_CHECKPOINT,
} from "./queries/checkpoints.queries.js";

export interface CheckpointsRepo {
  // Idempotent - see SQL_INSERT_CHECKPOINT's own comment for why.
  insert(executionId: number, stepId: string, output: unknown): Promise<Checkpoint>;
  findByExecutionAndStep(executionId: number, stepId: string): Promise<Checkpoint | null>;
}

export function createCheckpointsRepo(client: PoolClient): CheckpointsRepo {
  async function findByExecutionAndStep(
    executionId: number,
    stepId: string,
  ): Promise<Checkpoint | null> {
    const result = await client.query<CheckpointRow>(SQL_FIND_CHECKPOINT_BY_EXECUTION_AND_STEP, [
      executionId,
      stepId,
    ]);
    const row = result.rows[0];
    return row ? mapCheckpointRow(row) : null;
  }

  return {
    async insert(executionId, stepId, output) {
      const result = await client.query<CheckpointRow>(SQL_INSERT_CHECKPOINT, [
        executionId,
        stepId,
        JSON.stringify(output),
      ]);
      const inserted = result.rows[0];
      if (inserted) return mapCheckpointRow(inserted);

      // Conflict hit - the checkpoint already exists (a retried
      // completion). Return the existing row rather than erroring.
      const existing = await findByExecutionAndStep(executionId, stepId);
      if (!existing) {
        throw new FatalError(ERROR_IDS.CORE_CHECKPOINT_CONFLICT_NOT_FOUND, {
          context: { executionId, stepId },
        });
      }
      return existing;
    },

    findByExecutionAndStep,
  };
}
