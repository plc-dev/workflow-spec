import { describe, expect, it } from "vitest";
import { isTrustEligibleForOptimization } from "../../src/scheduler/index.js";

// TC-10 (docs/impl-plans/0005-placement.md): design.md D5a - "the
// scheduler only leans on a capability declaration once a service build
// has reached PRODUCTION-PROVEN." Pure function, no Postgres needed.
//
// Literal tier strings (not a TRUST_TIERS.PRODUCTION_PROVEN-style
// dot-access constant) since TRUST_TIERS moved to shared/trust-tier.ts as
// an array/tuple (docs/impl-plans/0008-shared-database-consolidation.md),
// matching this codebase's existing "as const" tuple convention for
// enums elsewhere (e.g. scheduler/placement.test.ts's own
// interactivity: "interactive"/"batch" literals).
describe("scheduler/trust", () => {
  it("is eligible only for production-proven", () => {
    expect(isTrustEligibleForOptimization("production-proven")).toBe(true);
  });

  it("is not eligible for unverified or conformance-passed", () => {
    expect(isTrustEligibleForOptimization("unverified")).toBe(false);
    expect(isTrustEligibleForOptimization("conformance-passed")).toBe(false);
  });
});
