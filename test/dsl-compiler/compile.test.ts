import { describe, expect, it, vi } from "vitest";
import { compile } from "../../src/dsl-compiler/index.js";
import type { Queryable } from "../../src/shared/index.js";

// docs/impl-plans/0009-dsl-compiler-plain-steps.md, TC-5, TC-6, and TC-15's
// non-registry half. Pure - no real registry pool is ever reached in
// these cases (each fails at an earlier stage), so a mock `Queryable`
// whose call count is asserted stands in for a real one.

function mockRegistryPool(): Queryable {
  return { query: vi.fn() } as unknown as Queryable;
}

describe("compile()", () => {
  // TC-5
  it("skips the restricted-YAML step for non-string input and goes straight to schema validation", async () => {
    const registryPool = mockRegistryPool();
    // A plain JS object (not a string) with no `workflowSpecVersion` -
    // schema-invalid, but for a reason that could only be reached by
    // skipping the YAML-parse stage entirely (there is no YAML source to
    // parse here at all).
    const result = await compile({ name: "no-version", steps: [] }, { registryPool });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.every((e) => e.code === "schema_invalid")).toBe(true);
    expect(registryPool.query).not.toHaveBeenCalled();
  });

  // TC-6
  it("rejects a schema-invalid restricted-YAML document with schema_invalid, not restricted_yaml_violation", async () => {
    const registryPool = mockRegistryPool();
    const result = await compile("name: no-version\nsteps: []\n", { registryPool });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.every((e) => e.code === "schema_invalid")).toBe(true);
    expect(registryPool.query).not.toHaveBeenCalled();
  });

  it("rejects a restricted-YAML profile violation before ever reaching schema validation", async () => {
    const registryPool = mockRegistryPool();
    const result = await compile("a: &anchor 1\nb: *anchor\n", { registryPool });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.every((e) => e.code === "restricted_yaml_violation")).toBe(true);
    expect(registryPool.query).not.toHaveBeenCalled();
  });

  // TC-15 (semantic-error half): a document with a duplicate step id never
  // reaches the registry stage, even though its service/function
  // references would otherwise resolve fine.
  it("short-circuits on a semantic error before spending a registry round-trip", async () => {
    const registryPool = mockRegistryPool();
    const result = await compile(
      {
        workflowSpecVersion: 1,
        name: "dup",
        steps: [
          {
            id: "a",
            service: "svc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            function: "f",
          },
          {
            id: "a",
            service: "svc@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            function: "f",
          },
        ],
      },
      { registryPool },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.every((e) => e.code === "duplicate_step_id")).toBe(true);
    expect(registryPool.query).not.toHaveBeenCalled();
  });
});
