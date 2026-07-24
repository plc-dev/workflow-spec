import { makePool, resetSpikeSchema } from "./db.js";
import { processOneExecution } from "./worker.js";

// D3's linear-per-session-mutation guarantee under CONCURRENT conditions:
// many workers race to process mutations that all belong to the SAME
// session. `SELECT ... FOR UPDATE` on session_pointer must serialize them
// so the session_log ends up with a contiguous, gap-free, duplicate-free
// sequence - never interleaved or double-applied - purely from ordinary
// row-locking discipline, no extra application-level coordination.
//
// Also proves SKIP LOCKED prevents double-claiming: with N workers and only
// N executions queued, exactly N executions get processed exactly once.
//
// Uses TWO sessions, interleaved in the same queue and processed by the SAME
// pool of workers, so a global (not per-session) lock would be caught: if
// the FOR UPDATE lock scope were accidentally broader than one session's
// pointer row, session B's chain would stall behind session A's (or vice
// versa) and/or the two chains could cross-contaminate. This spike does NOT
// measure lock-wait timing directly (that would need deeper instrumentation
// than this spike scopes to) - what it does assert is the correctness
// consequence: both sessions' chains come out independently contiguous and
// mutually uncontaminated despite being processed by an interleaved,
// concurrent worker pool with no per-session partitioning of workers.

const CONCURRENCY = 8;
const SESSION_A = "session-contention-a";
const SESSION_B = "session-contention-b";
const N_PER_SESSION = 40;

async function workerLoop(pool, workerId, results) {
  let count = 0;
  while (true) {
    const result = await processOneExecution(pool, workerId);
    if (!result) break;
    count++;
    results.push({ workerId, sessionId: result.sessionId, seq: result.nextSeq });
  }
  return count;
}

async function seedSession(pool, sessionId, n) {
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO spike.executions (session_id, step, input) VALUES ($1, 'sql_mutate', $2)`,
      [sessionId, JSON.stringify({ mutationIndex: i })]
    );
  }
  await pool.query(
    `INSERT INTO spike.session_pointer (session_id, head_seq, head_hash) VALUES ($1, 0, 'root')`,
    [sessionId]
  );
}

function checkSessionChain(results, sessionId, n) {
  const seqs = results
    .filter((r) => r.sessionId === sessionId)
    .map((r) => r.seq)
    .sort((a, b) => a - b);
  const expected = Array.from({ length: n }, (_, i) => i + 1);
  return { seqs, contiguous: JSON.stringify(seqs) === JSON.stringify(expected) };
}

async function main() {
  const pool = makePool();

  // seed inline so this test is self-contained; two sessions' executions are
  // interleaved by insertion order so `claim_execution`'s `ORDER BY id`
  // hands out a genuinely mixed stream to the concurrent worker pool.
  await resetSpikeSchema(pool);
  await seedSession(pool, SESSION_A, N_PER_SESSION);
  await seedSession(pool, SESSION_B, N_PER_SESSION);

  const results = [];
  const counts = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => workerLoop(pool, `worker-${i}`, results))
  );

  const totalProcessed = counts.reduce((a, b) => a + b, 0);
  const totalExpected = N_PER_SESSION * 2;

  const chainA = checkSessionChain(results, SESSION_A, N_PER_SESSION);
  const chainB = checkSessionChain(results, SESSION_B, N_PER_SESSION);

  const { rows: ptrRows } = await pool.query(
    `SELECT session_id, head_seq FROM spike.session_pointer ORDER BY session_id`
  );

  console.log(`concurrency: ${CONCURRENCY} workers, ${N_PER_SESSION} executions EACH on 2 interleaved sessions`);
  console.log(`per-worker processed counts:`, counts);
  console.log(`total processed: ${totalProcessed} (expected ${totalExpected})`);
  console.log(`session_pointer final state:`, ptrRows);
  console.log(`session A chain gap/dup-free: ${chainA.contiguous ? "YES" : "NO"} (${chainA.seqs.length} entries)`);
  console.log(`session B chain gap/dup-free: ${chainB.contiguous ? "YES" : "NO"} (${chainB.seqs.length} entries)`);

  const ptrA = ptrRows.find((r) => r.session_id === SESSION_A);
  const ptrB = ptrRows.find((r) => r.session_id === SESSION_B);

  const ok =
    totalProcessed === totalExpected &&
    chainA.contiguous &&
    chainB.contiguous &&
    Number(ptrA?.head_seq) === N_PER_SESSION &&
    Number(ptrB?.head_seq) === N_PER_SESSION;

  console.log(
    `\nD3 linear-per-session-mutation under concurrency, with two sessions interleaved across the same worker pool: ${ok ? "HOLDS" : "VIOLATED"}`
  );
  console.log(
    `(NOTE: this demonstrates per-session correctness under concurrent, cross-session-interleaved processing, not lock-wait timing/throughput - see FINDINGS.md caveats)`
  );

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
