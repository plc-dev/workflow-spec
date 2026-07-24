import { makePool, resetSpikeSchema } from "./db.js";
import { processOneExecution } from "./worker.js";

// Crash test: a worker claims an execution, writes the checkpoint +
// session_log + placement rows (still inside the transaction), then the
// connection is forcibly terminated BEFORE COMMIT - simulating a hard
// worker crash mid-transaction (design.md D6's "mid-transaction kills").
//
// Two DISTINCT things must hold for the DEEP-consolidation claim to survive
// crashes, tested as two separate scenarios because they exercise different
// recovery mechanisms:
//
//   1. ATOMICITY + no-lease-wait-needed recovery: since `claim_execution()`
//      runs INSIDE the same transaction as the rest of the step, killing the
//      connection before COMMIT rolls back the claim itself along with
//      everything else - the execution reverts all the way to `queued`, not
//      merely to a `running` state waiting on a lease. This means recovery
//      from a mid-transaction crash is IMMEDIATE (next claimant picks it up
//      right away), which is a stronger property than lease-expiry, tested
//      explicitly below rather than assumed.
//
//   2. RESUMABILITY VIA LEASE-EXPIRY SWEEP: a genuinely different failure
//      shape - a worker whose CLAIM commits (e.g. a heartbeat/lease-renewal
//      pattern, or simply a worker that dies after claiming but validates
//      the row is `running`) and then the worker itself dies without ever
//      reaching its own COMMIT of the step's work. This is simulated here by
//      committing a claim on its own, then letting its short lease expire,
//      and confirming a second worker can pick it up with no duplicate
//      session_log/checkpoint rows.
//
// The two scenarios are kept separate and reported separately below so the
// numbers in each aren't misattributed to the other's recovery mechanism.

const SESSION_ID = "session-crash";

async function main() {
  const pool = makePool();
  await resetSpikeSchema(pool);

  // --- Scenario 1: mid-transaction crash -----------------------------------

  await pool.query(
    `INSERT INTO spike.executions (session_id, step, input) VALUES ($1, 'sql_mutate', $2)`,
    [SESSION_ID, JSON.stringify({ mutationIndex: 0 })]
  );
  await pool.query(
    `INSERT INTO spike.session_pointer (session_id, head_seq, head_hash) VALUES ($1, 0, 'root')`,
    [SESSION_ID]
  );

  let crashedExecutionId = null;
  let crashed = false;

  try {
    await processOneExecution(pool, "worker-doomed", {
      hook: async ({ client, execRow }) => {
        crashedExecutionId = execRow.id;
        const {
          rows: [{ pid }],
        } = await client.query("SELECT pg_backend_pid() AS pid");
        crashed = true;
        // Kill our OWN backend from a second connection - simulates the
        // process dying mid-transaction, before COMMIT is ever sent.
        const killer = await pool.connect();
        await killer.query("SELECT pg_terminate_backend($1)", [pid]);
        killer.release();
        // Give Postgres a moment to actually tear down the backend.
        await new Promise((r) => setTimeout(r, 200));
      },
    });
  } catch (err) {
    // Expected: the terminated connection surfaces as a connection error.
    console.log(`worker-doomed crashed mid-transaction as expected (${err.code || err.message})`);
  }

  if (!crashed) {
    console.error("test setup failed: crash hook never ran");
    process.exit(1);
  }

  // 1a. ATOMICITY CHECK: after the crash, none of the partial writes exist.
  const { rows: ckRows } = await pool.query(`SELECT count(*)::int AS n FROM spike.checkpoints`);
  const { rows: logRows } = await pool.query(`SELECT count(*)::int AS n FROM spike.session_log`);
  const { rows: plRows } = await pool.query(`SELECT count(*)::int AS n FROM spike.placement`);
  const { rows: execAfterCrash } = await pool.query(
    `SELECT status, attempts FROM spike.executions WHERE id = $1`,
    [crashedExecutionId]
  );

  const noPartialWrites = ckRows[0].n === 0 && logRows[0].n === 0 && plRows[0].n === 0;
  console.log(`checkpoints after crash: ${ckRows[0].n} (expected 0)`);
  console.log(`session_log rows after crash: ${logRows[0].n} (expected 0)`);
  console.log(`placement rows after crash: ${plRows[0].n} (expected 0)`);
  console.log(`ATOMICITY (no partial writes survived the crash): ${noPartialWrites ? "HOLDS" : "VIOLATED"}`);

  // 1b. IMMEDIATE RECOVERY CHECK: the crashed claim itself rolled back too,
  // so the execution should already be back to `queued`/`attempts=0` - no
  // lease wait required - and a very next claimant should be able to finish
  // it cleanly, with exactly one session_log row and one checkpoint (not
  // double-applied by the crashed attempt, since the crashed attempt never
  // committed anything).
  const rolledBackToQueued =
    execAfterCrash[0]?.status === "queued" && Number(execAfterCrash[0]?.attempts) === 0;
  console.log(
    `execution reverted to: status=${execAfterCrash[0]?.status}, attempts=${execAfterCrash[0]?.attempts} (expected status=queued, attempts=0 - the crashed claim itself was rolled back, not just the step's writes)`
  );

  const immediateRetry = await processOneExecution(pool, "worker-rescuer-immediate");
  const { rows: postRetryLog } = await pool.query(`SELECT count(*)::int AS n FROM spike.session_log`);
  const { rows: postRetryCk } = await pool.query(`SELECT count(*)::int AS n FROM spike.checkpoints`);

  const immediateRecovery =
    rolledBackToQueued &&
    immediateRetry?.execRow.id === crashedExecutionId &&
    postRetryLog[0].n === 1 &&
    postRetryCk[0].n === 1;
  console.log(
    `re-claimed immediately (no lease wait) by worker-rescuer-immediate: ${immediateRetry ? "YES" : "NO"}, resulting session_log rows: ${postRetryLog[0].n} (expect 1), checkpoints: ${postRetryCk[0].n} (expect 1)`
  );
  console.log(
    `\nSCENARIO 1 - mid-transaction crash: atomicity + immediate no-lease-wait recovery: ${
      noPartialWrites && immediateRecovery ? "HOLDS" : "VIOLATED"
    }`
  );

  // --- Scenario 2: a committed claim whose owning worker then goes dark ---
  // (distinct failure shape: the CLAIM itself is durable/committed; only the
  // work after it is lost - recovery here genuinely depends on lease expiry)

  await pool.query(
    `INSERT INTO spike.executions (session_id, step, input) VALUES ($1, 'sql_mutate', $2)`,
    [SESSION_ID, JSON.stringify({ mutationIndex: 1 })]
  );

  const leaseClient = await pool.connect();
  await leaseClient.query("BEGIN");
  const claim = await leaseClient.query(`SELECT * FROM spike.claim_execution($1, 1)`, ["worker-abandons"]);
  await leaseClient.query("COMMIT"); // commits the CLAIM itself (status='running', 1s lease); worker then vanishes
  leaseClient.release();
  const abandonedId = claim.rows[0]?.id;

  console.log(`\nwaiting for the abandoned claim's 1s lease to expire...`);
  await new Promise((r) => setTimeout(r, 1500));

  const rescueResult = await processOneExecution(pool, "worker-rescuer-lease");
  const resumedAbandoned = rescueResult && rescueResult.execRow.id === abandonedId;

  const { rows: finalExec } = await pool.query(`SELECT status, attempts FROM spike.executions WHERE id = $1`, [
    abandonedId,
  ]);
  const { rows: finalLog } = await pool.query(
    `SELECT count(*)::int AS n FROM spike.session_log WHERE mutation->>'mutationIndex' = '1'`
  );
  const { rows: finalCk } = await pool.query(`SELECT count(*)::int AS n FROM spike.checkpoints WHERE execution_id = $1`, [
    abandonedId,
  ]);

  console.log(`re-claimed by worker-rescuer-lease after lease expiry: ${resumedAbandoned ? "YES" : "NO"}`);
  console.log(
    `final execution status: ${finalExec[0].status}, attempts: ${finalExec[0].attempts} (expect 2: the abandoned claim + the lease-sweep re-claim)`
  );
  console.log(`session_log rows for this execution's mutation: ${finalLog[0].n} (expect exactly 1 - not double-applied)`);
  console.log(`checkpoints for this execution: ${finalCk[0].n} (expect exactly 1 - not double-applied)`);

  const leaseRecovery =
    resumedAbandoned &&
    finalExec[0].status === "done" &&
    Number(finalExec[0].attempts) === 2 &&
    finalLog[0].n === 1 &&
    finalCk[0].n === 1;
  console.log(
    `\nSCENARIO 2 - committed claim + dead worker: lease-expiry sweep -> clean single re-completion: ${leaseRecovery ? "HOLDS" : "VIOLATED"}`
  );

  const ok = noPartialWrites && immediateRecovery && leaseRecovery;
  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
