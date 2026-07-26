import type { PoolClient } from "pg";
import { ERROR_IDS, FatalError } from "../../shared/index.js";
import { type WorkflowRun, type WorkflowRunRow, mapWorkflowRunRow } from "../domain/index.js";
import {
  SQL_FIND_WORKFLOW_RUN_BY_ID,
  SQL_INSERT_WORKFLOW_RUN,
  SQL_LOCK_WORKFLOW_RUN_FOR_UPDATE,
  SQL_MARK_WORKFLOW_RUN_DONE,
  SQL_MARK_WORKFLOW_RUN_FAILED,
} from "./queries/workflow-runs.queries.js";

export interface WorkflowRunsRepo {
  create(input: { sessionId?: string | null; spec: unknown; input: unknown }): Promise<WorkflowRun>;
  findById(id: number): Promise<WorkflowRun | null>;
  markDone(id: number): Promise<void>;
  markFailed(id: number): Promise<void>;
  // Local-review fix (docs/impl-plans/0006-interpreter-plain-steps.md) -
  // serializes concurrent completeStep calls for the same run. Throws if
  // the run no longer exists (same "no-row-returned" posture as every
  // other repository in this module).
  lockForUpdate(id: number): Promise<WorkflowRun>;
}

// Bound to a caller-owned transaction client (ADR-0002) - never opens its
// own connection, mirroring every other repository in this module.
export function createWorkflowRunsRepo(client: PoolClient): WorkflowRunsRepo {
  return {
    async create({ sessionId, spec, input }) {
      const result = await client.query<WorkflowRunRow>(SQL_INSERT_WORKFLOW_RUN, [
        sessionId ?? null,
        JSON.stringify(spec),
        JSON.stringify(input),
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.CORE_WORKFLOW_RUN_NO_ROW_RETURNED, {
          context: { sessionId },
        });
      }
      return mapWorkflowRunRow(row);
    },

    async findById(id) {
      const result = await client.query<WorkflowRunRow>(SQL_FIND_WORKFLOW_RUN_BY_ID, [id]);
      const row = result.rows[0];
      return row ? mapWorkflowRunRow(row) : null;
    },

    async markDone(id) {
      await client.query(SQL_MARK_WORKFLOW_RUN_DONE, [id]);
    },

    async markFailed(id) {
      await client.query(SQL_MARK_WORKFLOW_RUN_FAILED, [id]);
    },

    async lockForUpdate(id) {
      const result = await client.query<WorkflowRunRow>(SQL_LOCK_WORKFLOW_RUN_FOR_UPDATE, [id]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.CORE_WORKFLOW_RUN_NOT_FOUND, { context: { runId: id } });
      }
      return mapWorkflowRunRow(row);
    },
  };
}
