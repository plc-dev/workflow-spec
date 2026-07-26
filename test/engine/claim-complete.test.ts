import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/core/index.js";
import { claimExecution, completeExecution } from "../../src/engine/index.js";
import { type TestPostgres, startTestPostgres } from "../helpers/postgres.js";

describe("engine.claimExecution / completeExecution", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await tp.pool.query("TRUNCATE executions, checkpoints RESTART IDENTITY");
  });

  it("claims and completes an execution end to end", async () => {
    await tp.pool.query(`INSERT INTO executions (session_id, step) VALUES ('s', 'step')`);

    const checkpoint = await withTransaction(tp.pool, async (repos) => {
      const execution = await claimExecution(repos, "worker-1");
      if (!execution) throw new Error("expected an execution to claim");
      return completeExecution(repos, {
        executionId: execution.id,
        stepId: "the-step",
        output: { result: 42 },
      });
    });

    expect(checkpoint.output).toEqual({ result: 42 });

    const { rows } = await tp.pool.query<{ status: string }>(
      "SELECT status FROM executions WHERE id = $1",
      [checkpoint.executionId],
    );
    expect(rows[0]?.status).toBe("done");
  });

  // TC-5 (engine level): completing the same execution/step twice is
  // idempotent - exactly one checkpoint, execution stays `done`, no error
  // surfaced (design.md D6/R7 - Postgres enforces exactly-once).
  it("is idempotent when completeExecution is called twice for the same execution/step", async () => {
    await tp.pool.query(`INSERT INTO executions (session_id, step) VALUES ('s', 'step')`);

    const executionId = await withTransaction(tp.pool, async (repos) => {
      const execution = await claimExecution(repos, "worker-1");
      if (!execution) throw new Error("expected an execution to claim");
      await completeExecution(repos, {
        executionId: execution.id,
        stepId: "the-step",
        output: { result: 1 },
      });
      return execution.id;
    });

    // A retried completion (e.g. the caller never observed the first
    // COMMIT's success and retries) - simulated as a second, independent
    // transaction rather than a second claim, since the execution is
    // already `done` and wouldn't be re-claimable anyway.
    await withTransaction(tp.pool, async (repos) => {
      await completeExecution(repos, {
        executionId,
        stepId: "the-step",
        output: { result: 1 },
      });
    });

    const checkpointCount = await tp.pool.query(
      `SELECT count(*)::int AS c FROM checkpoints WHERE execution_id = $1 AND step_id = 'the-step'`,
      [executionId],
    );
    expect(checkpointCount.rows[0]?.c).toBe(1);

    const { rows } = await tp.pool.query<{ status: string }>(
      "SELECT status FROM executions WHERE id = $1",
      [executionId],
    );
    expect(rows[0]?.status).toBe("done");
  });

  // TC-4: a mid-transaction crash (pg_terminate_backend before COMMIT,
  // mirroring spike 1.2's own crash test) rolls back the claim itself - the
  // execution reverts all the way to `queued` (not stuck `running`), and no
  // partial checkpoint survives. Design.md D6/R6 - DEEP atomicity, immediate
  // recovery, no lease wait needed.
  it("rolls back the claim itself on a mid-transaction crash, with no partial checkpoint", async () => {
    const {
      rows: [seeded],
    } = await tp.pool.query<{ id: string }>(
      `INSERT INTO executions (session_id, step) VALUES ('s', 'step') RETURNING id`,
    );
    const executionId = Number(seeded?.id);

    await expect(
      withTransaction(tp.pool, async (repos) => {
        const execution = await claimExecution(repos, "worker-doomed");
        if (!execution) throw new Error("expected an execution to claim");
        await completeExecution(repos, {
          executionId: execution.id,
          stepId: "the-step",
          output: { result: 1 },
        });

        const pidResult = await repos.client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = pidResult.rows[0]?.pid;
        await tp.adminPool.query("SELECT pg_terminate_backend($1)", [pid]);

        // The next query on this now-dead connection is what actually
        // surfaces the failure (matching spike 1.2's own crash-test shape).
        await repos.client.query("SELECT 1");
      }),
    ).rejects.toThrow();

    const { rows } = await tp.pool.query<{ status: string }>(
      "SELECT status FROM executions WHERE id = $1",
      [executionId],
    );
    expect(rows[0]?.status).toBe("queued");

    const checkpointCount = await tp.pool.query(
      "SELECT count(*)::int AS c FROM checkpoints WHERE execution_id = $1",
      [executionId],
    );
    expect(checkpointCount.rows[0]?.c).toBe(0);

    // Immediate recovery, no lease wait needed - a second worker can claim
    // it right away.
    const reclaimed = await withTransaction(tp.pool, (repos) => claimExecution(repos, "worker-2"));
    expect(reclaimed?.id).toBe(executionId);
  });

  // TC-7: a third, ad hoc write on the SAME transaction's raw client
  // (standing in for a future session/scheduler write) commits/rolls back
  // together with claim/complete - proving the composability SHAPE
  // (ADR-0002/ADR-0007), even with no real third consumer yet.
  it("commits an interleaved raw write on the same transaction as claim/complete", async () => {
    await tp.pool.query(`INSERT INTO executions (session_id, step) VALUES ('s', 'step')`);

    const executionId = await withTransaction(tp.pool, async (repos) => {
      const execution = await claimExecution(repos, "worker-1");
      if (!execution) throw new Error("expected an execution to claim");

      // Stand-in for a future session/scheduler write sharing this
      // transaction - a raw query via the same client, no repo of its own.
      await repos.client.query(
        `INSERT INTO checkpoints (execution_id, step_id, output) VALUES ($1, 'interleaved-marker', '{}')`,
        [execution.id],
      );

      await completeExecution(repos, {
        executionId: execution.id,
        stepId: "the-step",
        output: { result: 1 },
      });
      return execution.id;
    });

    const { rows } = await tp.pool.query<{ step_id: string }>(
      "SELECT step_id FROM checkpoints WHERE execution_id = $1 ORDER BY step_id",
      [executionId],
    );
    expect(rows.map((r) => r.step_id)).toEqual(["interleaved-marker", "the-step"]);
  });

  it("rolls back an interleaved raw write together with claim/complete on crash", async () => {
    const {
      rows: [seeded],
    } = await tp.pool.query<{ id: string }>(
      `INSERT INTO executions (session_id, step) VALUES ('s', 'step') RETURNING id`,
    );
    const executionId = Number(seeded?.id);

    await expect(
      withTransaction(tp.pool, async (repos) => {
        const execution = await claimExecution(repos, "worker-doomed");
        if (!execution) throw new Error("expected an execution to claim");

        await repos.client.query(
          `INSERT INTO checkpoints (execution_id, step_id, output) VALUES ($1, 'interleaved-marker', '{}')`,
          [execution.id],
        );

        const pidResult = await repos.client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = pidResult.rows[0]?.pid;
        await tp.adminPool.query("SELECT pg_terminate_backend($1)", [pid]);
        await repos.client.query("SELECT 1");
      }),
    ).rejects.toThrow();

    const checkpointCount = await tp.pool.query(
      "SELECT count(*)::int AS c FROM checkpoints WHERE execution_id = $1",
      [executionId],
    );
    expect(checkpointCount.rows[0]?.c).toBe(0);
  });
});
