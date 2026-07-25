import pg from "pg";

const { Pool } = pg;

// Port chosen to avoid every container currently running on this host
// (checked via `docker ps` at build time). The test harness boots its own
// throwaway Postgres via the background_process tool on this port.
export const TEST_PG = {
  host: "localhost",
  port: 55544,
  user: "postgres",
  password: "placement",
  database: "placement",
};

export function makePool(overrides = {}) {
  return new Pool({ ...TEST_PG, ...overrides });
}

// Truncate every table so each test starts clean. Kept as a single source of
// truth so tests can't drift out of sync with schema.sql.
export async function resetSchema(exec) {
  await exec.query(`
    TRUNCATE placement.placement, placement.placement_access RESTART IDENTITY CASCADE
  `);
}
