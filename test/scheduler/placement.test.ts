import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/core/index.js";
import {
  demote,
  effectiveRehydrationCostMs,
  evaluateDemotion,
  evaluatePromotion,
  evictLRUIfOverCapacity,
  promote,
  recordAccess,
  resolvePlacement,
} from "../../src/scheduler/index.js";
import { type TestPostgres, startTestPostgres } from "../helpers/postgres.js";

describe("scheduler/placement", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await tp.pool.query("TRUNCATE placement, placement_access RESTART IDENTITY");
  });

  // TC-2: a resolver miss is never an error - the affinity-is-always-an-
  // optimization contract (design.md D4).
  it("resolvePlacement on a never-seen content hash returns a non-error miss", async () => {
    const resolution = await withTransaction(tp.pool, (repos) =>
      resolvePlacement(repos, "no-such-hash"),
    );
    expect(resolution).toEqual({
      found: false,
      warm: false,
      contentHash: "no-such-hash",
      reason: "no-placement",
    });
  });

  it("resolvePlacement reports warm-replica when a replicaId is bound, cold-fact otherwise", async () => {
    await withTransaction(tp.pool, (repos) => recordAccess(repos, "warm", { replicaId: "pod-1" }));
    await withTransaction(tp.pool, (repos) => recordAccess(repos, "cold"));

    const warm = await withTransaction(tp.pool, (repos) => resolvePlacement(repos, "warm"));
    expect(warm.found).toBe(true);
    expect(warm.warm).toBe(true);
    expect(warm.reason).toBe("warm-replica");

    const cold = await withTransaction(tp.pool, (repos) => resolvePlacement(repos, "cold"));
    expect(cold.found).toBe(true);
    expect(cold.warm).toBe(false);
    expect(cold.reason).toBe("cold-fact");
  });

  // TC-4: effectiveRehydrationCostMs's declared-prior-until-enough-
  // observed-samples authority rule (D4a).
  it("effectiveRehydrationCostMs falls back declared-prior -> observed -> unknown as samples accumulate", async () => {
    const contentHash = "cost-hash";

    // No cost information at all yet.
    let placement = await withTransaction(tp.pool, (repos) => recordAccess(repos, contentHash, {}));
    let cost = effectiveRehydrationCostMs(placement, {
      promotion: {
        frequencyThreshold: 3,
        frequencyWindowMs: 420_000,
        rehydrationCostThresholdMs: 250,
      },
      demotion: { idleThresholdMs: 1_200_000 },
      capacity: { pinnedBudgetBytes: 1_073_741_824 },
      cost: {
        observedMinSamples: 3,
        classPriorsMs: { trivial: 10, cheap: 50, moderate: 300, expensive: 2000 },
      },
    });
    expect(cost).toEqual({ costMs: null, source: "unknown" });

    // A declared cost class, but fewer than observedMinSamples real timings.
    placement = await withTransaction(tp.pool, (repos) =>
      recordAccess(repos, contentHash, {
        declaredCostClass: "expensive",
        observedRehydrationMs: 1000,
      }),
    );
    const config = {
      promotion: {
        frequencyThreshold: 3,
        frequencyWindowMs: 420_000,
        rehydrationCostThresholdMs: 250,
      },
      demotion: { idleThresholdMs: 1_200_000 },
      capacity: { pinnedBudgetBytes: 1_073_741_824 },
      cost: {
        observedMinSamples: 3,
        classPriorsMs: { trivial: 10, cheap: 50, moderate: 300, expensive: 2000 },
      },
    };
    cost = effectiveRehydrationCostMs(placement, config);
    expect(cost).toEqual({ costMs: 2000, source: "declared-prior" });

    // Feed enough samples to cross observedMinSamples (3): total 3 calls
    // with observedRehydrationMs so far (this is the 2nd) - add 2 more.
    placement = await withTransaction(tp.pool, (repos) =>
      recordAccess(repos, contentHash, { observedRehydrationMs: 1000 }),
    );
    placement = await withTransaction(tp.pool, (repos) =>
      recordAccess(repos, contentHash, { observedRehydrationMs: 1000 }),
    );
    cost = effectiveRehydrationCostMs(placement, config);
    expect(placement.observedSampleCount).toBeGreaterThanOrEqual(3);
    expect(cost).toEqual({ costMs: 1000, source: "observed" });
  });

  const testConfig = {
    promotion: {
      frequencyThreshold: 3,
      frequencyWindowMs: 420_000,
      rehydrationCostThresholdMs: 250,
    },
    demotion: { idleThresholdMs: 1_200_000 },
    capacity: { pinnedBudgetBytes: 250 },
    cost: {
      observedMinSamples: 5,
      classPriorsMs: { trivial: 10, cheap: 50, moderate: 300, expensive: 2000 },
    },
  };

  // TC-5: promotion requires ALL of interactive + cost-above-threshold +
  // frequency-above-threshold; evaluating is a pure read; promote() pins.
  it("evaluatePromotion qualifies an interactive, expensive, frequently-accessed hash - and does not itself mutate", async () => {
    const contentHash = "promote-me";
    for (let i = 0; i < 3; i++) {
      await withTransaction(tp.pool, (repos) =>
        recordAccess(repos, contentHash, {
          interactivity: "interactive",
          declaredCostClass: "expensive",
        }),
      );
    }

    const decision = await withTransaction(tp.pool, (repos) =>
      evaluatePromotion(repos, contentHash, testConfig),
    );
    expect(decision).toMatchObject({ promote: true, reason: "qualifies" });

    const stillUnpinned = await withTransaction(tp.pool, (repos) =>
      resolvePlacement(repos, contentHash),
    );
    expect(stillUnpinned.placement?.pinned).toBe(false);

    const placement = await withTransaction(tp.pool, (repos) => promote(repos, contentHash));
    expect(placement.pinned).toBe(true);
  });

  // TC-6: a batch-declared binding never promotes regardless of frequency.
  it("evaluatePromotion never promotes a batch-declared binding", async () => {
    const contentHash = "batch-hash";
    for (let i = 0; i < 6; i++) {
      await withTransaction(tp.pool, (repos) =>
        recordAccess(repos, contentHash, {
          interactivity: "batch",
          declaredCostClass: "expensive",
        }),
      );
    }

    const decision = await withTransaction(tp.pool, (repos) =>
      evaluatePromotion(repos, contentHash, testConfig),
    );
    expect(decision).toMatchObject({ promote: false, reason: "not-interactive" });
  });

  // TC-7: hysteresis - promotion window (7 min) shorter than demotion idle
  // threshold (20 min) means an idle-10-min entry is not demoted, but an
  // idle-25-min entry is.
  it("evaluateDemotion enforces promote-quick, demote-slow hysteresis", async () => {
    const contentHash = "hysteresis-hash";
    await withTransaction(tp.pool, (repos) => recordAccess(repos, contentHash, {}));
    await withTransaction(tp.pool, (repos) => promote(repos, contentHash));

    // Backdate last_accessed_at by directly recording an access far in the
    // past, mirroring the archived test's own approach.
    await tp.pool.query(
      `UPDATE placement SET last_accessed_at = now() - interval '10 minutes' WHERE content_hash = $1`,
      [contentHash],
    );
    const notYet = await withTransaction(tp.pool, (repos) =>
      evaluateDemotion(repos, contentHash, testConfig),
    );
    expect(notYet).toMatchObject({ demote: false, reason: "still-within-idle-threshold" });

    await tp.pool.query(
      `UPDATE placement SET last_accessed_at = now() - interval '25 minutes' WHERE content_hash = $1`,
      [contentHash],
    );
    const past = await withTransaction(tp.pool, (repos) =>
      evaluateDemotion(repos, contentHash, testConfig),
    );
    expect(past).toMatchObject({ demote: true, reason: "idle-past-threshold" });
  });

  // TC-8: capacity-aware LRU eviction, scoped to the pinned set only;
  // eviction unpins (survives as a cold fact) rather than deleting.
  it("evictLRUIfOverCapacity unpins only the LRU pinned entry over budget, leaving others untouched", async () => {
    const now = Date.now();
    await withTransaction(tp.pool, async (repos) => {
      await recordAccess(repos, "oldest-unpinned", { sizeBytes: 500, at: new Date(now - 100_000) });
      await recordAccess(repos, "pinned-old", { sizeBytes: 100, at: new Date(now - 60_000) });
      await recordAccess(repos, "pinned-mid", { sizeBytes: 100, at: new Date(now - 30_000) });
      await recordAccess(repos, "pinned-new", { sizeBytes: 100, at: new Date(now) });
      await promote(repos, "pinned-old");
      await promote(repos, "pinned-mid");
      await promote(repos, "pinned-new");
    });

    const evicted = await withTransaction(tp.pool, (repos) =>
      evictLRUIfOverCapacity(repos, testConfig),
    );
    expect(evicted).toEqual(["pinned-old"]);

    const afterFirstRun = await withTransaction(tp.pool, async (repos) => ({
      oldestUnpinned: await resolvePlacement(repos, "oldest-unpinned"),
      pinnedOld: await resolvePlacement(repos, "pinned-old"),
      pinnedMid: await resolvePlacement(repos, "pinned-mid"),
      pinnedNew: await resolvePlacement(repos, "pinned-new"),
    }));
    expect(afterFirstRun.oldestUnpinned.placement?.pinned).toBe(false); // never touched
    expect(afterFirstRun.pinnedOld.placement?.pinned).toBe(false); // evicted
    expect(afterFirstRun.pinnedOld.placement).toBeDefined(); // fact survives
    expect(afterFirstRun.pinnedMid.placement?.pinned).toBe(true);
    expect(afterFirstRun.pinnedNew.placement?.pinned).toBe(true);

    // Second run is a no-op - pinned total (200) is now within the 250 budget.
    const secondRun = await withTransaction(tp.pool, (repos) =>
      evictLRUIfOverCapacity(repos, testConfig),
    );
    expect(secondRun).toEqual([]);
  });

  // TC-9: recordAccess shares a transaction with an ordinary
  // executions/checkpoints write - the DEEP-consolidation property
  // (design.md D6), now exercised for placement.
  it("recordAccess commits atomically alongside an executions write, and rolls back together on failure", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await repos.client.query(`INSERT INTO executions (session_id, step) VALUES ('s', 'step')`);
      await recordAccess(repos, "composed-hash", {});
    });

    const committed = await withTransaction(tp.pool, (repos) =>
      resolvePlacement(repos, "composed-hash"),
    );
    expect(committed.found).toBe(true);
    const { rows: committedExecs } = await tp.pool.query(
      "SELECT 1 FROM executions WHERE session_id = 's'",
    );
    expect(committedExecs).toHaveLength(1);

    await expect(
      withTransaction(tp.pool, async (repos) => {
        await repos.client.query(`INSERT INTO executions (session_id, step) VALUES ('s2', 'step')`);
        await recordAccess(repos, "rolled-back-hash", {});
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const rolledBack = await withTransaction(tp.pool, (repos) =>
      resolvePlacement(repos, "rolled-back-hash"),
    );
    expect(rolledBack.found).toBe(false);
    const { rows: rolledBackExecs } = await tp.pool.query(
      "SELECT 1 FROM executions WHERE session_id = 's2'",
    );
    expect(rolledBackExecs).toHaveLength(0);
  });
});
