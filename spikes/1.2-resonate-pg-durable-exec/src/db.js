import pg from "pg";

const { Pool } = pg;

export function makePool() {
  return new Pool({
    host: "localhost",
    port: 55432,
    user: "postgres",
    password: "spike",
    database: "spike",
  });
}

// Single source of truth for "wipe every spike table" so seed.js and the
// test scripts can't drift out of sync with schema.sql (a table added there
// but missed here would silently leave stale rows behind for whichever test
// forgot to update its own copy of this list).
export async function resetSpikeSchema(pool) {
  await pool.query(`
    TRUNCATE
      spike.executions,
      spike.checkpoints,
      spike.session_log,
      spike.session_pointer,
      spike.placement
    RESTART IDENTITY CASCADE
  `);
}
