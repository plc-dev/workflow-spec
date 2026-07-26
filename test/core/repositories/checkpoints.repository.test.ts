import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";

// TC-5 (repo level): CheckpointsRepo.insert is idempotent, backed by the
// UNIQUE(execution_id, step_id) constraint (design.md D6/R7 - "Postgres
// enforces exactly-once, not application code"). The engine-level
// composition of this with completeExecution is covered in
// test/engine/claim-complete.test.ts.
describe("CheckpointsRepo.insert", () => {
  let tp: TestPostgres;
  let executionId: number;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await tp.pool.query("TRUNCATE executions, checkpoints, waits RESTART IDENTITY");
    const {
      rows: [row],
    } = await tp.pool.query<{ id: string }>(
      `INSERT INTO executions (session_id, step) VALUES ('s', 'step') RETURNING id`,
    );
    executionId = Number(row?.id);
  });

  it("returns the existing row on a repeated insert for the same (executionId, stepId)", async () => {
    const first = await withTransaction(tp.pool, (repos) =>
      repos.checkpoints.insert(executionId, "step-a", { value: 1 }),
    );
    const second = await withTransaction(tp.pool, (repos) =>
      repos.checkpoints.insert(executionId, "step-a", { value: 1 }),
    );

    expect(second.committedAt).toEqual(first.committedAt);

    const countResult = await tp.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM checkpoints WHERE execution_id = $1 AND step_id = 'step-a'`,
      [executionId],
    );
    expect(countResult.rows[0]?.count).toBe(1);
  });
});
