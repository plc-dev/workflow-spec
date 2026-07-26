import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlacementFacts } from "../../src/registry/get-placement-facts.js";
import { createServiceImagesRepo } from "../../src/registry/repositories/service-images.repository.js";
import type { TestPostgres } from "../helpers/postgres.js";
import {
  resetRegistryTables,
  seedFixtureImage,
  startRegistryPostgres,
} from "../helpers/registry-postgres.js";
import {
  CAPABILITY_METADATA,
  DIGEST,
  HARDWARE_REQUIREMENTS,
  OCI_REF,
  OPENAPI_SPEC,
} from "./fixtures.js";

// TC-6/TC-7 (docs/impl-plans/0007-registry.md): D12's "returns capability
// metadata, trust tier, and hardware requirements together, so callers
// never observe them skewed relative to one another."
describe("getPlacementFacts", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startRegistryPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await resetRegistryTables(tp.pool);
    await seedFixtureImage(tp.pool, {
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      hardwareRequirements: HARDWARE_REQUIREMENTS,
      capabilityMetadata: CAPABILITY_METADATA,
    });
  });

  it("returns capability metadata, trust tier, and hardware requirements together for the requested function", async () => {
    const facts = await getPlacementFacts(tp.pool, DIGEST, "loadDump");
    expect(facts?.function).toBe("loadDump");
    // Deep-equals the FULL capability object (not just cowSupport) so a
    // field silently dropped by SQL_GET_PLACEMENT_FACTS - e.g. from a
    // hand-maintained column list drifting out of sync with a new
    // FunctionCapability field - fails this test instead of returning
    // `undefined` unnoticed (local review finding).
    expect(facts?.capability).toEqual(CAPABILITY_METADATA.loadDump);
    expect(facts?.trustTier).toBe("unverified");
    expect(facts?.hardwareRequirements).toEqual(HARDWARE_REQUIREMENTS);
  });

  it("returns null for a function absent from function_capabilities even though the digest is registered", async () => {
    expect(await getPlacementFacts(tp.pool, DIGEST, "nope")).toBeNull();
  });

  it("reflects a trust-tier transition immediately, with no staleness", async () => {
    await createServiceImagesRepo(tp.pool).updateTrustTier(DIGEST, "conformance-passed");
    await createServiceImagesRepo(tp.pool).updateTrustTier(DIGEST, "production-proven");

    const facts = await getPlacementFacts(tp.pool, DIGEST, "runQuery");
    expect(facts?.trustTier).toBe("production-proven");
  });
});
