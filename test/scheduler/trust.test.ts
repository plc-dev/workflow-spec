import { describe, expect, it } from "vitest";
import { TRUST_TIERS, isTrustEligibleForOptimization } from "../../src/scheduler/index.js";

// TC-10 (docs/impl-plans/0005-placement.md): design.md D5a - "the
// scheduler only leans on a capability declaration once a service build
// has reached PRODUCTION-PROVEN." Pure function, no Postgres needed.
describe("scheduler/trust", () => {
  it("is eligible only for production-proven", () => {
    expect(isTrustEligibleForOptimization(TRUST_TIERS.PRODUCTION_PROVEN)).toBe(true);
  });

  it("is not eligible for unverified or conformance-passed", () => {
    expect(isTrustEligibleForOptimization(TRUST_TIERS.UNVERIFIED)).toBe(false);
    expect(isTrustEligibleForOptimization(TRUST_TIERS.CONFORMANCE_PASSED)).toBe(false);
  });
});
