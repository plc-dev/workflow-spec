import type { Pool, PoolClient } from "pg";

// GENERIC transaction wrapper (ADR-0012's `shared/database/` revision,
// docs/impl-plans/0008-shared-database-consolidation.md) - the mechanism
// every database-owning module's own `withTransaction`-shaped function
// (`core/database/transactions.ts`'s `withTransaction`, `registry/
// database/transactions.ts`'s `withRegistryTransaction`) delegates to,
// rather than each hand-rolling the same BEGIN/COMMIT/ROLLBACK/error-
// listener mechanics. `buildRepos` is the one piece that's genuinely
// module-specific (each module's own repo set, shaped however that
// module's own `withTransaction`-shaped wrapper wants to expose it) - this
// function owns only the transaction lifecycle around it.
//
// The `'error'` listener and the tolerant rollback both originate from
// `core/`'s original implementation (0001) and were the one thing
// `registry/`'s independent first copy (0007) was missing before this
// revision:
//   - a forcibly terminated backend (e.g. a crash test using
//     `pg_terminate_backend`, or a real dropped connection) emits an
//     `'error'` event on the client; without a listener, Node treats it
//     as unhandled. Removed in `finally` so the pool's underlying client
//     re-use across `connect()` calls doesn't accumulate listeners.
//   - if the connection is already dead when the `catch` block runs, the
//     `ROLLBACK` itself will throw - that failure is expected in that
//     case, and must never replace/mask the original error the caller
//     actually needs to see.
export async function withTransaction<Repos, T>(
  pool: Pool,
  buildRepos: (client: PoolClient) => Repos,
  fn: (repos: Repos) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const swallowError = () => {};
  client.on("error", swallowError);
  try {
    await client.query("BEGIN");
    const repos = buildRepos(client);
    const result = await fn(repos);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection may already be dead - rollback itself failing is
      // expected in that case, not a new error worth surfacing over the
      // original.
    }
    throw err;
  } finally {
    client.off("error", swallowError);
    client.release();
  }
}
