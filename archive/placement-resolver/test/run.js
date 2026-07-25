// placement-resolver test suite (task 1.10), run against a REAL Postgres.
//
// Run via `npm test` from this module's root - that wraps this file with
// ../scripts/with-postgres.sh, which starts a throwaway Postgres container
// on port 55544 (see src/db.js for the connection details it must match),
// waits for real readiness, applies schema.sql, runs this file, and tears
// the container down afterward. Running `node test/run.js` directly will
// NOT start Postgres for you - only `npm test` manages that lifecycle.
//
// Time is simulated via recordAccess's `at` parameter and a direct
// last_accessed_at setter, so the suite runs instantly without real waits
// while still exercising real windowed SQL against a real server.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makePool, resetSchema } from "../src/db.js";
import {
  resolvePlacement,
  recordAccess,
  evaluatePromotion,
  evaluateDemotion,
  promote,
  demote,
  evictLRUIfOverCapacity,
  isTrustEligibleForOptimization,
  TRUST_TIERS,
} from "../src/resolver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = makePool();

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   - ${name}`);
  } else {
    failed++;
    console.log(`  FAIL - ${name}${extra ? "  " + JSON.stringify(extra) : ""}`);
  }
}

const MIN = 60 * 1000;

// Test config: same shape as D4a defaults, chosen to make the hysteresis gap
// concrete. promotion window 7 min, demotion idle 20 min.
const CONFIG = {
  promotion: { frequencyThreshold: 3, frequencyWindowMs: 7 * MIN, rehydrationCostThresholdMs: 250 },
  demotion: { idleThresholdMs: 20 * MIN },
  capacity: { pinnedBudgetBytes: 250 },
  cost: {
    observedMinSamples: 5,
    classPriorsMs: { trivial: 10, cheap: 50, moderate: 300, expensive: 2000 },
  },
};

// Test-only helper to simulate a row having been last accessed in the past.
async function setLastAccessed(contentHash, msAgo) {
  await pool.query(
    `UPDATE placement.placement
     SET last_accessed_at = now() - ($2::double precision / 1000 * interval '1 second')
     WHERE content_hash = $1`,
    [contentHash, msAgo]
  );
}

async function loadSchema() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  await pool.query(sql);
}

// --------------------------------------------------------------------------

async function testTrustGate() {
  console.log("\n[trust gate] isTrustEligibleForOptimization");
  check("unverified is NOT eligible", isTrustEligibleForOptimization(TRUST_TIERS.UNVERIFIED) === false);
  check(
    "conformance-passed is NOT eligible",
    isTrustEligibleForOptimization(TRUST_TIERS.CONFORMANCE_PASSED) === false
  );
  check(
    "production-proven IS eligible",
    isTrustEligibleForOptimization(TRUST_TIERS.PRODUCTION_PROVEN) === true
  );
}

async function testResolveMiss() {
  console.log("\n[read path] resolvePlacement on a never-seen hash");
  await resetSchema(pool);
  let result;
  let threw = false;
  try {
    result = await resolvePlacement(pool, "hash-never-seen");
  } catch (e) {
    threw = true;
  }
  check("does not throw", threw === false);
  check("found === false", result && result.found === false, result);
  check("warm === false", result && result.warm === false, result);
  check("reason === no-placement", result && result.reason === "no-placement", result);
}

async function testPromotionInteractive() {
  console.log("\n[promotion] interactive + high declared cost + 3 accesses in window -> promote");
  await resetSchema(pool);
  const hash = "warm-interactive";
  // 3 accesses in a single caller-owned transaction (spike 1.2 pattern).
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < 3; i++) {
      await recordAccess(client, hash, {
        replicaId: "replica-A",
        sessionId: "sess-1",
        interactivity: "interactive",
        declaredCostClass: "expensive", // prior 2000ms > 250ms threshold
        sizeBytes: 100,
        config: CONFIG,
      });
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }

  const resolved = await resolvePlacement(pool, hash);
  check("resolves to a warm replica", resolved.found && resolved.warm && resolved.replicaId === "replica-A", resolved);
  check("access_count == 3", resolved.accessCount === 3, resolved);

  const decision = await evaluatePromotion(pool, hash, CONFIG);
  check("evaluatePromotion.promote === true", decision.promote === true, decision);
  check("reason === qualifies", decision.reason === "qualifies", decision);

  // Decision must NOT have mutated state (still unpinned before we act).
  const beforeAct = await resolvePlacement(pool, hash);
  check("evaluatePromotion did not mutate (still unpinned)", beforeAct.pinned === false, beforeAct);

  // Explicit action promotes.
  await promote(pool, hash);
  const afterAct = await resolvePlacement(pool, hash);
  check("promote() action pins it", afterAct.pinned === true, afterAct);
}

async function testPromotionBatchNever() {
  console.log("\n[promotion] batch binding never auto-promotes regardless of frequency");
  await resetSchema(pool);
  const hash = "batch-hot";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < 6; i++) {
      // twice the frequency threshold
      await recordAccess(client, hash, {
        replicaId: "replica-B",
        interactivity: "batch",
        declaredCostClass: "expensive",
        sizeBytes: 100,
        config: CONFIG,
      });
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }

  const decision = await evaluatePromotion(pool, hash, CONFIG);
  check("evaluatePromotion.promote === false for batch", decision.promote === false, decision);
  check("reason === not-interactive", decision.reason === "not-interactive", decision);
  check("frequency actually exceeded threshold", decision.detail.windowedAccessCount >= 3, decision.detail);
}

async function testHysteresis() {
  console.log("\n[hysteresis] idle past promotion window but below demotion threshold -> NOT demoted");
  await resetSchema(pool);
  const hash = "pinned-idle";
  await recordAccess(pool, hash, {
    replicaId: "replica-C",
    interactivity: "interactive",
    declaredCostClass: "expensive",
    sizeBytes: 100,
    config: CONFIG,
  });
  await promote(pool, hash);

  // Idle 10 min: > promotion window (7 min) but < demotion threshold (20 min).
  await setLastAccessed(hash, 10 * MIN);
  const d1 = await evaluateDemotion(pool, hash, CONFIG);
  check("10-min idle is past 7-min promotion window", 10 * MIN > CONFIG.promotion.frequencyWindowMs);
  check("10-min idle is below 20-min demotion threshold", 10 * MIN < CONFIG.demotion.idleThresholdMs);
  check("NOT demoted in the hysteresis gap", d1.demote === false, d1);
  check("reason === still-within-idle-threshold", d1.reason === "still-within-idle-threshold", d1);

  // Idle 25 min: now past the demotion threshold.
  await setLastAccessed(hash, 25 * MIN);
  const d2 = await evaluateDemotion(pool, hash, CONFIG);
  check("demoted once past 20-min demotion threshold", d2.demote === true, d2);

  // Still not mutated by the decision function.
  const before = await resolvePlacement(pool, hash);
  check("evaluateDemotion did not mutate (still pinned)", before.pinned === true, before);
  await demote(pool, hash);
  const after = await resolvePlacement(pool, hash);
  check("demote() action unpins it", after.pinned === false, after);
}

async function testCapacityEviction() {
  console.log("\n[capacity] LRU eviction among PINNED set only, budget=250 bytes");
  await resetSchema(pool);

  // Three pinned (100 each = 300 > 250 budget) + one unpinned (100).
  const seed = async (hash, sizeBytes, idleMs, pinned) => {
    await recordAccess(pool, hash, {
      replicaId: "r",
      interactivity: "interactive",
      declaredCostClass: "expensive",
      sizeBytes,
      config: CONFIG,
    });
    if (pinned) await promote(pool, hash);
    await setLastAccessed(hash, idleMs);
  };

  await seed("pin-old", 100, 50 * MIN, true); // LRU pinned
  await seed("pin-mid", 100, 40 * MIN, true);
  await seed("pin-new", 100, 10 * MIN, true); // MRU pinned
  await seed("unpinned-oldest", 100, 60 * MIN, false); // oldest overall, but unpinned

  const evicted = await evictLRUIfOverCapacity(pool, CONFIG);
  check("evicted exactly the one LRU pinned entry", evicted.length === 1 && evicted[0] === "pin-old", evicted);

  const oldR = await resolvePlacement(pool, "pin-old");
  const midR = await resolvePlacement(pool, "pin-mid");
  const newR = await resolvePlacement(pool, "pin-new");
  const unR = await resolvePlacement(pool, "unpinned-oldest");

  check("LRU pinned (pin-old) is now unpinned", oldR.pinned === false, oldR);
  check("pin-old fact survives eviction (still resolvable)", oldR.found === true, oldR);
  check("more-recent pinned (pin-mid) untouched", midR.pinned === true, midR);
  check("MRU pinned (pin-new) untouched", newR.pinned === true, newR);
  check("older UNPINNED entry untouched (never was pinned)", unR.pinned === false && unR.found === true, unR);

  // Under budget now -> no-op on a second run.
  const evicted2 = await evictLRUIfOverCapacity(pool, CONFIG);
  check("second eviction run is a no-op (within budget)", evicted2.length === 0, evicted2);
}

async function main() {
  await loadSchema();
  await testTrustGate();
  await testResolveMiss();
  await testPromotionInteractive();
  await testPromotionBatchNever();
  await testHysteresis();
  await testCapacityEviction();

  console.log(`\n----------------------------------------`);
  console.log(`passed: ${passed}, failed: ${failed}`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
