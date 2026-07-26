import type { PoolClient } from "pg";
import { ERROR_IDS, FatalError } from "../../shared/index.js";
import { type Placement, type PlacementRow, mapPlacementRow } from "../domain/index.js";
import {
  SQL_FIND_PLACEMENT_BY_CONTENT_HASH,
  SQL_LIST_PINNED_PLACEMENTS_ORDERED_BY_LRU,
  SQL_SET_PLACEMENT_PINNED,
  SQL_UPSERT_PLACEMENT_ACCESS,
} from "./queries/placement.queries.js";

export interface UpsertPlacementAccessInput {
  contentHash: string;
  replicaId?: string | null;
  sessionId?: string | null;
  interactivity?: "interactive" | "batch" | null;
  sizeBytes?: number | null;
  declaredCostClass?: Placement["declaredCostClass"];
  observedRehydrationMs?: number | null;
  /** Access timestamp - exposed mainly so tests can simulate elapsed time. */
  at?: Date;
}

export interface PlacementRepo {
  findByContentHash(contentHash: string): Promise<Placement | null>;
  // The upsert half of the archived resolver's `recordAccess` (design.md
  // D4a) - inserts a first-seen row, or folds a new access/observation
  // into the existing row (COALESCE-based partial update; access-count
  // bookkeeping always advances). Does NOT touch `placement_access` -
  // that's PlacementAccessRepo.record's job; scheduler.recordAccess
  // composes both against the same transaction.
  upsertAccess(input: UpsertPlacementAccessInput): Promise<Placement>;
  // The shared mutation behind both promote()/demote() (design.md D4a's
  // decision/action separation lives in scheduler/, not here - this is
  // the one action primitive both call).
  setPinned(contentHash: string, pinned: boolean): Promise<Placement>;
  listPinnedOrderedByLru(): Promise<Placement[]>;
}

// Bound to a caller-owned transaction client (ADR-0002), mirroring
// ExecutionsRepo/CheckpointsRepo/WaitsRepo - never opens its own
// connection. `scheduler/`'s decision logic (evaluatePromotion,
// evictLRUIfOverCapacity, ...) composes these primitives; this repository
// has no decision-shaped logic of its own (ADR-0007).
export function createPlacementRepo(client: PoolClient): PlacementRepo {
  return {
    async findByContentHash(contentHash) {
      const result = await client.query<PlacementRow>(SQL_FIND_PLACEMENT_BY_CONTENT_HASH, [
        contentHash,
      ]);
      const row = result.rows[0];
      return row ? mapPlacementRow(row) : null;
    },

    async upsertAccess(input) {
      const {
        contentHash,
        replicaId = null,
        sessionId = null,
        interactivity = null,
        sizeBytes = null,
        declaredCostClass = null,
        observedRehydrationMs = null,
        at,
      } = input;
      const result = await client.query<PlacementRow>(SQL_UPSERT_PLACEMENT_ACCESS, [
        contentHash,
        replicaId,
        sessionId,
        interactivity,
        declaredCostClass,
        sizeBytes,
        at ?? null,
        observedRehydrationMs,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.CORE_PLACEMENT_UPSERT_NO_ROW_RETURNED, {
          context: { contentHash },
        });
      }
      return mapPlacementRow(row);
    },

    async setPinned(contentHash, pinned) {
      const result = await client.query<PlacementRow>(SQL_SET_PLACEMENT_PINNED, [
        contentHash,
        pinned,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.CORE_PLACEMENT_SET_PINNED_NOT_FOUND, {
          context: { contentHash, pinned },
        });
      }
      return mapPlacementRow(row);
    },

    async listPinnedOrderedByLru() {
      const result = await client.query<PlacementRow>(SQL_LIST_PINNED_PLACEMENTS_ORDERED_BY_LRU);
      return result.rows.map(mapPlacementRow);
    },
  };
}
