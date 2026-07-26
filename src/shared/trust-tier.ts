// The trust-tier vocabulary (design.md D5a) - the single source of truth
// for the three trust-tier values, needed verbatim by BOTH `registry/`
// (which stores/validates this vocabulary, task 2.5) and `scheduler/`
// (which gates on it, task 4.1a). ADR-0007's dependency direction still
// holds unchanged (`scheduler/` depends on `registry/`, never the
// reverse) - this lives in `shared/` specifically because it's consumed
// by both without either depending on the other. See ADR-0012's
// `shared/database/`/`trust-tier` revision
// (docs/impl-plans/0008-shared-database-consolidation.md).
export const TRUST_TIERS = ["unverified", "conformance-passed", "production-proven"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];
