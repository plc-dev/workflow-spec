import type { PoolClient } from "pg";
import { ERROR_IDS, FatalError } from "../../shared/index.js";
import { type RunNodeOutput, type RunNodeOutputRow, mapRunNodeOutputRow } from "../domain/index.js";
import {
  SQL_FIND_RUN_NODE_OUTPUT,
  SQL_INSERT_RUN_NODE_OUTPUT,
  SQL_LIST_COMPLETED_NODE_IDS,
} from "./queries/run-node-outputs.queries.js";

export interface RunNodeOutputsRepo {
  // Idempotent - see SQL_INSERT_RUN_NODE_OUTPUT's own comment.
  record(runId: number, nodeId: string, output: unknown): Promise<RunNodeOutput>;
  get(runId: number, nodeId: string): Promise<RunNodeOutput | null>;
  listCompletedNodeIds(runId: number): Promise<string[]>;
}

// Bound to a caller-owned transaction client (ADR-0002) - never opens its
// own connection, mirroring every other repository in this module.
export function createRunNodeOutputsRepo(client: PoolClient): RunNodeOutputsRepo {
  async function get(runId: number, nodeId: string): Promise<RunNodeOutput | null> {
    const result = await client.query<RunNodeOutputRow>(SQL_FIND_RUN_NODE_OUTPUT, [runId, nodeId]);
    const row = result.rows[0];
    return row ? mapRunNodeOutputRow(row) : null;
  }

  return {
    async record(runId, nodeId, output) {
      const result = await client.query<RunNodeOutputRow>(SQL_INSERT_RUN_NODE_OUTPUT, [
        runId,
        nodeId,
        JSON.stringify(output),
      ]);
      const inserted = result.rows[0];
      if (inserted) return mapRunNodeOutputRow(inserted);

      // Conflict hit - already recorded (a retried completion). Return
      // the existing row rather than erroring, mirroring
      // CheckpointsRepo.insert's own idempotency posture.
      const existing = await get(runId, nodeId);
      if (!existing) {
        throw new FatalError(ERROR_IDS.CORE_RUN_NODE_OUTPUT_NO_ROW_RETURNED, {
          context: { runId, nodeId },
        });
      }
      return existing;
    },

    get,

    async listCompletedNodeIds(runId) {
      const result = await client.query<{ node_id: string }>(SQL_LIST_COMPLETED_NODE_IDS, [runId]);
      return result.rows.map((r) => r.node_id);
    },
  };
}
