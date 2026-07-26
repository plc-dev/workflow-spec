// Module-wide named constants (ADR-0012 §5).
//
// **Revision (docs/impl-plans/0008-shared-database-consolidation.md):**
// `TRUST_TIERS`/`TrustTier` used to be defined here independently of
// `scheduler/`'s own identical copy (see docs/impl-plans/0007-registry.md's
// original "Open questions" for why that seemed like the right call at the
// time - ADR-0007's dependency direction has `scheduler/` depend on
// `registry/`, never the reverse, so `registry/` couldn't import from
// `scheduler/` without inverting that direction). A local code review
// surfaced this as a real drift risk (the two copies had no
// TypeScript-checkable link), so both now import the single canonical
// copy from `shared/trust-tier.ts` instead - `shared/` sits below both
// modules, so importing from it doesn't invert ADR-0007's direction the
// way importing from `scheduler/` would have.
export { TRUST_TIERS, type TrustTier } from "../shared/index.js";

export const MATERIALIZATION_COST_CLASSES = ["negligible", "heavy"] as const;
export type MaterializationCostClass = (typeof MATERIALIZATION_COST_CLASSES)[number];

export const NESTING_TRANSPORTS = ["sdk", "http", "cli", "mcp"] as const;
export type NestingTransport = (typeof NESTING_TRANSPORTS)[number];

// Log event names (implementation-best-practices.md #3: no magic
// strings) - matches the LOG_EVENT_* convention already established in
// scheduler/constants.ts/session/session-log.ts/engine/*. `registerImage`/
// `recordTrustTier` are D12's privileged, audit-relevant writes (the
// structural half of the privilege split), which is exactly the kind of
// write worth a log line even before a real caller/app entrypoint exists.
export const LOG_EVENT_REGISTER_IMAGE = "registry.registerImage";
export const LOG_EVENT_RECORD_TRUST_TIER = "registry.recordTrustTier";
