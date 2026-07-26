import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceImagesRepo } from "../../../src/registry/repositories/service-images.repository.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";
import { DIGEST, HARDWARE_REQUIREMENTS, OCI_REF, OPENAPI_SPEC } from "../fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_SCHEMA_PATH = path.join(__dirname, "../../../src/registry/database/schema.sql");

// TC-2 (docs/impl-plans/0007-registry.md): D5a's "register never touches
// trust" rule, verified in both directions.
describe("ServiceImagesRepo", () => {
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

  it("upsert on a new digest inserts with trust_tier='unverified'", async () => {
    const repo = createServiceImagesRepo(tp.pool);
    const image = await repo.upsert({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(image.trustTier).toBe("unverified");
    expect(image.ociRef).toBe(OCI_REF);
  });

  it("a second upsert updates content fields but leaves an already-promoted trust_tier untouched", async () => {
    const repo = createServiceImagesRepo(tp.pool);
    await repo.upsert({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    await repo.updateTrustTier(DIGEST, "production-proven");

    const newOciRef = `${OCI_REF}-redeployed`;
    const updated = await repo.upsert({
      digest: DIGEST,
      ociRef: newOciRef,
      openapiSpec: OPENAPI_SPEC,
      hardwareRequirements: { cpu: "8" },
    });

    expect(updated.ociRef).toBe(newOciRef);
    expect(updated.hardwareRequirements).toEqual({ cpu: "8" });
    expect(updated.trustTier).toBe("production-proven");
  });

  it("findByDigest returns null for an unregistered digest", async () => {
    const repo = createServiceImagesRepo(tp.pool);
    expect(await repo.findByDigest("sha256:never-registered")).toBeNull();
  });

  it("updateTrustTier returns null for an unregistered digest", async () => {
    const repo = createServiceImagesRepo(tp.pool);
    expect(await repo.updateTrustTier("sha256:never-registered", "conformance-passed")).toBeNull();
  });
});
