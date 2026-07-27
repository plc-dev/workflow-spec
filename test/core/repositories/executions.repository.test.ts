import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";
import { resetExecutionAndWorkflowRunTables, resetExecutionTables } from "../../helpers/reset.js";

describe("ExecutionsRepo.claim", () => {
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

  // TC-2: N queued executions, M >= N concurrent claimers - exactly-once
  // claim, no double-claim (design.md D6 "THE PATTERN": SKIP LOCKED is the
  // entire dispatcher; R10: distributed, load-balanced workers).
  it("claims each of N queued executions exactly once across concurrent workers", async () => {
    const N = 40;
    const WORKERS = 8;

    for (let i = 0; i < N; i++) {
      await tp.pool.query(
        `INSERT INTO executions (session_id, step, input) VALUES ('s', 'step', $1)`,
        [JSON.stringify({ i })],
      );
    }

    const claimedIds: number[] = [];

    async function workerLoop(workerId: string) {
      for (;;) {
        const claimed = await withTransaction(tp.pool, async (repos) => {
          return repos.executions.claim(workerId);
        });
        if (!claimed) return;
        claimedIds.push(claimed.id);
      }
    }

    await Promise.all(Array.from({ length: WORKERS }, (_, i) => workerLoop(`worker-${i}`)));

    expect(claimedIds).toHaveLength(N);
    expect(new Set(claimedIds).size).toBe(N); // no id claimed twice
  });

  // TC-3: a committed claim whose worker then goes dark (lease expires) is
  // a genuinely different failure shape from a mid-transaction crash
  // (TC-4) - reclaimed via lease-expiry, no sweeper, no duplicate
  // checkpoint (design.md R7).
  it("reclaims an execution via lease-expiry after its worker goes dark", async () => {
    await tp.pool.query(`INSERT INTO executions (session_id, step) VALUES ('s', 'step')`);

    // Worker A claims with a 1-second lease and never completes (commits
    // the claim itself, then "dies").
    const firstClaim = await withTransaction(tp.pool, async (repos) => {
      return repos.executions.claim("worker-a", 1);
    });
    expect(firstClaim).not.toBeNull();
    expect(firstClaim?.status).toBe("running");

    // Immediately re-claiming must NOT succeed - the lease hasn't expired.
    const tooSoon = await withTransaction(tp.pool, (repos) => repos.executions.claim("worker-b"));
    expect(tooSoon).toBeNull();

    // Wait past the 1-second lease, then a second worker reclaims it.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const reclaimed = await withTransaction(tp.pool, (repos) => repos.executions.claim("worker-b"));
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.id).toBe(firstClaim?.id);
    expect(reclaimed?.workerId).toBe("worker-b");
    expect(reclaimed?.attempts).toBe(2);
  });
});

// Package 0011 (docs/impl-plans/0011-worker-cli-dispatch.md) - the
// terminal counterpart to markDone, added because apps/worker needs a
// way to end a step in a non-retrying way when the exec-agent reports a
// genuine (non-transient) failure. 'failed' was already a valid
// executions.status CHECK-constraint value with no writer until this
// package.
describe("ExecutionsRepo.markFailed", () => {
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

  it("transitions a running execution to failed, and is idempotent", async () => {
    const inserted = await tp.pool.query(
      `INSERT INTO executions (session_id, step, status) VALUES ('s', 'step', 'running') RETURNING id`,
    );
    const id = inserted.rows[0].id;

    await withTransaction(tp.pool, (repos) => repos.executions.markFailed(id));
    const afterFirst = await withTransaction(tp.pool, (repos) => repos.executions.findById(id));
    expect(afterFirst?.status).toBe("failed");

    // Idempotent - calling it again on an already-failed row is a no-op
    // write, not an error (mirrors SQL_MARK_EXECUTION_DONE's own posture).
    await withTransaction(tp.pool, (repos) => repos.executions.markFailed(id));
    const afterSecond = await withTransaction(tp.pool, (repos) => repos.executions.findById(id));
    expect(afterSecond?.status).toBe("failed");
  });
});

// Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md) -
// stops a failed run's other not-yet-claimed executions from staying
// claimable (claim_execution() has no join to workflow_runs.status).
describe("ExecutionsRepo.failRemainingForRun", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await resetExecutionAndWorkflowRunTables(tp.pool);
  });

  it("transitions every blocked/queued/waiting execution of a run to failed, leaving other runs and 'running' rows untouched", async () => {
    const run = await tp.pool.query(
      `INSERT INTO workflow_runs (spec, input) VALUES ('{}', '{}') RETURNING id`,
    );
    const runId = run.rows[0].id;
    const otherRun = await tp.pool.query(
      `INSERT INTO workflow_runs (spec, input) VALUES ('{}', '{}') RETURNING id`,
    );
    const otherRunId = otherRun.rows[0].id;

    const rows = await tp.pool.query(
      `INSERT INTO executions (session_id, run_id, step, status) VALUES
         ('s', $1, 'queued-step', 'queued'),
         ('s', $1, 'blocked-step', 'blocked'),
         ('s', $1, 'waiting-step', 'waiting'),
         ('s', $1, 'running-step', 'running'),
         ('s', $2, 'other-run-step', 'queued')
       RETURNING id, step`,
      [runId, otherRunId],
    );
    const idFor = (step: string) => rows.rows.find((r) => r.step === step).id;

    await withTransaction(tp.pool, (repos) => repos.executions.failRemainingForRun(runId));

    const statusOf = async (id: number) =>
      (await withTransaction(tp.pool, (repos) => repos.executions.findById(id)))?.status;

    expect(await statusOf(idFor("queued-step"))).toBe("failed");
    expect(await statusOf(idFor("blocked-step"))).toBe("failed");
    expect(await statusOf(idFor("waiting-step"))).toBe("failed");
    // 'running' is deliberately left alone - another worker may be
    // actively dispatching it right now.
    expect(await statusOf(idFor("running-step"))).toBe("running");
    // A different run's execution is never touched.
    expect(await statusOf(idFor("other-run-step"))).toBe("queued");
  });
});
