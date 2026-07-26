import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/core/index.js";
import { claimExecution, signalWait, waitFor } from "../../src/engine/index.js";
import { type TestPostgres, startTestPostgres } from "../helpers/postgres.js";
import { resetExecutionTables } from "../helpers/reset.js";

describe("engine.waitFor / signalWait", () => {
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

  async function seedAndClaim(): Promise<number> {
    await tp.pool.query(`INSERT INTO executions (session_id, step) VALUES ('s', 'step')`);
    const executionId = await withTransaction(tp.pool, async (repos) => {
      const execution = await claimExecution(repos, "worker-1");
      if (!execution) throw new Error("expected an execution to claim");
      return execution.id;
    });
    return executionId;
  }

  // TC-2: a timer-only wait is not claimable before wake_at, and IS
  // claimable (via claim_execution()'s EXISTS branch, no separate
  // sweeper) once wake_at has passed.
  it("does not become claimable before wake_at, and is claimed after wake_at passes", async () => {
    const executionId = await seedAndClaim();

    await withTransaction(tp.pool, (repos) =>
      waitFor(repos, executionId, { wakeAt: new Date(Date.now() + 60_000) }),
    );

    const tooSoon = await withTransaction(tp.pool, (repos) => claimExecution(repos, "worker-2"));
    expect(tooSoon).toBeNull();

    // Move the wait's wake_at into the past directly (avoids a real sleep
    // in the test) - equivalent to time having passed.
    await tp.pool.query(`UPDATE waits SET wake_at = now() - interval '1 second'`);

    const reclaimed = await withTransaction(tp.pool, (repos) => claimExecution(repos, "worker-2"));
    expect(reclaimed?.id).toBe(executionId);
    expect(reclaimed?.status).toBe("running");

    const waits = await withTransaction(tp.pool, (repos) =>
      repos.waits.findByExecutionId(executionId),
    );
    expect(waits[0]?.satisfiedAt).not.toBeNull();
  });

  // TC-3: a signal-only wait is never claimed by polling alone - only
  // signalWait wakes it.
  it("never becomes claimable via polling alone for a signal-only wait", async () => {
    const executionId = await seedAndClaim();

    await withTransaction(tp.pool, (repos) =>
      waitFor(repos, executionId, { waitKey: "approval:1" }),
    );

    const notClaimed = await withTransaction(tp.pool, (repos) => claimExecution(repos, "worker-2"));
    expect(notClaimed).toBeNull();

    await withTransaction(tp.pool, (repos) => signalWait(repos, "approval:1"));

    const claimed = await withTransaction(tp.pool, (repos) => claimExecution(repos, "worker-2"));
    expect(claimed?.id).toBe(executionId);
  });

  // TC-6: a mid-transaction crash during waitFor rolls back exactly like
  // claim/completeExecution's own crash test (test/engine/claim-complete
  // .test.ts) - the execution reverts to its pre-wait status, and no
  // waits row survives.
  it("rolls back waitFor entirely on a mid-transaction crash", async () => {
    const executionId = await seedAndClaim();

    await expect(
      withTransaction(tp.pool, async (repos) => {
        await waitFor(repos, executionId, { waitKey: "approval:2" });

        const pidResult = await repos.client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = pidResult.rows[0]?.pid;
        await tp.adminPool.query("SELECT pg_terminate_backend($1)", [pid]);
        await repos.client.query("SELECT 1");
      }),
    ).rejects.toThrow();

    const { rows } = await tp.pool.query<{ status: string }>(
      "SELECT status FROM executions WHERE id = $1",
      [executionId],
    );
    expect(rows[0]?.status).toBe("running");

    const waits = await withTransaction(tp.pool, (repos) =>
      repos.waits.findByExecutionId(executionId),
    );
    expect(waits).toHaveLength(0);
  });

  // TC-7: claim_execution()'s new due-timer-wait branch preserves the
  // existing no-double-claim guarantee under contention (mirrors 0001's
  // own TC-2 for the pre-existing claimable shapes).
  it("claims a due timer-wait execution exactly once under concurrent claim attempts", async () => {
    const executionId = await seedAndClaim();
    await withTransaction(tp.pool, (repos) =>
      waitFor(repos, executionId, { wakeAt: new Date(Date.now() - 1_000) }),
    );

    const workerCount = 8;
    const results = await Promise.all(
      Array.from({ length: workerCount }, (_, i) =>
        withTransaction(tp.pool, (repos) => claimExecution(repos, `worker-${i}`)),
      ),
    );

    const claimants = results.filter((r) => r !== null);
    expect(claimants).toHaveLength(1);
    expect(claimants[0]?.id).toBe(executionId);
  });

  // TC-8: a hybrid wait (both wakeAt and waitKey set) is claimable via
  // EITHER path; whichever fires first satisfies it, and the other path
  // becomes a no-op afterward.
  it("is claimable via signalWait even with a future wake_at also set (hybrid wait)", async () => {
    const executionId = await seedAndClaim();

    await withTransaction(tp.pool, (repos) =>
      waitFor(repos, executionId, {
        waitKey: "approval:3",
        wakeAt: new Date(Date.now() + 60_000),
      }),
    );

    // Timer path has not fired yet - not claimable by polling alone.
    const tooSoon = await withTransaction(tp.pool, (repos) => claimExecution(repos, "worker-2"));
    expect(tooSoon).toBeNull();

    // Signal path fires first.
    const signaled = await withTransaction(tp.pool, (repos) => signalWait(repos, "approval:3"));
    expect(signaled).toHaveLength(1);

    const claimed = await withTransaction(tp.pool, (repos) => claimExecution(repos, "worker-2"));
    expect(claimed?.id).toBe(executionId);

    // The timer path is now moot - even though wake_at is still in the
    // future, the execution has already moved past `waiting` (it's
    // `running` now), so there is nothing left for the timer branch to do.
    const { rows } = await tp.pool.query<{ status: string }>(
      "SELECT status FROM executions WHERE id = $1",
      [executionId],
    );
    expect(rows[0]?.status).toBe("running");
  });

  // Review finding (docs/impl-plans/0002-durable-sleep.md): claim_execution()
  // and signal_wait() must lock executions/waits rows in the SAME order,
  // or a due-timer claim racing a same-key signal on the same hybrid wait
  // can deadlock. Repeated across many hybrid waits, concurrently claimed
  // and signaled at the same time, to make the race window realistic to
  // hit rather than relying on one lucky interleaving.
  it("does not deadlock when a due timer claim races a same-key signal on the same hybrid wait", async () => {
    const waitCount = 20;
    const executionIds: number[] = [];
    // Seeded with wake_at in the FUTURE, not the past - otherwise each
    // freshly-`waiting` row from an earlier loop iteration would
    // immediately become claimable again (claim_execution() picks the
    // lowest-id claimable row first) and get claimed by THIS setup loop's
    // own next iteration instead of the newly-inserted execution it meant
    // to claim. Moved into the past afterward, in one bulk update, right
    // before firing the actual concurrent race below.
    for (let i = 0; i < waitCount; i++) {
      await tp.pool.query(`INSERT INTO executions (session_id, step) VALUES ('s', 'step')`);
      const executionId = await withTransaction(tp.pool, async (repos) => {
        const execution = await claimExecution(repos, "worker-1");
        if (!execution) throw new Error("expected an execution to claim");
        await waitFor(repos, execution.id, {
          waitKey: "hybrid-race-key",
          wakeAt: new Date(Date.now() + 60_000),
        });
        return execution.id;
      });
      executionIds.push(executionId);
    }
    await tp.pool.query(
      `UPDATE waits SET wake_at = now() - interval '1 second' WHERE wait_key = 'hybrid-race-key'`,
    );

    // Fire every due-timer claim attempt and the one broadcasting signal
    // concurrently - this is exactly the interleaving that would deadlock
    // under mismatched lock ordering.
    const claimAttempts = executionIds.map((_, i) =>
      withTransaction(tp.pool, (repos) => claimExecution(repos, `worker-${i}`)),
    );
    const signalAttempt = withTransaction(tp.pool, (repos) => signalWait(repos, "hybrid-race-key"));

    // The important assertion: no `deadlock detected` (or any other)
    // error surfaces from the concurrent claim/signal race.
    await expect(Promise.all([...claimAttempts, signalAttempt])).resolves.toBeDefined();

    // Mop up: SKIP LOCKED means an individual single-shot claim attempt
    // can legitimately come back empty if it happened to run while every
    // currently-claimable row was momentarily locked by a sibling
    // attempt - that's a timing artifact of firing `waitCount` one-shot
    // claims concurrently, not a correctness bug. Repeat until nothing is
    // left claimable, then assert every execution genuinely ended up
    // `running` - none silently stuck in `waiting` or `queued`.
    for (let i = 0; i < waitCount; i++) {
      const claimed = await withTransaction(tp.pool, (repos) =>
        claimExecution(repos, "worker-mop-up"),
      );
      if (!claimed) break;
    }

    const { rows } = await tp.pool.query<{ status: string; count: string }>(
      "SELECT status, count(*) AS count FROM executions WHERE id = ANY($1) GROUP BY status",
      [executionIds],
    );
    expect(rows).toEqual([{ status: "running", count: String(waitCount) }]);
  });
});
