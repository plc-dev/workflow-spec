// Module-wide named constants (ADR-0012 §5). `registry/` deliberately
// defines its OWN trust-tier vocabulary rather than importing
// `scheduler/`'s `TRUST_TIERS`/`TrustTier` (identical values, independent
// source) - ADR-0007's dependency direction has `scheduler/` depend on
// `registry/` (via `getPlacementFacts`), never the reverse, so `registry/`
// cannot import from `scheduler/` without inverting that direction. See
// docs/impl-plans/0007-registry.md's "Open questions".

export const MATERIALIZATION_COST_CLASSES = ["negligible", "heavy"] as const;
export type MaterializationCostClass = (typeof MATERIALIZATION_COST_CLASSES)[number];

export const TRUST_TIERS = ["unverified", "conformance-passed", "production-proven"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export const NESTING_TRANSPORTS = ["sdk", "http", "cli", "mcp"] as const;
export type NestingTransport = (typeof NESTING_TRANSPORTS)[number];
