import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerImage } from "../../src/registry/admin.js";
import { getEntry } from "../../src/registry/get-entry.js";
import { ERROR_IDS, FatalError } from "../../src/shared/index.js";
import type { TestPostgres } from "../helpers/postgres.js";
import { resetRegistryTables, startRegistryPostgres } from "../helpers/registry-postgres.js";
import {
  CAPABILITY_METADATA,
  DIGEST,
  HARDWARE_REQUIREMENTS,
  OCI_REF,
  OPENAPI_SPEC,
} from "./fixtures.js";

// TC-4/TC-10 (docs/impl-plans/0007-registry.md).
describe("registerImage", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startRegistryPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await resetRegistryTables(tp.pool);
  });

  it("stores a full entry (openapi_spec, oci_ref, per-function capability metadata, hardware requirements) defaulting to unverified", async () => {
    const result = await registerImage(tp.pool, {
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: CAPABILITY_METADATA,
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });

    expect(result).toEqual({ digest: DIGEST, trustTier: "unverified" });

    const entry = await getEntry(tp.pool, DIGEST);
    expect(entry?.functions.loadDump?.cowSupport).toBe(true);
    expect(entry?.functions.runQuery?.mutates).toBe(false);
  });

  it("throws FatalError(REGISTRY_VALIDATION_FAILED) on a payload with capability metadata referencing an undeclared function, with no partial write", async () => {
    let caught: unknown;
    try {
      await registerImage(tp.pool, {
        digest: "sha256:bad",
        ociRef: OCI_REF,
        openapiSpec: OPENAPI_SPEC,
        capabilityMetadata: {
          ghostFn: {
            mutates: false,
            materializationCostClass: "negligible",
            cowSupport: false,
            changeDetectionSupport: false,
            nestingDeclaration: null,
          },
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FatalError);
    expect((caught as FatalError).errorId).toBe(ERROR_IDS.REGISTRY_VALIDATION_FAILED);
    expect(await getEntry(tp.pool, "sha256:bad")).toBeNull();
  });
});
