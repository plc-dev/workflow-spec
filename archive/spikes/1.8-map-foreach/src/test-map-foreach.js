import { makePool, resetSpikeSchema } from "./db.js";
import { processOne, workerLoop } from "./worker.js";

// Spike 1.8 test: demonstrates, against a REAL Postgres instance, that D8's
// dynamic map/forEach construct is expressible on the D6/1.4 Postgres-native
// durable-execution pattern. Four properties, each logged and asserted; exit
// code 0 only if ALL hold. Style/rigor mirrors spike 1.2's test-*.js.
//
//   1. FAN-OUT           - a map over N>=10 items creates exactly N child
//                          execution rows, each independently claimable.
//   2. INDEPENDENT RETRY - exactly one child forced to fail once then succeed,
//                          with NO other child blocked/duplicated/affected.
//   3. PARENT NON-BLOCK  - map children share one worker pool with unrelated
//                          standalone executions, interleaved; the parent map
//                          node never holds a worker across its children.
//   4. ORDERED JOIN      - once all N children finish (in genuinely OUT-OF-
//                          ORDER completion under concurrency), the joined
//                          result is a parallel array of length N in ORIGINAL
//                          source order.

const results = { pass: [], fail: [] };
function check(label, cond, detail = "") {
  (cond ? results.pass : results.fail).push(label);
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${detail ? ` - ${detail}` : ""}`);
  return cond;
}

async function seedMap(pool, source, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO spike.executions (kind, step, input)
     VALUES ('map', 'enrichEach', $1) RETURNING id`,
    [JSON.stringify({ source, ...extra })]
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// SCENARIO 1: Fan-out
// ---------------------------------------------------------------------------
async function scenarioFanout(pool) {
  console.log("\n=== SCENARIO 1: fan-out (map over N items -> N claimable children) ===");
  await resetSpikeSchema(pool);
  const N = 12;
  const source = Array.from({ length: N }, (_, i) => (i + 1) * 10);
  const mapId = await seedMap(pool, source);

  // Exactly ONE claim triggers the fan-out; the parent then parks itself.
  const fanResult = await processOne(pool, "worker-fanout");

  const { rows: childRows } = await pool.query(
    `SELECT count(*)::int AS n FROM spike.executions
      WHERE parent_execution_id = $1 AND kind = 'step'`,
    [mapId]
  );
  const { rows: claimable } = await pool.query(
    `SELECT count(*)::int AS n FROM spike.executions
      WHERE parent_execution_id = $1 AND status = 'queued'`,
    [mapId]
  );
  const { rows: parentRows } = await pool.query(
    `SELECT status, worker_id, lease_until FROM spike.executions WHERE id = $1`,
    [mapId]
  );
  const { rows: mnRows } = await pool.query(
    `SELECT total_children FROM spike.map_nodes WHERE execution_id = $1`,
    [mapId]
  );

  check("fan-out produced a 'fanout' result", fanResult?.kind === "fanout", `got ${fanResult?.kind}`);
  check(`exactly N=${N} child execution rows created`, childRows[0].n === N, `got ${childRows[0].n}`);
  check(`all ${N} children independently claimable (status='queued')`, claimable[0].n === N, `got ${claimable[0].n}`);
  check(
    "parent parked in 'awaiting_children', holding NO worker/lease",
    parentRows[0].status === "awaiting_children" &&
      parentRows[0].worker_id === null &&
      parentRows[0].lease_until === null,
    `status=${parentRows[0].status}, worker=${parentRows[0].worker_id}, lease=${parentRows[0].lease_until}`
  );
  check(`map_nodes.total_children froze runtime cardinality N=${N}`, mnRows[0]?.total_children === N, `got ${mnRows[0]?.total_children}`);
}

// ---------------------------------------------------------------------------
// SCENARIO 2: Independent per-child retry
// ---------------------------------------------------------------------------
async function scenarioIndependentRetry(pool) {
  console.log("\n=== SCENARIO 2: independent per-child retry (one child fails once) ===");
  await resetSpikeSchema(pool);
  const N = 12;
  const source = Array.from({ length: N }, (_, i) => i + 1);
  const FAIL_INDEX = 5; // this ONE child fails on its first attempt, then succeeds
  const mapId = await seedMap(pool, source, { failIndices: { [FAIL_INDEX]: 1 } });

  // 4 workers drain everything (fan-out, all children incl. the retry, join).
  const perWorker = await Promise.all(
    [0, 1, 2, 3].map((i) => workerLoop(pool, `worker-${i}`, { jitterMs: 5 }))
  );
  const flat = perWorker.flat();

  const injectedFailures = flat.filter((r) => r.kind === "retry");
  const { rows: doneChildren } = await pool.query(
    `SELECT count(*)::int AS n FROM spike.executions
      WHERE parent_execution_id = $1 AND status = 'done'`,
    [mapId]
  );
  // Each child must have EXACTLY ONE checkpoint (no duplicate side effect from
  // the failed+retried attempt of the one failing child).
  const { rows: dupCheck } = await pool.query(
    `SELECT c.map_index, count(cp.*)::int AS cps
       FROM spike.executions c
       JOIN spike.checkpoints cp ON cp.execution_id = c.id
      WHERE c.parent_execution_id = $1
      GROUP BY c.map_index ORDER BY c.map_index`,
    [mapId]
  );
  const anyDup = dupCheck.some((r) => r.cps !== 1);
  const allCheckpointed = dupCheck.length === N;

  // The failing child's attempts should be exactly 2 (fail + success); every
  // OTHER child should be exactly 1 (untouched by that failure).
  const { rows: attemptRows } = await pool.query(
    `SELECT map_index, attempts FROM spike.executions
      WHERE parent_execution_id = $1 ORDER BY map_index`,
    [mapId]
  );
  const failChild = attemptRows.find((r) => r.map_index === FAIL_INDEX);
  const othersUntouched = attemptRows
    .filter((r) => r.map_index !== FAIL_INDEX)
    .every((r) => r.attempts === 1);

  // The joined result must still be complete and correct.
  const { rows: jr } = await pool.query(`SELECT yields FROM spike.map_results WHERE execution_id = $1`, [mapId]);
  const enriched = jr[0]?.yields?.enriched;
  const expected = source.map((x) => x * 2);
  const joinCorrect = JSON.stringify(enriched) === JSON.stringify(expected);

  check(
    "exactly ONE injected transient failure occurred (on the seeded child)",
    injectedFailures.length === 1 && injectedFailures[0].mapIndex === FAIL_INDEX,
    `count=${injectedFailures.length}, at index=${injectedFailures[0]?.mapIndex}`
  );
  check(`all N=${N} children eventually done`, doneChildren[0].n === N, `got ${doneChildren[0].n}`);
  check("no child has a duplicate checkpoint (no double side-effect)", allCheckpointed && !anyDup, `checkpointed=${dupCheck.length}, anyDup=${anyDup}`);
  check(`failing child (index ${FAIL_INDEX}) took 2 attempts`, Number(failChild?.attempts) === 2, `attempts=${failChild?.attempts}`);
  check("every OTHER child took exactly 1 attempt (unaffected)", othersUntouched);
  check("join is complete and correct despite the retry", joinCorrect, `enriched=${JSON.stringify(enriched)}`);
}

// ---------------------------------------------------------------------------
// SCENARIO 3: Parent non-blocking (shared pool, interleaved with other work)
// ---------------------------------------------------------------------------
async function scenarioNonBlocking(pool) {
  console.log("\n=== SCENARIO 3: parent non-blocking (children share the pool with standalone work) ===");
  await resetSpikeSchema(pool);
  const N = 12;
  const source = Array.from({ length: N }, (_, i) => i + 1);
  const mapId = await seedMap(pool, source);

  // Interleave 10 UNRELATED standalone step executions into the same queue.
  const M = 10;
  for (let i = 0; i < M; i++) {
    await pool.query(
      `INSERT INTO spike.executions (kind, step, input) VALUES ('step', 'enrichOne', $1)`,
      [JSON.stringify({ item: 1000 + i })]
    );
  }

  // A shared pool of workers drains EVERYTHING with no worker pinned to the map.
  const perWorker = await Promise.all(
    [0, 1, 2, 3].map((i) => workerLoop(pool, `worker-${i}`, { jitterMs: 8 }))
  );

  const { rows: standaloneDone } = await pool.query(
    `SELECT count(*)::int AS n FROM spike.executions
      WHERE kind = 'step' AND parent_execution_id IS NULL AND status = 'done'`
  );
  const { rows: mapDone } = await pool.query(`SELECT status FROM spike.executions WHERE id = $1`, [mapId]);
  const { rows: childrenDone } = await pool.query(
    `SELECT count(*)::int AS n FROM spike.executions WHERE parent_execution_id = $1 AND status = 'done'`,
    [mapId]
  );
  const { rows: jr } = await pool.query(`SELECT yields FROM spike.map_results WHERE execution_id = $1`, [mapId]);

  // Interleaving evidence: did at least one worker process BOTH a map child
  // AND a standalone step? If so, no worker sat blocked babysitting the map.
  let interleavedWorker = false;
  for (const w of perWorker) {
    const sawChild = w.some((r) => r.kind === "step" && r.parentId !== null);
    const sawStandalone = w.some((r) => r.kind === "step" && r.parentId === null);
    if (sawChild && sawStandalone) interleavedWorker = true;
  }

  check(`all ${M} unrelated standalone executions completed`, standaloneDone[0].n === M, `got ${standaloneDone[0].n}`);
  check(`all ${N} map children completed`, childrenDone[0].n === N, `got ${childrenDone[0].n}`);
  check("map node reached 'done' via a separate join claim", mapDone[0].status === "done", `status=${mapDone[0].status}`);
  check("map join produced a result", Array.isArray(jr[0]?.yields?.enriched), `yields=${JSON.stringify(jr[0]?.yields)}`);
  check(
    "at least one worker interleaved a map child with standalone work (parent not babysat)",
    interleavedWorker
  );
}

// ---------------------------------------------------------------------------
// SCENARIO 4: Ordered join under genuinely out-of-order completion
// ---------------------------------------------------------------------------
async function scenarioOrderedJoin(pool) {
  console.log("\n=== SCENARIO 4: ordered join under out-of-order concurrent completion ===");
  await resetSpikeSchema(pool);
  const N = 15;
  // Non-trivial, non-monotonic source values so a correct join can't be faked
  // by coincidence of value == index.
  const source = Array.from({ length: N }, (_, i) => (i * 7 + 3) % 50);
  const mapId = await seedMap(pool, source);

  // 6 workers + real jitter => children commit out of source order. The worker
  // records the TRUE wall-clock commit order into this shared array (a SQL
  // ORDER BY committed_at would be contaminated by same-millisecond ties).
  const completionLog = [];
  await Promise.all(
    [0, 1, 2, 3, 4, 5].map((i) => workerLoop(pool, `worker-${i}`, { jitterMs: 40, completionLog }))
  );

  const completionOrder = completionLog;
  const sortedOrder = Array.from({ length: N }, (_, i) => i);
  const outOfOrder = JSON.stringify(completionOrder) !== JSON.stringify(sortedOrder);

  const { rows: jr } = await pool.query(`SELECT yields FROM spike.map_results WHERE execution_id = $1`, [mapId]);
  const enriched = jr[0]?.yields?.enriched;
  const expected = source.map((x) => x * 2);
  const lengthOk = Array.isArray(enriched) && enriched.length === N;
  const orderOk = JSON.stringify(enriched) === JSON.stringify(expected);

  console.log(`  source          : [${source.join(", ")}]`);
  console.log(`  completion order: [${completionOrder.join(", ")}] (by checkpoint commit time)`);
  console.log(`  joined 'enriched': [${(enriched ?? []).join(", ")}]`);
  console.log(`  expected         : [${expected.join(", ")}]`);

  check("children genuinely completed OUT OF source order (real test)", outOfOrder);
  check(`joined array has length N=${N}`, lengthOk, `len=${enriched?.length}`);
  check("joined array is in ORIGINAL source order (not completion order)", orderOk);
}

async function main() {
  const pool = makePool();
  await scenarioFanout(pool);
  await scenarioIndependentRetry(pool);
  await scenarioNonBlocking(pool);
  await scenarioOrderedJoin(pool);
  await pool.end();

  console.log(`\n================ SUMMARY ================`);
  console.log(`PASS: ${results.pass.length}   FAIL: ${results.fail.length}`);
  if (results.fail.length) {
    console.log(`FAILED CHECKS:\n  - ${results.fail.join("\n  - ")}`);
  }
  const ok = results.fail.length === 0;
  console.log(
    `\nD8 map/forEach on the Postgres-native pattern (fan-out, independent retry, parent-non-blocking, ordered join): ${ok ? "HOLDS" : "VIOLATED"}`
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
