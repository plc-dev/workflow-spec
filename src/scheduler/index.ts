export { DEFAULT_PLACEMENT_CONFIG } from "./constants.js";
export {
  type DemotionDecision,
  type DemotionReason,
  demote,
  effectiveRehydrationCostMs,
  evaluateDemotion,
  evaluatePromotion,
  evictLRUIfOverCapacity,
  type PlacementResolution,
  promote,
  type PromotionDecision,
  type PromotionReason,
  recordAccess,
  type RecordAccessOptions,
  resolvePlacement,
} from "./placement.js";
export { isTrustEligibleForOptimization, TRUST_TIERS, type TrustTier } from "./trust.js";
