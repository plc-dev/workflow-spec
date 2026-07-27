import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withRegistryTransaction } from "../../../src/registry/database/transactions.js";
import type { TestPostgres } from "../../helpers/postgres.js";
import { resetRegistryTables, startRegistryPostgres } from "../../helpers/registry-postgres.js";
import { DIGEST, HARDWARE_REQUIREMENTS, OCI_REF, OPENAPI_SPEC } from "../fixtures.js";

// design.md D17b - a light-only capability (no heavy bindings, no state
// reuse), reused across this file's two test cases rather than repeating
// the full FunctionCapabilityInput shape twice.
const RUN_QUERY_CAPABILITY = {
  mutates: false,
  materializationCostClass: "negligible" as const,
  cowSupport: false,
  changeDetectionSupport: true,
  nestingDeclaration: null,
  invocationDescriptor: [],
  stateReuse: "none" as const,
  additiveWarmUpdate: false,
};

// docs/impl-plans/0008-shared-database-consolidation.md: withRegistryTransaction
// is a private module-internal helper (never exported from registry/
// index.ts), but is tested directly here anyway - it is the exact site of
// the robustness gap this package's own local review found (registry/'s
// first version was missing the tolerant-rollback/error-listener handling
// core/'s withTransaction already had) and the fix's actual regression
// test, so it needs the same crash-test seam core/database/
// transactions.test.ts already uses (repos.client, to fetch and kill the
// in-transaction connection's own backend pid).
describe("registry.withRegistryTransaction", () => {
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

  it("commits writes from both repos together on success", async () => {
    await withRegistryTransaction(tp.pool, async (repos) => {
      const image = await repos.serviceImages.upsert({
        digest: DIGEST,
        ociRef: OCI_REF,
        openapiSpec: OPENAPI_SPEC,
        hardwareRequirements: HARDWARE_REQUIREMENTS,
      });
      await repos.functionCapabilities.replaceForDigest(DIGEST, {
        runQuery: RUN_QUERY_CAPABILITY,
      });
      return image;
    });

    const imageCount = await tp.pool.query("SELECT count(*)::int AS c FROM service_images");
    const capabilityCount = await tp.pool.query(
      "SELECT count(*)::int AS c FROM function_capabilities WHERE digest = $1",
      [DIGEST],
    );
    expect(imageCount.rows[0]?.c).toBe(1);
    expect(capabilityCount.rows[0]?.c).toBe(1);
  });

  it("rolls back writes from both repos together when fn throws", async () => {
    await expect(
      withRegistryTransaction(tp.pool, async (repos) => {
        await repos.serviceImages.upsert({
          digest: DIGEST,
          ociRef: OCI_REF,
          openapiSpec: OPENAPI_SPEC,
          hardwareRequirements: HARDWARE_REQUIREMENTS,
        });
        await repos.functionCapabilities.replaceForDigest(DIGEST, {
          runQuery: RUN_QUERY_CAPABILITY,
        });
        throw new Error("simulated failure after both writes");
      }),
    ).rejects.toThrow("simulated failure after both writes");

    const imageCount = await tp.pool.query("SELECT count(*)::int AS c FROM service_images");
    expect(imageCount.rows[0]?.c).toBe(0);
  });

  // The actual regression test for this revision's fix: a mid-transaction
  // crash (pg_terminate_backend before COMMIT, same shape as
  // test/core/database/transactions.test.ts's/test/engine/claim-
  // complete.test.ts's own crash tests) must roll back cleanly - the
  // ROLLBACK issued against the now-dead connection must NOT throw in a
  // way that replaces/masks the original error, and the connection's
  // 'error' event must not surface as an unhandled rejection/exception
  // (which would fail this test file's own process, not just this one
  // assertion). Registry's FIRST version of this wrapper had neither
  // protection.
  it("rolls back cleanly on a mid-transaction crash, without masking the original error or throwing an unhandled 'error' event", async () => {
    await expect(
      withRegistryTransaction(tp.pool, async (repos) => {
        await repos.serviceImages.upsert({
          digest: DIGEST,
          ociRef: OCI_REF,
          openapiSpec: OPENAPI_SPEC,
          hardwareRequirements: HARDWARE_REQUIREMENTS,
        });

        const pidResult = await repos.client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = pidResult.rows[0]?.pid;
        await tp.adminPool.query("SELECT pg_terminate_backend($1)", [pid]);

        // The next query on this now-dead connection is what actually
        // surfaces the failure (matching the existing crash tests' shape).
        await repos.client.query("SELECT 1");
      }),
    ).rejects.toThrow();

    const imageCount = await tp.pool.query("SELECT count(*)::int AS c FROM service_images");
    expect(imageCount.rows[0]?.c).toBe(0);
  });
});
