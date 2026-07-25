import { makePool, resetSpikeSchema } from "./db.js";

// Seeds a single map node over an array of N integers (default 12). Its
// cardinality is only knowable at fan-out time, from this runtime-sized
// source array (design.md D8). Used for manual poking; the test scripts seed
// their own scenarios inline.
const N = Number(process.argv[2] ?? 12);

const pool = makePool();

async function main() {
  await resetSpikeSchema(pool);
  const source = Array.from({ length: N }, (_, i) => i + 1);
  const { rows } = await pool.query(
    `INSERT INTO spike.executions (kind, step, input)
     VALUES ('map', 'enrichEach', $1) RETURNING id`,
    [JSON.stringify({ source })]
  );
  console.log(`Seeded map execution ${rows[0].id} over ${N} items: [${source.join(", ")}]`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
