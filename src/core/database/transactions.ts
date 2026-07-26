import type { Pool, PoolClient } from "pg";
import {
  type CheckpointsRepo,
  createCheckpointsRepo,
} from "../repositories/checkpoints.repository.js";
import {
  type ExecutionsRepo,
  createExecutionsRepo,
} from "../repositories/executions.repository.js";

// ADR-0002: `core/` exposes `withTransaction(fn) -> repos`. Higher-level
// concerns (engine/, and later session/, scheduler/, dataset-catalog/)
// receive a transaction (via these repos) from a caller and never open
// their own connection or own any schema - this is the ONE place a
// transaction is opened/committed/rolled back.
//
// This package builds only the `executions`/`checkpoints` members of the
// eventual full repo set (ADR-0002's diagram also lists `waits`,
// `sessionLog`, `placement`, `datasetIndex`, `memoization`) - those are
// added incrementally by the packages that actually need them, per
// docs/impl-plans/0001-durable-core.md's "Open questions" section.
export interface CoreRepos {
  executions: ExecutionsRepo;
  checkpoints: CheckpointsRepo;
  // The raw transaction client itself, for a caller that needs to issue
  // its own query on the SAME transaction before a typed repo exists for
  // it yet (e.g. a future session/scheduler write, or - in this package's
  // own tests - a raw query proving the composability shape works). Typed
  // repos above remain the preferred surface; this exists so "operate
  // within a transaction handed to them" (ADR-0002) isn't blocked on a
  // repo existing for every concern on day one.
  client: PoolClient;
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (repos: CoreRepos) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // A forcibly terminated backend (e.g. a crash test using
  // pg_terminate_backend) emits an 'error' event on the client; without a
  // listener, Node treats it as unhandled. Removed in `finally` so the
  // pool's underlying Client re-use across connect() calls doesn't
  // accumulate listeners.
  const swallowError = () => {};
  client.on("error", swallowError);
  try {
    await client.query("BEGIN");
    const repos: CoreRepos = {
      executions: createExecutionsRepo(client),
      checkpoints: createCheckpointsRepo(client),
      client,
    };
    const result = await fn(repos);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection may already be dead (e.g. a crash test that terminated
      // the backend mid-transaction) - rollback itself failing is expected
      // in that case, not a new error worth surfacing over the original.
    }
    throw err;
  } finally {
    client.off("error", swallowError);
    client.release();
  }
}
