import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makePool, resetSchema } from "./db.js";
import { submitRun, workerLoop, getRun } from "./interpreter.js";

// Spike 1.5 test: proves the GENERIC interpreter correctly executes the
// example IR document (ir/example-workflow.json) against the Postgres-
// native engine, for BOTH branch cases, exercising:
//   1. Dependency ordering    - the final step ("combineTotal") must not be
//      claimable until BOTH its dependencies (the branch and the map) have
//      completed, purely from analyzing bindings in the IR - no hardcoded
//      "run these three, then that one" sequencing anywhere in the code.
//   2. Branch case exclusivity - only the SELECTED case's step is ever
//      created/executed; the other case's step must never exist as an
//      execution row for that run (not just "didn't run" - never even
//      scheduled).
//   3. Map correctness        - the map's per-item step runs once per
//      source-array element and joins into a correctly-ordered array.
//   4. Correct final output   - the value produced by chaining branch +
//      map results through one more step matches hand-computed expected
//      values for both branch cases.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowSpec = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "ir", "example-workflow.json"), "utf8")
);

const results = { pass: [], fail: [] };
function check(label, cond, detail = "") {
  (cond ? results.pass : results.fail).push(label);
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${detail ? ` - ${detail}` : ""}`);
  return cond;
}

async function runScenario(pool, { amount, items, expectedCase, otherCaseStepId, expectedGrandTotal }) {
  const runId = await submitRun(pool, workflowSpec, { amount, items });

  // Immediately after submission, before any worker runs: the dependency-
  // ordering claim should already be visible in the DB state, not just in
  // the eventual outcome.
  const { rows: initial } = await pool.query(
    `SELECT node_id, status FROM ir.executions WHERE run_id = $1 ORDER BY node_id`,
    [runId]
  );
  const combineRow = initial.find((r) => r.node_id === "combineTotal");
  check(
    `[amount=${amount}] combineTotal starts 'blocked' (declares 2 external deps, satisfied by nothing yet)`,
    combineRow?.status === "blocked",
    `status=${combineRow?.status}`
  );
  const branchRow = initial.find((r) => r.node_id === "discountBranch");
  const mapRow = initial.find((r) => r.node_id === "lineItems");
  check(
    `[amount=${amount}] discountBranch and lineItems start 'queued' (no external deps)`,
    branchRow?.status === "queued" && mapRow?.status === "queued"
  );

  // Drive the run to completion with a small worker pool - the SAME kind of
  // pool/claim loop as spikes 1.2/1.8, nothing bespoke to this workflow.
  await Promise.all(
    Array.from({ length: 4 }, (_, i) => workerLoop(pool, `ir-worker-${i}`, workflowSpec, { maxIdlePolls: 8 }))
  );

  const run = await getRun(pool, runId);
  check(`[amount=${amount}] run reached status 'done'`, run.status === "done", `status=${run.status}`);
  check(
    `[amount=${amount}] grandTotal == ${expectedGrandTotal}`,
    run.outputs?.grandTotal === expectedGrandTotal,
    `got=${run.outputs?.grandTotal}`
  );

  // Branch-case exclusivity: the OTHER case's step must never have been
  // created as an execution row for this run at all.
  const { rows: otherCaseRows } = await pool.query(
    `SELECT 1 FROM ir.executions WHERE run_id = $1 AND node_id = $2`,
    [runId, otherCaseStepId]
  );
  check(
    `[amount=${amount}] the UNSELECTED case's step ('${otherCaseStepId}') was never created`,
    otherCaseRows.length === 0
  );

  const { rows: branchNodeRows } = await pool.query(`SELECT selected_case FROM ir.branch_nodes bn JOIN ir.executions e ON e.id = bn.execution_id WHERE e.run_id = $1`, [runId]);
  check(
    `[amount=${amount}] branch selected case '${expectedCase}'`,
    branchNodeRows[0]?.selected_case === expectedCase,
    `got=${branchNodeRows[0]?.selected_case}`
  );

  return run;
}

async function main() {
  const pool = makePool();
  await resetSchema(pool);

  console.log("=== SCENARIO 1: amount=150 (> 100) -> 'true' case, discount applied ===");
  await runScenario(pool, {
    amount: 150,
    items: [
      { price: 10, qty: 2 }, // 20
      { price: 5, qty: 3 }, // 15
    ],
    expectedCase: "true",
    otherCaseStepId: "noDiscount",
    // discountedAmount = 150*0.9 = 135; lineTotals sum = 35; grandTotal = 170
    expectedGrandTotal: 170,
  });

  console.log("\n=== SCENARIO 2: amount=50 (<= 100) -> 'default' case, no discount ===");
  await runScenario(pool, {
    amount: 50,
    items: [{ price: 2, qty: 5 }], // 10
    expectedCase: "default",
    otherCaseStepId: "applyDiscount",
    // discountedAmount = 50 (identity); lineTotals sum = 10; grandTotal = 60
    expectedGrandTotal: 60,
  });

  console.log("\n=== SCENARIO 3: map join preserves original source order under concurrency ===");
  {
    const items = Array.from({ length: 12 }, (_, i) => ({ price: i + 1, qty: 2 }));
    const runId = await submitRun(pool, workflowSpec, { amount: 10, items });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => workerLoop(pool, `ir-worker-order-${i}`, workflowSpec, { maxIdlePolls: 8 }))
    );
    const run = await getRun(pool, runId);
    const { rows: mapOutRows } = await pool.query(
      `SELECT output FROM ir.run_node_outputs WHERE run_id = $1 AND node_id = 'lineItems'`,
      [runId]
    );
    const expected = items.map((it) => it.price * it.qty);
    check(
      `map yields lineTotal array in original source order`,
      JSON.stringify(mapOutRows[0]?.output?.lineTotal) === JSON.stringify(expected),
      `got=${JSON.stringify(mapOutRows[0]?.output?.lineTotal)} expected=${JSON.stringify(expected)}`
    );
    check(`run 3 also reached 'done'`, run.status === "done");
  }

  console.log(`\n================ SUMMARY ================`);
  console.log(`PASS: ${results.pass.length}   FAIL: ${results.fail.length}`);
  const ok = results.fail.length === 0;
  console.log(
    `\nGeneric IR interpreter on the Postgres-native pattern (dependency ordering, branch exclusivity, map join, cross-node binding resolution): ${ok ? "HOLDS" : "FAILED"}`
  );

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
