import { makePool } from "./db.js";
import { processOneExecution } from "./worker.js";

// Proves the DEEP consolidation claim on the happy path: after processing
// every queued execution for one session, the executions/checkpoints,
// session_log, and placement tables must all be mutually consistent -
// because they were written in the SAME transaction each time, not three
// eventually-consistent writes across separate systems.

const pool = makePool();

async function main() {
  let processed = 0;
  while (true) {
    const result = await processOneExecution(pool, "worker-happy");
    if (!result) break;
    processed++;
  }

  const { rows: execRows } = await pool.query(
    `SELECT count(*)::int AS n FROM spike.executions WHERE status = 'done'`
  );
  const { rows: ckRows } = await pool.query(`SELECT count(*)::int AS n FROM spike.checkpoints`);
  const { rows: logRows } = await pool.query(
    `SELECT seq, mutation->>'resultHash' AS hash FROM spike.session_log ORDER BY seq`
  );
  const { rows: ptrRows } = await pool.query(`SELECT * FROM spike.session_pointer`);
  const { rows: placementRows } = await pool.query(`SELECT count(*)::int AS n FROM spike.placement`);

  console.log(`processed: ${processed}`);
  console.log(`done executions: ${execRows[0].n}`);
  console.log(`checkpoints: ${ckRows[0].n}`);
  console.log(`session_log rows: ${logRows.length}`);
  console.log(`session_pointer:`, ptrRows[0]);
  console.log(`placement rows (distinct content hashes ever warm): ${placementRows[0].n}`);

  // Assertions: same-transaction atomicity means these three counts must
  // agree exactly, and the log's seq numbers must be contiguous (D3 linear
  // chain, no gaps, no duplicates) and match the final pointer.
  const seqs = logRows.map((r) => Number(r.seq));
  const contiguous = seqs.every((s, i) => s === i + 1);
  const lastLogHash = logRows[logRows.length - 1]?.hash;
  const pointerMatchesLog = ptrRows[0]?.head_hash === lastLogHash && Number(ptrRows[0]?.head_seq) === seqs.length;

  const ok =
    processed === execRows[0].n &&
    processed === ckRows[0].n &&
    processed === logRows.length &&
    contiguous &&
    pointerMatchesLog;

  console.log(`\nDEEP-consolidation invariant (executions == checkpoints == session_log, contiguous, pointer matches): ${ok ? "HOLDS" : "VIOLATED"}`);

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
