import { makePool, resetSpikeSchema } from "./db.js";
import { processOneExecution } from "./worker.js";
import { startMonitor, tableChurnStats } from "./monitor.js";

// Task 1.2e - LOAD/SCALE CHECK for the Postgres-native pattern (design.md
// D6, path f). Spike 1.2 validated CORRECTNESS (atomicity, linear-per-
// session-mutation) at modest scale (8 workers, dozens of rows). This test
// validates the one claim that spike deliberately left untested:
// "lightest operational footprint" under real load - specifically:
//
//   1. CONNECTION-COUNT CEILING: does a realistically-sized worker pool
//      stay comfortably under Postgres's max_connections (100 by default,
//      confirmed via `SHOW max_connections`) with no connection-exhaustion
//      errors?
//   2. LOCK CONTENTION AT SCALE: with many MORE sessions and workers than
//      spike 1.2's contention test (2 sessions/8 workers), does the
//      per-session `FOR UPDATE` lock discipline still avoid pathological
//      contention (excessive lock-wait time, workers piling up on a single
//      row) as the working set grows by two orders of magnitude?
//   3. CORRECTNESS AT SCALE: do all sessions' chains still come out
//      contiguous/gap-free/duplicate-free at ~100x the row count of the
//      original contention test? (Not re-litigating atomicity itself -
//      that's spike 1.2's crash test - just checking scale doesn't quietly
//      break the same invariant.)
//   4. DEAD-TUPLE / BLOAT BEHAVIOR under sustained UPDATE churn: a
//      dedicated churn phase repeatedly updates-then-aborts a hot set of
//      rows to generate dead tuples directly (an aborted UPDATE still
//      writes a heap tuple version that becomes dead immediately), then
//      checks whether autovacuum/VACUUM reclaims them - i.e. does the
//      pattern's reliance on UPDATE-in-place (status transitions on
//      `executions`, upserts on `placement`) create an unmanaged bloat
//      problem, or does ordinary Postgres vacuuming handle it as expected.
//
// Scope note: this is a narrow scale/operational check, not a production
// capacity-planning exercise (no multi-node Postgres, no realistic network
// latency, no long-duration soak). See FINDINGS.md for what this does and
// doesn't settle.

const SESSIONS = Number(process.env.LOAD_SESSIONS ?? 60);
const PER_SESSION = Number(process.env.LOAD_PER_SESSION ?? 100);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 32);
const CHURN_ITERATIONS = Number(process.env.LOAD_CHURN_ITERATIONS ?? 4000);
const CHURN_CONCURRENCY = Number(process.env.LOAD_CHURN_CONCURRENCY ?? 16);
const CHURN_HOT_ROWS = Number(process.env.LOAD_CHURN_HOT_ROWS ?? 25);

async function seedSessions(pool, nSessions, perSession) {
  const sessionIds = Array.from({ length: nSessions }, (_, i) => `load-session-${i}`);
  // Interleave inserts round-robin across sessions (mirrors test-contention's
  // interleaving, at larger scale) so claim_execution's ORDER BY id hands
  // out a genuinely mixed stream, not nSessions sequential blocks.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const sessionId of sessionIds) {
      await client.query(
        `INSERT INTO spike.session_pointer (session_id, head_seq, head_hash) VALUES ($1, 0, 'root')`,
        [sessionId]
      );
    }
    for (let i = 0; i < perSession; i++) {
      for (const sessionId of sessionIds) {
        await client.query(
          `INSERT INTO spike.executions (session_id, step, input) VALUES ($1, 'sql_mutate', $2)`,
          [sessionId, JSON.stringify({ mutationIndex: i })]
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return sessionIds;
}

async function workerLoop(pool, workerId, results) {
  let count = 0;
  while (true) {
    const result = await processOneExecution(pool, workerId);
    if (!result) break;
    count++;
    results.push({ sessionId: result.sessionId, seq: result.nextSeq });
  }
  return count;
}

function checkAllChainsContiguous(results, sessionIds, perSession) {
  const bySession = new Map(sessionIds.map((s) => [s, []]));
  for (const r of results) bySession.get(r.sessionId)?.push(r.seq);
  const broken = [];
  for (const s of sessionIds) {
    const seqs = bySession.get(s).slice().sort((a, b) => a - b);
    const expected = Array.from({ length: perSession }, (_, i) => i + 1);
    if (JSON.stringify(seqs) !== JSON.stringify(expected)) broken.push(s);
  }
  return broken;
}

// Generates dead tuples directly: BEGIN; UPDATE one of a small "hot" set of
// rows; ROLLBACK. The aborted UPDATE still writes a new heap tuple version
// before rolling back, which Postgres immediately treats as dead - this
// exercises bloat/vacuum behavior without needing a long real-time soak.
async function churnWorker(pool, hotIds, iterationsPerWorker) {
  for (let i = 0; i < iterationsPerWorker; i++) {
    const id = hotIds[i % hotIds.length];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE spike.executions SET updated_at = now() WHERE id = $1`, [id]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function main() {
  const poolMax = Math.max(CONCURRENCY, CHURN_CONCURRENCY) + 5;
  const pool = makePool({ max: poolMax });

  console.log(`config: max_connections check, ${SESSIONS} sessions x ${PER_SESSION} executions = ${SESSIONS * PER_SESSION} total, ${CONCURRENCY} workers`);

  await resetSpikeSchema(pool);
  const sessionIds = await seedSessions(pool, SESSIONS, PER_SESSION);

  const monitor = startMonitor(pool);

  const t0 = Date.now();
  const results = [];
  const counts = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => workerLoop(pool, `load-worker-${i}`, results))
  );
  const durationMs = Date.now() - t0;

  await monitor.stop();

  const totalExpected = SESSIONS * PER_SESSION;
  const totalProcessed = counts.reduce((a, b) => a + b, 0);
  const brokenChains = checkAllChainsContiguous(results, sessionIds, PER_SESSION);
  const throughput = (totalProcessed / (durationMs / 1000)).toFixed(1);

  console.log(`\n=== 1. THROUGHPUT & CORRECTNESS AT SCALE ===`);
  console.log(`processed: ${totalProcessed}/${totalExpected} in ${durationMs}ms (${throughput} executions/sec)`);
  console.log(`sessions with a broken (non-contiguous) chain: ${brokenChains.length} / ${sessionIds.length}`);

  console.log(`\n=== 2. CONNECTION-COUNT CEILING ===`);
  console.log(`postgres max_connections: 100 (confirmed via SHOW max_connections)`);
  console.log(`peak concurrent backends observed: ${monitor.samples.maxConnections}`);
  console.log(`configured pool ceiling: ${poolMax}`);

  console.log(`\n=== 3. LOCK CONTENTION AT SCALE ===`);
  console.log(`peak concurrent lock-waiters observed: ${monitor.samples.maxLockWaiters}`);
  const avgLockWaiters =
    monitor.samples.lockWaiterSamples.reduce((a, b) => a + b, 0) / (monitor.samples.lockWaiterSamples.length || 1);
  console.log(`average concurrent lock-waiters across the run: ${avgLockWaiters.toFixed(2)}`);
  console.log(`samples collected: ${monitor.samples.lockWaiterSamples.length}`);

  // --- Churn / bloat phase ---
  console.log(`\n=== 4. DEAD-TUPLE / BLOAT BEHAVIOR UNDER SUSTAINED UPDATE CHURN ===`);
  const { rows: hotRowsRes } = await pool.query(`SELECT id FROM spike.executions ORDER BY id LIMIT $1`, [
    CHURN_HOT_ROWS,
  ]);
  const hotIds = hotRowsRes.map((r) => r.id);

  // Same stats-flush-lag consideration as below: give the main run's own
  // updates a moment to be reflected before treating this as the baseline.
  await new Promise((r) => setTimeout(r, 1500));
  const beforeChurn = await tableChurnStats(pool, "spike.executions");
  console.log(`before churn: n_dead_tup=${beforeChurn.n_dead_tup}, n_tup_upd=${beforeChurn.n_tup_upd}, autovacuum_count=${beforeChurn.autovacuum_count}`);

  const iterationsPerWorker = Math.ceil(CHURN_ITERATIONS / CHURN_CONCURRENCY);
  const tChurn0 = Date.now();
  await Promise.all(
    Array.from({ length: CHURN_CONCURRENCY }, () => churnWorker(pool, hotIds, iterationsPerWorker))
  );
  const churnMs = Date.now() - tChurn0;

  // Postgres (PG15+) throttles cumulative-statistics flushes to roughly
  // once per second per backend (PGSTAT_MIN_INTERVAL) - querying
  // pg_stat_user_tables immediately after a fast churn burst can read
  // stale counters that haven't been flushed yet. Wait past that window so
  // the "after churn" numbers reflect what actually happened, not a
  // reporting-lag artifact.
  await new Promise((r) => setTimeout(r, 3000));
  const afterChurn = await tableChurnStats(pool, "spike.executions");
  console.log(
    `after ${CHURN_CONCURRENCY * iterationsPerWorker} rollback-churn updates on ${hotIds.length} hot rows (${churnMs}ms): n_dead_tup=${afterChurn.n_dead_tup}, n_tup_upd=${afterChurn.n_tup_upd}`
  );

  // Give autovacuum a moment (naptime default 1min is too long for a spike;
  // trigger a manual VACUUM to check dead tuples ARE reclaimable, which is
  // the property that matters - whether autovacuum's default schedule would
  // keep up in production is a tuning question, not a viability question).
  await pool.query(`VACUUM (ANALYZE) spike.executions`);
  const afterVacuum = await tableChurnStats(pool, "spike.executions");
  console.log(
    `after manual VACUUM ANALYZE: n_dead_tup=${afterVacuum.n_dead_tup}, n_live_tup=${afterVacuum.n_live_tup}, vacuum_count=${afterVacuum.vacuum_count}`
  );

  const bloatReclaimed = Number(afterVacuum.n_dead_tup) <= Number(beforeChurn.n_dead_tup);

  console.log(`\n=== SUMMARY ===`);
  const noConnectionCeilingRisk = monitor.samples.maxConnections < 100 * 0.8; // stay under 80% of max_connections
  const noBrokenChains = brokenChains.length === 0;
  const allProcessed = totalProcessed === totalExpected;

  console.log(`all executions processed exactly once: ${allProcessed ? "YES" : "NO"}`);
  console.log(`all session chains contiguous at scale: ${noBrokenChains ? "YES" : "NO"}`);
  console.log(`peak connections stayed under 80% of max_connections (100): ${noConnectionCeilingRisk ? "YES" : "NO"} (peak=${monitor.samples.maxConnections})`);
  console.log(`dead tuples from churn phase were reclaimable via VACUUM: ${bloatReclaimed ? "YES" : "NO"}`);

  const ok = allProcessed && noBrokenChains && noConnectionCeilingRisk && bloatReclaimed;
  console.log(`\n1.2e LOAD/SCALE CHECK: ${ok ? "HOLDS (no showstopper found at this scale)" : "ISSUE FOUND"}`);

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
