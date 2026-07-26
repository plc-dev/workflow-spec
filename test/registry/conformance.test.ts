import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordTrustTier } from "../../src/registry/conformance.js";
import { getPlacementFacts } from "../../src/registry/get-placement-facts.js";
import { ERROR_IDS, FatalError } from "../../src/shared/index.js";
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

// TC-7/TC-8 (docs/impl-plans/0007-registry.md).
describe("recordTrustTier", () => {
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

  it("transitions unverified -> conformance-passed -> production-proven, reflected immediately by getPlacementFacts", async () => {
    const t1 = await recordTrustTier(tp.pool, DIGEST, "conformance-passed");
    expect(t1.trustTier).toBe("conformance-passed");

    const t2 = await recordTrustTier(tp.pool, DIGEST, "production-proven");
    expect(t2.trustTier).toBe("production-proven");

    const facts = await getPlacementFacts(tp.pool, DIGEST, "runQuery");
    expect(facts?.trustTier).toBe("production-proven");
  });

  it("throws FatalError(REGISTRY_TRUST_TIER_UNKNOWN_DIGEST) for an unregistered digest", async () => {
    let caught: unknown;
    try {
      await recordTrustTier(tp.pool, "sha256:unregistered", "production-proven");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FatalError);
    expect((caught as FatalError).errorId).toBe(ERROR_IDS.REGISTRY_TRUST_TIER_UNKNOWN_DIGEST);
  });

  it("throws FatalError(REGISTRY_TRUST_TIER_INVALID) for an invalid tier, before issuing any query", async () => {
    let caught: unknown;
    try {
      // @ts-expect-error - deliberately passing an invalid runtime value
      await recordTrustTier(tp.pool, DIGEST, "super-trusted");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FatalError);
    expect((caught as FatalError).errorId).toBe(ERROR_IDS.REGISTRY_TRUST_TIER_INVALID);

    const facts = await getPlacementFacts(tp.pool, DIGEST, "runQuery");
    expect(facts?.trustTier).toBe("unverified");
  });
});
