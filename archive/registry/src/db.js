import pg from "pg";

const { Pool } = pg;

// Connection pool helper, same style as
// spikes/1.2-resonate-pg-durable-exec/src/db.js. Port 55444 is the
// registry's own local Postgres (spike 1.2 uses 55432, spike 1.8 uses
// 55433) so they can run side by side without collision.
export function makePool(overrides = {}) {
  return new Pool({
    host: "localhost",
    port: 55444,
    user: "postgres",
    password: "registry",
    database: "registry",
    ...overrides,
  });
}

// Single source of truth for wiping every registry table, so tests can't
// drift out of sync with schema.sql. ON DELETE CASCADE on
// function_capabilities means truncating service_images alone would also do
// it, but listing both is explicit and future-proof.
export async function resetRegistrySchema(pool) {
  await pool.query(`
    TRUNCATE
      registry.function_capabilities,
      registry.service_images
    RESTART IDENTITY CASCADE
  `);
}
