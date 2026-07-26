import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";
import { resetExecutionTables } from "../../helpers/reset.js";

// TC-6: withTransaction's atomicity guarantee, generalized beyond
// claim/complete's own use of it (ADR-0002) - matters because session/ and
// scheduler/ will later add their OWN writes into this same `fn`.
describe("core.withTransaction", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await resetExecutionTables(tp.pool);
  });

  it("commits writes from both repos together on success", async () => {
    const executionId = await withTransaction(tp.pool, async (repos) => {
      const exec = await repos.executions.enqueue({ sessionId: "s", step: "step", input: {} });
      await repos.checkpoints.insert(exec.id, "step-a", { ok: true });
      return exec.id;
    });

    const execCount = await tp.pool.query(
      "SELECT count(*)::int AS c FROM executions WHERE id = $1",
      [executionId],
    );
    const checkpointCount = await tp.pool.query(
      "SELECT count(*)::int AS c FROM checkpoints WHERE execution_id = $1",
      [executionId],
    );
    expect(execCount.rows[0]?.c).toBe(1);
    expect(checkpointCount.rows[0]?.c).toBe(1);
  });

  it("rolls back writes from both repos together when fn throws", async () => {
    await expect(
      withTransaction(tp.pool, async (repos) => {
        const exec = await repos.executions.enqueue({ sessionId: "s", step: "step", input: {} });
        await repos.checkpoints.insert(exec.id, "step-a", { ok: true });
        throw new Error("simulated failure after both writes");
      }),
    ).rejects.toThrow("simulated failure after both writes");

    const execCount = await tp.pool.query("SELECT count(*)::int AS c FROM executions");
    const checkpointCount = await tp.pool.query("SELECT count(*)::int AS c FROM checkpoints");
    expect(execCount.rows[0]?.c).toBe(0);
    expect(checkpointCount.rows[0]?.c).toBe(0);
  });
});
