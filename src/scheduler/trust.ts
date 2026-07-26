// Trust tiers (design.md D5a), promoted from archive/placement-resolver/
// src/resolver.js per docs/impl-plans/0005-placement.md (task 4.1a). The
// authoritative source of a given service build's trust tier is the
// registry's `getPlacementFacts(digest, function)` (task 2.8) - not yet a
// real module (see 0004's Scope note); this module only needs the
// resulting tier string, supplied by the caller.
export const TRUST_TIERS = {
  UNVERIFIED: "unverified",
  CONFORMANCE_PASSED: "conformance-passed",
  PRODUCTION_PROVEN: "production-proven",
} as const;

export type TrustTier = (typeof TRUST_TIERS)[keyof typeof TRUST_TIERS];

/**
 * The single gate that decides whether the scheduler may LEAN ON a
 * capability declaration (share/pool/COW-reuse). Per D5a the scheduler
 * must never do so below `production-proven`.
 *
 * This module does not call it internally - `scheduler/placement.ts`'s
 * functions return placement FACTS. The caller (task 4.7) must call this
 * before treating a resolved warm replica as safe to actually
 * share/pool/reuse.
 */
export function isTrustEligibleForOptimization(tier: TrustTier): boolean {
  return tier === TRUST_TIERS.PRODUCTION_PROVEN;
}
