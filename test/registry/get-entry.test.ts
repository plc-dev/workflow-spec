import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEntry } from "../../src/registry/get-entry.js";
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

// TC-4/TC-5 (docs/impl-plans/0007-registry.md).
describe("getEntry", () => {
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

  it("returns null for an unregistered digest", async () => {
    expect(await getEntry(tp.pool, "sha256:never-registered")).toBeNull();
  });

  it("returns the full entry: oci_ref, sole openapi_spec contract, per-image hardware requirements, and per-function capability granularity", async () => {
    await seedFixtureImage(tp.pool, {
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      hardwareRequirements: HARDWARE_REQUIREMENTS,
      capabilityMetadata: CAPABILITY_METADATA,
    });

    const entry = await getEntry(tp.pool, DIGEST);

    expect(entry?.ociRef).toBe(OCI_REF);
    expect((entry?.openapiSpec as { info: { title: string } }).info.title).toBe("sql-service");
    expect(entry?.hardwareRequirements).toEqual(HARDWARE_REQUIREMENTS);
    expect(Object.keys(entry?.functions ?? {}).sort()).toEqual(["loadDump", "runQuery"]);
    expect(entry?.functions.runQuery?.mutates).toBe(false);
    expect(entry?.functions.loadDump?.mutates).toBe(true);
    expect(entry?.functions.loadDump?.materializationCostClass).toBe("heavy");
    expect(entry?.functions.loadDump?.nestingDeclaration).toEqual({ via: "http", targets: "open" });
    expect(entry?.functions.runQuery?.nestingDeclaration).toBeNull();
    expect(entry?.trustTier).toBe("unverified");
  });
});
