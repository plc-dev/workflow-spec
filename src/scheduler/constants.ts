import type { PlacementConfig } from "../core/index.js";

// TypeScript-side mirror of `core/database/schema.sql`'s seeded
// `placement_config` 'default' row (design.md D4a's starting defaults) -
// used as this module's fallback when no named profile row exists yet.
// Kept in sync by hand with the seeded SQL row, same posture as
// core/constants.ts's DEFAULT_LEASE_SECONDS.
export const DEFAULT_PLACEMENT_CONFIG: PlacementConfig = {
  promotion: {
    frequencyThreshold: 3, // >= N accesses ...
    frequencyWindowMs: 420_000, // ... within this rolling window (7 min, D4a: 5-10 min)
    rehydrationCostThresholdMs: 250, // cost must exceed this to be worth pinning
  },
  demotion: {
    // Deliberately higher than promotion.frequencyWindowMs - D4a's
    // promote-quick, demote-slow hysteresis.
    idleThresholdMs: 1_200_000, // 20 min
  },
  capacity: {
    pinnedBudgetBytes: 1_073_741_824, // 1 GiB pinned-pool budget
  },
  cost: {
    observedMinSamples: 5, // switch to observed avg once this many samples seen
    classPriorsMs: {
      trivial: 10,
      cheap: 50,
      moderate: 300,
      expensive: 2000,
    },
  },
};

// Log event names (implementation-best-practices.md #3: no magic strings).
export const LOG_EVENT_RECORD_ACCESS = "scheduler.recordAccess";
export const LOG_EVENT_PROMOTE = "scheduler.promote";
export const LOG_EVENT_DEMOTE = "scheduler.demote";
export const LOG_EVENT_EVICT_LRU = "scheduler.evictLRUIfOverCapacity";
