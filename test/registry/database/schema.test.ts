import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MATERIALIZATION_COST_CLASSES, TRUST_TIERS } from "../../../src/registry/constants.js";
import type { TestPostgres } from "../../helpers/postgres.js";
import { startRegistryPostgres } from "../../helpers/registry-postgres.js";

// TC-1 (docs/impl-plans/0007-registry.md): applying registry/database/
// schema.sql fresh against a SEPARATE Postgres instance from core/'s
// produces the D12 ENTRY shape's structural preconditions.
describe("registry/schema.sql", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startRegistryPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  it("creates service_images and function_capabilities tables", async () => {
    const result = await tp.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN
         ('service_images', 'function_capabilities')
       ORDER BY table_name`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual([
      "function_capabilities",
      "service_images",
    ]);
  });

  it("defaults trust_tier to 'unverified' on insert", async () => {
    await tp.pool.query(
      "INSERT INTO service_images (digest, oci_ref, openapi_spec) VALUES ($1, $2, $3)",
      ["sha256:default-tier", "oci://example/img@sha256:default-tier", "{}"],
    );
    const result = await tp.pool.query<{ trust_tier: string }>(
      "SELECT trust_tier FROM service_images WHERE digest = $1",
      ["sha256:default-tier"],
    );
    expect(result.rows[0]?.trust_tier).toBe("unverified");
  });

  it("enforces service_images.trust_tier's CHECK constraint", async () => {
    await expect(
      tp.pool.query(
        `INSERT INTO service_images (digest, oci_ref, openapi_spec, trust_tier)
         VALUES ($1, $2, $3, $4)`,
        ["sha256:bad-tier", "oci://example/img@sha256:bad-tier", "{}", "super-trusted"],
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("enforces function_capabilities.materialization_cost_class's CHECK constraint", async () => {
    await tp.pool.query(
      "INSERT INTO service_images (digest, oci_ref, openapi_spec) VALUES ($1, $2, $3)",
      ["sha256:cost-class-check", "oci://example/img@sha256:cost-class-check", "{}"],
    );
    await expect(
      tp.pool.query(
        `INSERT INTO function_capabilities
           (digest, function_name, mutates, materialization_cost_class, cow_support, change_detection_support)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ["sha256:cost-class-check", "fn", false, "medium", false, false],
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  // Drift guard (local review finding): registry/constants.ts's
  // TRUST_TIERS/MATERIALIZATION_COST_CLASSES are the app-level source of
  // truth validate.ts checks input against, but the CHECK constraints
  // above are a second, independent copy of the same enums - nothing
  // TypeScript-checkable links them. If the two ever drift apart, a value
  // validate.ts accepts would fail mid-transaction on the DB's CHECK
  // constraint as an unmapped raw `pg` error instead of the intended
  // structured FatalError. These two tests pin the SQL side to the
  // TypeScript side directly, so that drift fails loudly here instead.
  it("accepts every registry/constants.ts TRUST_TIERS value in service_images.trust_tier", async () => {
    for (const tier of TRUST_TIERS) {
      await expect(
        tp.pool.query(
          "INSERT INTO service_images (digest, oci_ref, openapi_spec, trust_tier) VALUES ($1, $2, $3, $4)",
          [`sha256:tier-round-trip-${tier}`, "oci://example/img", "{}", tier],
        ),
      ).resolves.not.toThrow();
    }
  });

  it("accepts every registry/constants.ts MATERIALIZATION_COST_CLASSES value in function_capabilities.materialization_cost_class", async () => {
    await tp.pool.query(
      "INSERT INTO service_images (digest, oci_ref, openapi_spec) VALUES ($1, $2, $3)",
      ["sha256:cost-class-round-trip", "oci://example/img", "{}"],
    );
    for (const costClass of MATERIALIZATION_COST_CLASSES) {
      await expect(
        tp.pool.query(
          `INSERT INTO function_capabilities
             (digest, function_name, mutates, materialization_cost_class, cow_support, change_detection_support)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          ["sha256:cost-class-round-trip", `fn-${costClass}`, false, costClass, false, false],
        ),
      ).resolves.not.toThrow();
    }
  });

  it("cascades function_capabilities deletion when its service_images row is deleted", async () => {
    await tp.pool.query(
      "INSERT INTO service_images (digest, oci_ref, openapi_spec) VALUES ($1, $2, $3)",
      ["sha256:cascade-check", "oci://example/img@sha256:cascade-check", "{}"],
    );
    await tp.pool.query(
      `INSERT INTO function_capabilities
         (digest, function_name, mutates, materialization_cost_class, cow_support, change_detection_support)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["sha256:cascade-check", "fn", false, "negligible", false, false],
    );
    await tp.pool.query("DELETE FROM service_images WHERE digest = $1", ["sha256:cascade-check"]);
    const result = await tp.pool.query("SELECT * FROM function_capabilities WHERE digest = $1", [
      "sha256:cascade-check",
    ]);
    expect(result.rows).toHaveLength(0);
  });
});
