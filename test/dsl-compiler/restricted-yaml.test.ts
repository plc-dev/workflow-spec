import { describe, expect, it } from "vitest";
import { parseRestrictedYaml } from "../../src/dsl-compiler/index.js";

// docs/impl-plans/0009-dsl-compiler-plain-steps.md, TC-1..TC-4. Pure
// module, no I/O - plain Vitest.

describe("parseRestrictedYaml() - D8a restricted profile", () => {
  // TC-1
  it("rejects an anchor/alias pair", () => {
    const result = parseRestrictedYaml("a: &anchor 1\nb: *anchor\n");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((e) => e.code === "restricted_yaml_violation")).toBe(true);
    expect(result.errors.some((e) => e.message.includes("anchor"))).toBe(true);
    expect(result.errors.some((e) => e.message.includes("alias"))).toBe(true);
  });

  // TC-2
  it("rejects a merge key", () => {
    const result = parseRestrictedYaml("base:\n  x: 1\nc:\n  <<: {d: 1}\n");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.some((e) => e.message.includes("merge key"))).toBe(true);
  });

  // TC-3
  it("rejects a custom tag", () => {
    const result = parseRestrictedYaml("e: !myTag foo\n");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.some((e) => e.message.includes("custom tag"))).toBe(true);
  });

  // TC-4
  it("accepts an ordinary restricted-YAML document with no anchors/aliases/tags", () => {
    const result = parseRestrictedYaml("name: foo\nsteps:\n  - id: a\n    x: 1\n");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.doc).toEqual({ name: "foo", steps: [{ id: "a", x: 1 }] });
  });

  it("reports a plain YAML syntax error the same way, without throwing", () => {
    const result = parseRestrictedYaml("a: [1, 2\n");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
