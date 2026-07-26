import type { TrustTier } from "../shared/index.js";

// Trust tiers (design.md D5a), promoted from archive/placement-resolver/
// src/resolver.js per docs/impl-plans/0005-placement.md (task 4.1a). The
// authoritative source of a given service build's trust tier is the
// registry's `getPlacementFacts(digest, function)` (task 2.8, real as of
// docs/impl-plans/0007-registry.md); this module only needs the resulting
// tier string, supplied by the caller.
//
// **Revision (docs/impl-plans/0008-shared-database-consolidation.md):**
// `TRUST_TIERS`/`TrustTier` used to be defined here independently of
// `registry/`'s own identical vocabulary. Both now import the single
// canonical copy from `shared/trust-tier.ts` - see that file's own header
// comment for why `shared/` is the right home (below both modules,
// doesn't invert ADR-0007's `scheduler/` -> `registry/` dependency
// direction). Re-exported here so nothing importing `scheduler/`'s
// existing barrel needs to change.
export { TRUST_TIERS, type TrustTier } from "../shared/index.js";

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
  return tier === "production-proven";
}
