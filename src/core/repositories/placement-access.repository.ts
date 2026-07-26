import type { PoolClient } from "pg";
import {
  SQL_COUNT_PLACEMENT_ACCESS_WITHIN_WINDOW,
  SQL_PRUNE_PLACEMENT_ACCESS_OLDER_THAN,
  SQL_RECORD_PLACEMENT_ACCESS,
} from "./queries/placement-access.queries.js";

export interface PlacementAccessRepo {
  record(contentHash: string, at?: Date): Promise<void>;
  // design.md D4a: the exact windowed frequency count (">= 3 accesses
  // within a 5-10 minute rolling window") - not derivable from
  // `placement.access_count`'s cumulative lifetime counter alone.
  countWithinWindow(contentHash: string, windowMs: number): Promise<number>;
  pruneOlderThan(contentHash: string, windowMs: number): Promise<void>;
}

// Bound to a caller-owned transaction client (ADR-0002), mirroring every
// other repository in this module.
export function createPlacementAccessRepo(client: PoolClient): PlacementAccessRepo {
  return {
    async record(contentHash, at) {
      await client.query(SQL_RECORD_PLACEMENT_ACCESS, [contentHash, at ?? null]);
    },

    async countWithinWindow(contentHash, windowMs) {
      const result = await client.query<{ count: number }>(
        SQL_COUNT_PLACEMENT_ACCESS_WITHIN_WINDOW,
        [contentHash, windowMs],
      );
      return result.rows[0]?.count ?? 0;
    },

    async pruneOlderThan(contentHash, windowMs) {
      await client.query(SQL_PRUNE_PLACEMENT_ACCESS_OLDER_THAN, [contentHash, windowMs]);
    },
  };
}
