import { Pool, type PoolConfig } from "pg";

// Raw `pg`, no query builder/ORM (ADR-0009/D6a) - this system's durability
// core depends on explicit transaction boundaries and `FOR UPDATE SKIP
// LOCKED`/`LISTEN`/`NOTIFY` semantics an ORM would abstract over.
export function createPool(config: PoolConfig = {}): Pool {
  return new Pool(config);
}
