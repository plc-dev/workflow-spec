import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";

describe("WorkflowRunsRepo", () => {
  let tp: TestPostgres;

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
  });

  it("creates a run defaulting to status 'running' and returns it via findById", async () => {
    const created = await withTransaction(tp.pool, (repos) =>
      repos.workflowRuns.create({ spec: { irVersion: 1, name: "n", steps: [] }, input: { a: 1 } }),
    );
    expect(created.status).toBe("running");
    expect(created.sessionId).toBeNull();
    expect(created.spec).toEqual({ irVersion: 1, name: "n", steps: [] });
    expect(created.input).toEqual({ a: 1 });

    const found = await withTransaction(tp.pool, (repos) =>
      repos.workflowRuns.findById(created.id),
    );
    expect(found).toEqual(created);
  });

  it("returns null from findById for a non-existent run", async () => {
    const found = await withTransaction(tp.pool, (repos) => repos.workflowRuns.findById(999_999));
    expect(found).toBeNull();
  });

  it("markDone/markFailed transition status and are each idempotent", async () => {
    const created = await withTransaction(tp.pool, (repos) =>
      repos.workflowRuns.create({ spec: {}, input: {} }),
    );

    await withTransaction(tp.pool, (repos) => repos.workflowRuns.markDone(created.id));
    await withTransaction(tp.pool, (repos) => repos.workflowRuns.markDone(created.id));
    const done = await withTransaction(tp.pool, (repos) => repos.workflowRuns.findById(created.id));
    expect(done?.status).toBe("done");

    const other = await withTransaction(tp.pool, (repos) =>
      repos.workflowRuns.create({ spec: {}, input: {} }),
    );
    await withTransaction(tp.pool, (repos) => repos.workflowRuns.markFailed(other.id));
    const failed = await withTransaction(tp.pool, (repos) => repos.workflowRuns.findById(other.id));
    expect(failed?.status).toBe("failed");
  });
});
