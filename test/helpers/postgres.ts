import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "../../src/core/database/schema.sql");

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  /** A separate, single-purpose client for crash tests that need to
   * `pg_terminate_backend` another connection's backend PID. */
  adminPool: Pool;
  stop(): Promise<void>;
}

export interface StartTestPostgresOptions {
  /** Defaults to core/'s schema.sql - pass registry/'s (or any other
   * module's own database's) schema.sql path to stand up a SEPARATE
   * ephemeral instance for a module with its own database (ADR-0006). */
  schemaPath?: string;
}

// ADR-0009: every test whose behavior depends on real Postgres semantics
// runs against a real, ephemeral, testcontainers-managed instance - not
// mocked. One container per test file (started in `beforeAll`), schema.sql
// applied fresh (ADR-0009's deferred-migrations decision).
export async function startTestPostgres(
  options: StartTestPostgresOptions = {},
): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const connectionString = container.getConnectionUri();

  const schema = await readFile(options.schemaPath ?? SCHEMA_PATH, "utf8");
  const setupPool = new Pool({ connectionString });
  await setupPool.query(schema);
  await setupPool.end();

  const pool = new Pool({ connectionString });
  const adminPool = new Pool({ connectionString });

  return {
    container,
    pool,
    adminPool,
    async stop() {
      await pool.end();
      await adminPool.end();
      await container.stop();
    },
  };
}
