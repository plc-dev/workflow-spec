import { describe, expect, it } from "vitest";
import { resolveBinding } from "../../src/engine/index.js";
import { ERROR_IDS, FatalError } from "../../src/shared/index.js";

// TC-5 (docs/impl-plans/0006-interpreter-plain-steps.md): resolveBinding
// supports request/step/literal only; every other binding kind throws a
// clear FatalError rather than resolving to undefined (mirrors spike
// 1.5's own "the unbound binding path throws loudly" finding).
describe("engine.resolveBinding", () => {
  const ctx = { input: { name: "alice" }, nodeOutputs: { A: { total: 42 } } };

  it("resolves a request binding from ctx.input", () => {
    expect(resolveBinding({ from: "request", param: "name" }, ctx)).toBe("alice");
  });

  it("resolves a step binding from ctx.nodeOutputs", () => {
    expect(resolveBinding({ from: "step", id: "A", output: "total" }, ctx)).toBe(42);
  });

  it("resolves a literal binding to its own value, opaquely", () => {
    expect(resolveBinding({ literal: { nested: [1, 2, 3] } }, ctx)).toEqual({ nested: [1, 2, 3] });
  });

  it("throws ENGINE_NODE_OUTPUT_MISSING for a step binding referencing an unrecorded dependency", () => {
    expect(() => resolveBinding({ from: "step", id: "does-not-exist", output: "x" }, ctx)).toThrow(
      expect.objectContaining({ errorId: ERROR_IDS.ENGINE_NODE_OUTPUT_MISSING }),
    );
  });

  it.each([
    ["session", { from: "session" as const, key: "k" }],
    ["static", { from: "static" as const, ref: "urn:x" }],
    ["item", { from: "item" as const }],
    ["itemResource", { from: "itemResource" as const, itemId: { literal: "i" }, path: "/a" }],
    ["compute", { compute: { "==": [1, 1] } }],
  ])("throws ENGINE_BINDING_KIND_NOT_SUPPORTED for a %s binding", (_kind, binding) => {
    expect(() => resolveBinding(binding, ctx)).toThrow(FatalError);
    try {
      resolveBinding(binding, ctx);
      throw new Error("expected resolveBinding to throw");
    } catch (err) {
      expect((err as FatalError).errorId).toBe(ERROR_IDS.ENGINE_BINDING_KIND_NOT_SUPPORTED);
    }
  });
});
