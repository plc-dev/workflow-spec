import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestPostgres, startTestPostgres } from "../helpers/postgres.js";

// TC-1 (docs/impl-plans/0001-durable-core.md): applying schema.sql fresh
// produces the tables/constraints/function ADR-0002's consolidated-schema
// contract depends on - a structural precondition for every other test.
describe("core/schema.sql", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  it("creates executions and checkpoints tables", async () => {
    const result = await tp.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('executions', 'checkpoints')
       ORDER BY table_name`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual(["checkpoints", "executions"]);
  });

  it("enforces the executions.status CHECK constraint", async () => {
    await expect(
      tp.pool.query(
        `INSERT INTO executions (session_id, step, status) VALUES ('s', 'step', 'bogus')`,
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("enforces UNIQUE(execution_id, step_id) on checkpoints", async () => {
    const {
      rows: [exec],
    } = await tp.pool.query<{ id: string }>(
      `INSERT INTO executions (session_id, step) VALUES ('s', 'step') RETURNING id`,
    );
    await tp.pool.query(
      `INSERT INTO checkpoints (execution_id, step_id, output) VALUES ($1, 'step-a', '{}')`,
      [exec?.id],
    );
    await expect(
      tp.pool.query(
        `INSERT INTO checkpoints (execution_id, step_id, output) VALUES ($1, 'step-a', '{}')`,
        [exec?.id],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it("exposes claim_execution() as a callable function", async () => {
    const result = await tp.pool.query(
      `SELECT proname FROM pg_proc WHERE proname = 'claim_execution'`,
    );
    expect(result.rows).toHaveLength(1);
  });
});
