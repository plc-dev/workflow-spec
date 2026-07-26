import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";

// TC-3/TC-4 groundwork (docs/impl-plans/0006-interpreter-plain-steps.md):
// RunNodeOutputsRepo is the table `{from:"step"}` bindings resolve against
// across node boundaries - deliberately scoped to top-level node ids only
// (design.md D8c).
describe("RunNodeOutputsRepo", () => {
  let tp: TestPostgres;
  let runId: number;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await tp.pool.query(
      "TRUNCATE executions, run_node_outputs, workflow_runs RESTART IDENTITY CASCADE",
    );
    const created = await withTransaction(tp.pool, (repos) =>
      repos.workflowRuns.create({ spec: {}, input: {} }),
    );
    runId = created.id;
  });

  it("record then get round-trips the output", async () => {
    await withTransaction(tp.pool, (repos) =>
      repos.runNodeOutputs.record(runId, "nodeA", { x: 1 }),
    );
    const found = await withTransaction(tp.pool, (repos) =>
      repos.runNodeOutputs.get(runId, "nodeA"),
    );
    expect(found?.output).toEqual({ x: 1 });
  });

  it("get returns null for a node with no recorded output", async () => {
    const found = await withTransaction(tp.pool, (repos) =>
      repos.runNodeOutputs.get(runId, "does-not-exist"),
    );
    expect(found).toBeNull();
  });

  it("record is idempotent for a repeated (runId, nodeId) - returns the existing row, not a conflict error", async () => {
    const first = await withTransaction(tp.pool, (repos) =>
      repos.runNodeOutputs.record(runId, "nodeA", { x: 1 }),
    );
    const second = await withTransaction(tp.pool, (repos) =>
      repos.runNodeOutputs.record(runId, "nodeA", { x: 1 }),
    );
    expect(second.completedAt).toEqual(first.completedAt);

    const count = await tp.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM run_node_outputs WHERE run_id = $1 AND node_id = 'nodeA'`,
      [runId],
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it("listCompletedNodeIds returns exactly the recorded node ids for this run", async () => {
    await withTransaction(tp.pool, (repos) => repos.runNodeOutputs.record(runId, "a", {}));
    await withTransaction(tp.pool, (repos) => repos.runNodeOutputs.record(runId, "b", {}));

    const otherRun = await withTransaction(tp.pool, (repos) =>
      repos.workflowRuns.create({ spec: {}, input: {} }),
    );
    await withTransaction(tp.pool, (repos) => repos.runNodeOutputs.record(otherRun.id, "c", {}));

    const ids = await withTransaction(tp.pool, (repos) =>
      repos.runNodeOutputs.listCompletedNodeIds(runId),
    );
    expect(new Set(ids)).toEqual(new Set(["a", "b"]));
  });
});
