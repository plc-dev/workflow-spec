import { describe, expect, it } from "vitest";
import { collectStepBindingIds, computeStepDependencies } from "../../src/engine/index.js";
import type { Step } from "../../src/ir/index.js";

// TC-8 (docs/impl-plans/0006-interpreter-plain-steps.md): dependency
// inference is a pure, generic walk (design.md D8a's `dependsOn` escape
// hatch UNIONed with every `{from:"step"}` reference found, however
// deeply nested), independent of whether that binding kind is
// resolvable yet by engine/bindings.ts.
describe("engine.computeStepDependencies / collectStepBindingIds", () => {
  it("returns [] for a binding with no step reference", () => {
    expect(collectStepBindingIds({ from: "request", param: "x" })).toEqual([]);
    expect(collectStepBindingIds({ literal: 42 })).toEqual([]);
  });

  it("returns the step id for a direct StepBinding", () => {
    expect(collectStepBindingIds({ from: "step", id: "A", output: "x" })).toEqual(["A"]);
  });

  it("finds a StepBinding nested inside a compute binding's `using` map", () => {
    const ids = collectStepBindingIds({
      compute: { ">": [{ var: "y" }, 0] },
      using: { y: { from: "step", id: "Y", output: "value" } },
    });
    expect(ids).toEqual(["Y"]);
  });

  // Local-review fix (docs/impl-plans/0006-interpreter-plain-steps.md's
  // review pass): itemId is itself a Binding and was previously not
  // walked, silently dropping the dependency it might carry.
  it("finds a StepBinding nested inside an itemResource binding's itemId", () => {
    const ids = collectStepBindingIds({
      from: "itemResource",
      itemId: { from: "step", id: "Z", output: "id" },
      path: "/a/b",
    });
    expect(ids).toEqual(["Z"]);
  });

  it("returns [] for an itemResource binding whose itemId carries no step reference", () => {
    const ids = collectStepBindingIds({
      from: "itemResource",
      itemId: { literal: "fixed-id" },
      path: "/a/b",
    });
    expect(ids).toEqual([]);
  });

  it("unions dependsOn with every reads binding's step reference, deduplicated", () => {
    const step: Step = {
      id: "C",
      service: "svc@sha256:abc",
      function: "run",
      dependsOn: ["X"],
      reads: {
        a: { from: "step", id: "Y", output: "out" },
        // Deliberately references X again via a nested compute binding -
        // proves deduplication, not just union.
        b: { compute: { "==": [1, 1] }, using: { z: { from: "step", id: "X", output: "out" } } },
      },
    };

    expect(new Set(computeStepDependencies(step))).toEqual(new Set(["X", "Y"]));
  });

  it("returns [] for a step with neither dependsOn nor a step-referencing read", () => {
    const step: Step = { id: "A", service: "svc@sha256:abc", function: "run" };
    expect(computeStepDependencies(step)).toEqual([]);
  });
});
