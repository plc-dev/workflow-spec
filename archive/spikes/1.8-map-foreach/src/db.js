import pg from "pg";

const { Pool } = pg;

// This spike runs its own Postgres container on :55433 so it can coexist with
// spike 1.2's :55432 (see FINDINGS.md "How to reproduce").
export function makePool(overrides = {}) {
  return new Pool({
    host: "localhost",
    port: 55433,
    user: "postgres",
    password: "spike",
    database: "spike",
    ...overrides,
  });
}

// Single source of truth for "wipe every spike table" so seed and test
// scripts can't drift out of sync with schema.sql (same discipline as spike
// 1.2's db.js). CASCADE handles the executions self-FK and the map_* FKs.
export async function resetSpikeSchema(pool) {
  await pool.query(`
    TRUNCATE
      spike.executions,
      spike.checkpoints,
      spike.map_nodes,
      spike.map_results
    RESTART IDENTITY CASCADE
  `);
}
