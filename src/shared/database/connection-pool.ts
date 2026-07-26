import { Pool, type PoolConfig } from "pg";

// Raw `pg`, no query builder/ORM (ADR-0009/D6a). A thin `new Pool(config)`
// wrapper with no schema/module opinion of its own - every database-owning
// module (core/, registry/, and prospectively workflow-store/) opens its
// OWN pool against its OWN database (ADR-0002/ADR-0006) via this one
// factory, per ADR-0012's `shared/database/` revision
// (docs/impl-plans/0008-shared-database-consolidation.md).
export function createPool(config: PoolConfig = {}): Pool {
  return new Pool(config);
}
