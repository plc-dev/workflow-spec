import pg from "pg";

const { Pool } = pg;

export function makePool(overrides = {}) {
  return new Pool({
    host: "localhost",
    port: 55555,
    user: "postgres",
    password: "ir",
    database: "ir",
    ...overrides,
  });
}

export async function resetSchema(pool) {
  await pool.query(`
    TRUNCATE
      ir.executions,
      ir.checkpoints,
      ir.map_nodes,
      ir.branch_nodes,
      ir.run_node_outputs,
      ir.workflow_runs
    RESTART IDENTITY CASCADE
  `);
}
