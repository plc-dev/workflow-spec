import { makePool, resetSpikeSchema } from "./db.js";

// Seeds N queued executions representing the SQL-session scenario: each
// execution is "apply one user mutation to session S's materialized SQL
// dump, then advance the session's snapshot chain and placement".
const N = Number(process.argv[2] ?? 20);
const SESSION_ID = process.argv[3] ?? "session-A";

const pool = makePool();

async function main() {
  await resetSpikeSchema(pool);

  for (let i = 0; i < N; i++) {
    await pool.query(
      `INSERT INTO spike.executions (session_id, step, input) VALUES ($1, $2, $3)`,
      [SESSION_ID, "sql_mutate", JSON.stringify({ mutationIndex: i, sql: `UPDATE t SET x = ${i}` })]
    );
  }
  await pool.query(
    `INSERT INTO spike.session_pointer (session_id, head_seq, head_hash) VALUES ($1, 0, 'root')
     ON CONFLICT (session_id) DO NOTHING`,
    [SESSION_ID]
  );

  console.log(`Seeded ${N} queued executions for ${SESSION_ID}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
