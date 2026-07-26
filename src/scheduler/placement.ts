import type {
  CoreRepos,
  Placement,
  PlacementConfig,
  UpsertPlacementAccessInput,
} from "../core/index.js";
import { logger } from "../shared/index.js";
import {
  DEFAULT_PLACEMENT_CONFIG,
  LOG_EVENT_DEMOTE,
  LOG_EVENT_EVICT_LRU,
  LOG_EVENT_PROMOTE,
  LOG_EVENT_RECORD_ACCESS,
} from "./constants.js";

// Promoted from archive/placement-resolver/src/resolver.js (task 1.10)
// per ADR-0007's explicit split: the tables live in `core/`
// (docs/impl-plans/0005-placement.md), the decision/action logic below
// operates over them via a `CoreRepos` handed to it - mirroring
// session/session-log.ts's shape, never opening a connection of its own.
//
// Design stance, straight from design.md D4/D4a/D5a:
//   * Affinity is ALWAYS an optimization. A resolvePlacement miss is
//     NEVER an error - it just means "no warm replica, rehydrate
//     anywhere" (D4).
//   * Promotion/demotion thresholds are a cache-admission model with
//     TUNABLE parameters (D4a), not hardcoded constants - every function
//     that needs a threshold takes a `config` parameter.
//   * DECISION and ACTION are separated. evaluatePromotion/
//     evaluateDemotion are reads that return a decision object; they
//     never mutate residency state. promote()/demote() are the explicit
//     state-mutating actions.
//   * TRUST is not enforced here (see trust.ts) - this module returns
//     placement FACTS. Gating actual sharing/pooling/COW-reuse on trust
//     tier is the caller's job (design.md D5a / task 4.7).

export interface PlacementResolution {
  found: boolean;
  warm: boolean;
  contentHash: string;
  reason: "no-placement" | "warm-replica" | "cold-fact";
  placement?: Placement;
}

/**
 * resolvePlacement - the read path (D4). A miss is NOT an error: callers
 * use `found`/`warm` to decide whether to prefer a warm replica or fall
 * back to rehydrate-anywhere.
 */
export async function resolvePlacement(
  repos: CoreRepos,
  contentHash: string,
): Promise<PlacementResolution> {
  const placement = await repos.placement.findByContentHash(contentHash);
  if (!placement) {
    return { found: false, warm: false, contentHash, reason: "no-placement" };
  }
  return {
    found: true,
    // A row with a null replicaId is a tracked-but-cold fact (e.g.
    // demoted/evicted): still a miss for affinity purposes.
    warm: placement.replicaId != null,
    contentHash,
    reason: placement.replicaId != null ? "warm-replica" : "cold-fact",
    placement,
  };
}

// Extends (rather than re-declares) PlacementRepo's own upsert input -
// review finding: a hand-duplicated copy forwarded via an untyped
// `...spread` bypasses TypeScript's excess-property checking, so a
// future field rename/add on the repository side would silently drop
// data here instead of failing to compile.
export interface RecordAccessOptions extends Omit<UpsertPlacementAccessInput, "contentHash"> {
  /** Bounds access-log pruning; defaults to DEFAULT_PLACEMENT_CONFIG, not
   * auto-loaded from `placement_config` - pass a loaded PlacementConfig
   * explicitly (via `repos.placementConfig.load(...)`) if a non-default
   * profile applies. */
  config?: PlacementConfig;
}

/**
 * recordAccess - upsert a placement row and record one access against it.
 * MUST be called with a `repos` bound to the SAME transaction as any
 * session-log/durability-core write it should commit atomically with
 * (design.md D6's DEEP-consolidation property) - this function never
 * opens its own transaction.
 */
export async function recordAccess(
  repos: CoreRepos,
  contentHash: string,
  opts: RecordAccessOptions = {},
): Promise<Placement> {
  const { config = DEFAULT_PLACEMENT_CONFIG, at, ...upsertFields } = opts;

  const placement = await repos.placement.upsertAccess({ contentHash, at, ...upsertFields });
  await repos.placementAccess.record(contentHash, at);
  await repos.placementAccess.pruneOlderThan(contentHash, config.promotion.frequencyWindowMs);

  logger.debug({ contentHash }, LOG_EVENT_RECORD_ACCESS);
  return placement;
}

/**
 * Resolve the effective rehydration cost (ms) for a placement, applying
 * D4a's authority rule: the observed rolling average is authoritative
 * once enough real timings exist; otherwise fall back to the declared
 * materialization-cost-class prior; otherwise cost is unknown.
 */
export function effectiveRehydrationCostMs(
  placement: Placement,
  config: PlacementConfig,
): { costMs: number | null; source: "observed" | "declared-prior" | "unknown" } {
  const haveEnoughSamples =
    placement.observedRehydrationMs != null &&
    placement.observedSampleCount >= config.cost.observedMinSamples;

  if (haveEnoughSamples) {
    // Narrowed by haveEnoughSamples above - observedRehydrationMs is not null.
    return { costMs: placement.observedRehydrationMs as number, source: "observed" };
  }
  if (
    placement.declaredCostClass &&
    config.cost.classPriorsMs[placement.declaredCostClass] != null
  ) {
    return {
      costMs: config.cost.classPriorsMs[placement.declaredCostClass],
      source: "declared-prior",
    };
  }
  return { costMs: null, source: "unknown" };
}

export type PromotionReason =
  | "no-placement"
  | "already-pinned"
  | "not-interactive"
  | "cost-below-threshold"
  | "frequency-below-threshold"
  | "qualifies";

export interface PromotionDecision {
  promote: boolean;
  reason: PromotionReason;
  detail?: Record<string, unknown>;
}

/**
 * evaluatePromotion - D4a promotion decision (unpinned -> pinned). A pure
 * read: never mutates residency state. Promote requires ALL of:
 *   - interactivity == 'interactive'         (never auto-promote batch)
 *   - effective rehydration cost > threshold (not worth pinning if cheap)
 *   - windowed access frequency >= threshold (recently hot)
 */
export async function evaluatePromotion(
  repos: CoreRepos,
  contentHash: string,
  config: PlacementConfig = DEFAULT_PLACEMENT_CONFIG,
): Promise<PromotionDecision> {
  const placement = await repos.placement.findByContentHash(contentHash);
  if (!placement) {
    return { promote: false, reason: "no-placement" };
  }
  if (placement.pinned) {
    return { promote: false, reason: "already-pinned" };
  }

  const interactiveOk = placement.interactivity === "interactive";
  const { costMs, source: costSource } = effectiveRehydrationCostMs(placement, config);
  const costOk = costMs != null && costMs > config.promotion.rehydrationCostThresholdMs;
  const windowedAccessCount = await repos.placementAccess.countWithinWindow(
    contentHash,
    config.promotion.frequencyWindowMs,
  );
  const freqOk = windowedAccessCount >= config.promotion.frequencyThreshold;

  const promote = interactiveOk && costOk && freqOk;
  const reason: PromotionReason = promote
    ? "qualifies"
    : !interactiveOk
      ? "not-interactive"
      : !costOk
        ? "cost-below-threshold"
        : "frequency-below-threshold";

  return {
    promote,
    reason,
    detail: {
      interactivity: placement.interactivity,
      interactiveOk,
      costMs,
      costSource,
      costThresholdMs: config.promotion.rehydrationCostThresholdMs,
      costOk,
      windowedAccessCount,
      frequencyThreshold: config.promotion.frequencyThreshold,
      freqOk,
    },
  };
}

export type DemotionReason =
  | "no-placement"
  | "not-pinned"
  | "idle-past-threshold"
  | "still-within-idle-threshold";

export interface DemotionDecision {
  demote: boolean;
  reason: DemotionReason;
  detail?: Record<string, unknown>;
}

/**
 * evaluateDemotion - D4a idle-timeout demotion decision (pinned ->
 * unpinned), using a HIGHER idle threshold than promotion requires
 * (hysteresis). A pure read: never mutates residency state.
 */
export async function evaluateDemotion(
  repos: CoreRepos,
  contentHash: string,
  config: PlacementConfig = DEFAULT_PLACEMENT_CONFIG,
): Promise<DemotionDecision> {
  const placement = await repos.placement.findByContentHash(contentHash);
  if (!placement) {
    return { demote: false, reason: "no-placement" };
  }
  if (!placement.pinned) {
    return { demote: false, reason: "not-pinned" };
  }

  const idleMs =
    placement.lastAccessedAt == null
      ? Number.POSITIVE_INFINITY
      : Date.now() - placement.lastAccessedAt.getTime();
  const demote = idleMs > config.demotion.idleThresholdMs;

  return {
    demote,
    reason: demote ? "idle-past-threshold" : "still-within-idle-threshold",
    detail: { idleMs, idleThresholdMs: config.demotion.idleThresholdMs },
  };
}

/** Promote a hash to pinned residency. Explicit action, separate from decision. */
export async function promote(repos: CoreRepos, contentHash: string): Promise<Placement> {
  const placement = await repos.placement.setPinned(contentHash, true);
  logger.debug({ contentHash }, LOG_EVENT_PROMOTE);
  return placement;
}

/** Demote a hash to unpinned. Keeps the row/fact; only clears residency. */
export async function demote(repos: CoreRepos, contentHash: string): Promise<Placement> {
  const placement = await repos.placement.setPinned(contentHash, false);
  logger.debug({ contentHash }, LOG_EVENT_DEMOTE);
  return placement;
}

/**
 * evictLRUIfOverCapacity - capacity-aware LRU eviction (D4a). If the
 * total size of the PINNED set exceeds the configured budget, unpin
 * least-recently-used PINNED entries until the pinned total is back
 * within budget. Scoped to the PINNED set ONLY - unpinned rows are never
 * touched. Unpins (demote), never deletes, so the placement fact and its
 * access history survive and can re-qualify for promotion later.
 * Independent of trust tier (D5a/4.7 governs sharing/reuse, not capacity
 * reclaim). Returns the evicted content hashes, LRU-first.
 */
export async function evictLRUIfOverCapacity(
  repos: CoreRepos,
  config: PlacementConfig = DEFAULT_PLACEMENT_CONFIG,
): Promise<string[]> {
  const budget = config.capacity.pinnedBudgetBytes;
  const pinned = await repos.placement.listPinnedOrderedByLru();

  let total = pinned.reduce((sum, p) => sum + p.sizeBytes, 0);
  if (total <= budget) {
    return [];
  }

  const evicted: string[] = [];
  for (const placement of pinned) {
    if (total <= budget) {
      break;
    }
    await demote(repos, placement.contentHash);
    total -= placement.sizeBytes;
    evicted.push(placement.contentHash);
  }

  logger.debug({ evicted, budget }, LOG_EVENT_EVICT_LRU);
  return evicted;
}
