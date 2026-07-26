import { describe, expect, it } from "vitest";
import * as adminModule from "../../src/registry/admin.js";
import * as conformanceModule from "../../src/registry/conformance.js";
import * as registryIndex from "../../src/registry/index.js";

// TC-11/TC-12 (docs/impl-plans/0007-registry.md): ADR-0006's structural
// privilege split - "no data-plane package can depend on the admin
// surface at all - it simply isn't part of what those packages import."
// No Postgres needed - a pure module-shape assertion.
describe("registry/ privilege split", () => {
  it("registry/index.ts's barrel does not export registerImage or recordTrustTier", () => {
    expect(Object.keys(registryIndex)).not.toContain("registerImage");
    expect(Object.keys(registryIndex)).not.toContain("recordTrustTier");
  });

  it("registry/admin.js exports only registerImage", () => {
    expect(Object.keys(adminModule)).toEqual(["registerImage"]);
  });

  it("registry/conformance.js exports only recordTrustTier", () => {
    expect(Object.keys(conformanceModule)).toEqual(["recordTrustTier"]);
  });
});
