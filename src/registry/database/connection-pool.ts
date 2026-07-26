import { Pool, type PoolConfig } from "pg";

// Raw `pg`, no query builder/ORM (ADR-0009/D6a) - same convention as
// core/database/connection-pool.ts. `registry/` opens its OWN pool against
// its OWN database (ADR-0006) - never `core/`'s.
export function createPool(config: PoolConfig = {}): Pool {
  return new Pool(config);
}

// The minimal shape every registry read/repository function is typed
// against, rather than `PoolClient` specifically. `getEntry`/
// `getPlacementFacts` call repositories directly against a plain `Pool`
// (ADR-0006: these reads never join a transaction), while `admin.ts`'s
// `registerImage` calls the same repositories against a transaction's
// `PoolClient` (see database/transactions.ts) - both satisfy `Queryable`,
// so the repositories themselves don't need to know which one they got.
export interface Queryable {
  query: Pool["query"];
}
