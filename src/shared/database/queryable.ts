import type { Pool } from "pg";

// The minimal shape a repository needs to run a parameterized query
// against EITHER a plain `Pool` (a read with no transaction requirement)
// or an open transaction's `PoolClient` (a `Pool`/`PoolClient` both
// implement `query`, so both satisfy this without a repository needing to
// know or care which one it got). Used by `registry/` (ADR-0006: its reads
// never join `core/`'s step-completion transaction, so a plain `Pool` is
// enough) - `core/`'s own repositories keep requiring `PoolClient`
// specifically, a deliberate ADR-0002 constraint (everything in `core/`
// runs inside a transaction `core/` itself hands out), not retrofitted to
// this looser shape. See ADR-0012's `shared/database/` revision.
export interface Queryable {
  query: Pool["query"];
}
