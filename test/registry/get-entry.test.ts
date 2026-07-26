import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEntry } from "../../src/registry/get-entry.js";
import { createFunctionCapabilitiesRepo } from "../../src/registry/repositories/function-capabilities.repository.js";
import { createServiceImagesRepo } from "../../src/registry/repositories/service-images.repository.js";
import { type TestPostgres, startTestPostgres } from "../helpers/postgres.js";
import {
  CAPABILITY_METADATA,
  DIGEST,
  HARDWARE_REQUIREMENTS,
  OCI_REF,
  OPENAPI_SPEC,
} from "./fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_SCHEMA_PATH = path.join(__dirname, "../../src/registry/database/schema.sql");

// TC-4/TC-5 (docs/impl-plans/0007-registry.md).
describe("getEntry", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres({ schemaPath: REGISTRY_SCHEMA_PATH });
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await tp.pool.query("TRUNCATE function_capabilities, service_images RESTART IDENTITY CASCADE");
  });

  it("returns null for an unregistered digest", async () => {
    expect(await getEntry(tp.pool, "sha256:never-registered")).toBeNull();
  });

  it("returns the full entry: oci_ref, sole openapi_spec contract, per-image hardware requirements, and per-function capability granularity", async () => {
    await createServiceImagesRepo(tp.pool).upsert({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    await createFunctionCapabilitiesRepo(tp.pool).replaceForDigest(DIGEST, CAPABILITY_METADATA);

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
