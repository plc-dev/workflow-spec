import type { PoolClient } from "pg";
import {
  type PlacementConfig,
  type PlacementConfigRow,
  mapPlacementConfigRow,
} from "../domain/index.js";
import { SQL_LOAD_PLACEMENT_CONFIG } from "./queries/placement-config.queries.js";

export interface PlacementConfigRepo {
  // Returns null when no row exists for `name` - the caller (scheduler/'s
  // decision functions) falls back to DEFAULT_PLACEMENT_CONFIG; this
  // repository makes no such judgment call itself (design.md D4a).
  load(name: string): Promise<PlacementConfig | null>;
}

// Bound to a caller-owned transaction client (ADR-0002), mirroring every
// other repository in this module.
export function createPlacementConfigRepo(client: PoolClient): PlacementConfigRepo {
  return {
    async load(name) {
      const result = await client.query<PlacementConfigRow>(SQL_LOAD_PLACEMENT_CONFIG, [name]);
      const row = result.rows[0];
      return row ? mapPlacementConfigRow(row) : null;
    },
  };
}
