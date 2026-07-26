import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/core/tx.js";
import { type TestPostgres, startTestPostgres } from "../helpers/postgres.js";

describe("ExecutionsRepo.claim", () => {
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
