import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";

// TC-4/TC-5 (docs/impl-plans/0002-durable-sleep.md): WaitsRepo.signal's
// broadcast-to-every-matching-wait and safe-no-op-on-retry semantics,
// exercised at the repo level (engine.signalWait's own composition with
// claimExecution is covered in test/engine/wait.test.ts).
describe("WaitsRepo", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await tp.pool.query("TRUNCATE executions, checkpoints, waits RESTART IDENTITY");
  });

  async function seedExecution(): Promise<number> {
    const {
      rows: [row],
    } = await tp.pool.query<{ id: string }>(
      `INSERT INTO executions (session_id, step, status) VALUES ('s', 'step', 'waiting') RETURNING id`,
    );
    return Number(row?.id);
  }

  // TC-4: signal() durably broadcasts to EVERY execution waiting on the
  // same key, not just one.
  it("signals every wait matching the given key", async () => {
    const executionIdA = await seedExecution();
    const executionIdB = await seedExecution();

    await withTransaction(tp.pool, async (repos) => {
      await repos.waits.create({ executionId: executionIdA, waitKey: "approval:1" });
      await repos.waits.create({ executionId: executionIdB, waitKey: "approval:1" });
    });

    const signaled = await withTransaction(tp.pool, (repos) => repos.waits.signal("approval:1"));

    expect(signaled).toHaveLength(2);
    expect(signaled.every((w) => w.satisfiedAt !== null)).toBe(true);

    const { rows } = await tp.pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM executions WHERE id IN ($1, $2) ORDER BY id",
      [executionIdA, executionIdB],
    );
    expect(rows.map((r) => r.status)).toEqual(["queued", "queued"]);
  });

  // TC-5: a duplicate/retried signal for an already-satisfied wait is a
  // safe no-op - it must not re-signal, and must not disturb an execution
  // that has since moved on past `queued`.
  it("is a safe no-op when signaling an already-satisfied wait", async () => {
    const executionId = await seedExecution();
    await withTransaction(tp.pool, (repos) =>
      repos.waits.create({ executionId, waitKey: "approval:2" }),
    );

    const firstSignal = await withTransaction(tp.pool, (repos) => repos.waits.signal("approval:2"));
    expect(firstSignal).toHaveLength(1);

    // Simulate the execution having moved on (claimed, then completed)
    // since the first signal, before a retried signal call arrives.
    await tp.pool.query(`UPDATE executions SET status = 'done' WHERE id = $1`, [executionId]);

    const secondSignal = await withTransaction(tp.pool, (repos) =>
      repos.waits.signal("approval:2"),
    );
    expect(secondSignal).toHaveLength(0);

    const { rows } = await tp.pool.query<{ status: string }>(
      "SELECT status FROM executions WHERE id = $1",
      [executionId],
    );
    expect(rows[0]?.status).toBe("done");
  });

  it("signaling an unknown key returns an empty array", async () => {
    const signaled = await withTransaction(tp.pool, (repos) => repos.waits.signal("no-such-key"));
    expect(signaled).toEqual([]);
  });

  it("findByExecutionId returns every wait row for that execution", async () => {
    const executionId = await seedExecution();
    await withTransaction(tp.pool, async (repos) => {
      await repos.waits.create({ executionId, waitKey: "approval:3" });
      await repos.waits.create({ executionId, wakeAt: new Date(Date.now() + 60_000) });
    });

    const waits = await withTransaction(tp.pool, (repos) =>
      repos.waits.findByExecutionId(executionId),
    );
    expect(waits).toHaveLength(2);
    expect(waits.map((w) => w.waitKey).sort()).toEqual(["approval:3", null]);
  });

  // Review finding (docs/impl-plans/0002-durable-sleep.md): wait_key is
  // rejected up front, with a structured error, rather than reaching
  // signal_wait() later where an oversized key would abort pg_notify()'s
  // 8000-byte-capped call entirely.
  it("rejects a waitKey longer than WAIT_KEY_MAX_LENGTH", async () => {
    const executionId = await seedExecution();
    const tooLong = "x".repeat(257);

    await expect(
      withTransaction(tp.pool, (repos) => repos.waits.create({ executionId, waitKey: tooLong })),
    ).rejects.toThrow(/exceeds the maximum allowed length/);

    const waits = await withTransaction(tp.pool, (repos) =>
      repos.waits.findByExecutionId(executionId),
    );
    expect(waits).toHaveLength(0);
  });
});
