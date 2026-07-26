import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFunctionCapabilitiesRepo } from "../../../src/registry/repositories/function-capabilities.repository.js";
import type { TestPostgres } from "../../helpers/postgres.js";
import {
  resetRegistryTables,
  seedRegisteredImage,
  startRegistryPostgres,
} from "../../helpers/registry-postgres.js";
import {
  CAPABILITY_METADATA,
  DIGEST,
  HARDWARE_REQUIREMENTS,
  OCI_REF,
  OPENAPI_SPEC,
} from "../fixtures.js";

// TC-3 (docs/impl-plans/0007-registry.md): "replace the function rows for
// this digest" semantics, ported from archive/registry/src/admin.js.
describe("FunctionCapabilitiesRepo", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startRegistryPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await resetRegistryTables(tp.pool);
    await seedRegisteredImage(tp.pool, {
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
  });

  it("replaceForDigest entirely replaces a digest's function rows on a second call", async () => {
    const repo = createFunctionCapabilitiesRepo(tp.pool);
    await repo.replaceForDigest(DIGEST, CAPABILITY_METADATA);

    await repo.replaceForDigest(DIGEST, { runQuery: CAPABILITY_METADATA.runQuery });

    const rows = await repo.listByDigest(DIGEST);
    expect(rows.map((r) => r.functionName)).toEqual(["runQuery"]);
  });

  it("stores per-function nesting declarations and null for functions without one", async () => {
    const repo = createFunctionCapabilitiesRepo(tp.pool);
    await repo.replaceForDigest(DIGEST, CAPABILITY_METADATA);

    const rows = await repo.listByDigest(DIGEST);
    const loadDump = rows.find((r) => r.functionName === "loadDump");
    const runQuery = rows.find((r) => r.functionName === "runQuery");

    expect(loadDump?.nestingDeclaration).toEqual({ via: "http", targets: "open" });
    expect(runQuery?.nestingDeclaration).toBeNull();
  });

  it("listByDigest returns an empty array for a digest with no capability rows", async () => {
    const repo = createFunctionCapabilitiesRepo(tp.pool);
    expect(await repo.listByDigest(DIGEST)).toEqual([]);
  });
});
