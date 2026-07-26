import { describe, expect, it } from "vitest";
import { validateStepReferences } from "../../src/dsl-compiler/index.js";
import type { WorkflowSpec } from "../../src/workflow-spec/index.js";

// docs/impl-plans/0009-dsl-compiler-plain-steps.md, TC-7..TC-11. Pure
// module, no I/O - plain Vitest.

const BASE: Pick<WorkflowSpec, "workflowSpecVersion" | "name"> = {
  workflowSpecVersion: 1,
  name: "semantic-validation-fixture",
};

describe("validateStepReferences() - D8c document-wide id namespace", () => {
  // TC-7
  it("rejects a step id reused inside a branch case (duplicate_step_id)", () => {
    const spec: WorkflowSpec = {
      ...BASE,
      steps: [
        { id: "a", service: "svc@sha256:aaa", function: "f" },
        {
          id: "branch1",
          kind: "branch",
          selector: { literal: "x" },
          cases: {
            x: { steps: [{ id: "a", service: "svc@sha256:bbb", function: "f" }] },
          },
        },
      ],
    };
    const errors = validateStepReferences(spec);
    expect(errors).toEqual([expect.objectContaining({ code: "duplicate_step_id", path: "a" })]);
  });

  // TC-8
  it("rejects a dependsOn entry naming a nonexistent step id (unresolved_step_reference)", () => {
    const spec: WorkflowSpec = {
      ...BASE,
      steps: [{ id: "a", service: "svc@sha256:aaa", function: "f", dependsOn: ["ghost"] }],
    };
    const errors = validateStepReferences(spec);
    expect(errors).toEqual([
      expect.objectContaining({ code: "unresolved_step_reference", path: "a" }),
    ]);
  });

  // TC-9
  it("rejects a {from:step} binding naming a nonexistent step id (unresolved_step_reference)", () => {
    const spec: WorkflowSpec = {
      ...BASE,
      steps: [
        {
          id: "a",
          service: "svc@sha256:aaa",
          function: "f",
          reads: { x: { from: "step", id: "ghost", output: "value" } },
        },
      ],
    };
    const errors = validateStepReferences(spec);
    expect(errors).toEqual([
      expect.objectContaining({ code: "unresolved_step_reference", path: "a" }),
    ]);
  });

  // TC-10
  it("rejects a reference from outside a branch case into that case's internal step id (internal_step_id_referenced_externally)", () => {
    const spec: WorkflowSpec = {
      ...BASE,
      steps: [
        {
          id: "branch1",
          kind: "branch",
          selector: { literal: "x" },
          cases: {
            x: { steps: [{ id: "inner", service: "svc@sha256:aaa", function: "f" }] },
          },
        },
        {
          id: "outside",
          service: "svc@sha256:bbb",
          function: "f",
          dependsOn: ["inner"],
        },
      ],
    };
    const errors = validateStepReferences(spec);
    expect(errors).toEqual([
      expect.objectContaining({
        code: "internal_step_id_referenced_externally",
        path: "outside",
      }),
    ]);
  });

  // TC-11
  it("accepts a reference between two sibling steps inside the SAME map body", () => {
    const spec: WorkflowSpec = {
      ...BASE,
      steps: [
        {
          id: "map1",
          kind: "map",
          source: { from: "request", param: "items" },
          body: [
            { id: "first", service: "svc@sha256:aaa", function: "f" },
            {
              id: "second",
              service: "svc@sha256:bbb",
              function: "f",
              reads: { x: { from: "step", id: "first", output: "value" } },
            },
          ],
        },
      ],
    };
    const errors = validateStepReferences(spec);
    expect(errors).toEqual([]);
  });

  it("accepts a reference from inside a branch case UP to a top-level step (referencing outward is always allowed)", () => {
    const spec: WorkflowSpec = {
      ...BASE,
      steps: [
        { id: "top", service: "svc@sha256:aaa", function: "f" },
        {
          id: "branch1",
          kind: "branch",
          selector: { literal: "x" },
          cases: {
            x: {
              steps: [
                {
                  id: "inner",
                  service: "svc@sha256:bbb",
                  function: "f",
                  reads: { x: { from: "step", id: "top", output: "value" } },
                },
              ],
            },
          },
        },
      ],
    };
    const errors = validateStepReferences(spec);
    expect(errors).toEqual([]);
  });

  // Local-review regression: `sessionState`'s per-key `fallback` (D8a) is
  // a full Binding, previously unwalked - a {from:"step",...} reference
  // there escaped this check entirely.
  it("rejects a sessionState fallback binding naming a nonexistent step id", () => {
    const spec: WorkflowSpec = {
      ...BASE,
      steps: [{ id: "a", service: "svc@sha256:aaa", function: "f" }],
      sessionState: {
        sandbox: {
          interactivity: "interactive",
          fallback: { from: "step", id: "ghost", output: "value" },
        },
      },
    };
    const errors = validateStepReferences(spec);
    expect(errors).toEqual([
      expect.objectContaining({ code: "unresolved_step_reference", path: "sandbox" }),
    ]);
  });

  // Same regression, the internal-id-visibility half: a document-level
  // fallback must not be able to reach into a branch case's internal ids.
  it("rejects a sessionState fallback binding reaching into a branch case's internal step id", () => {
    const spec: WorkflowSpec = {
      ...BASE,
      steps: [
        {
          id: "branch1",
          kind: "branch",
          selector: { literal: "x" },
          cases: {
            x: { steps: [{ id: "inner", service: "svc@sha256:aaa", function: "f" }] },
          },
        },
      ],
      sessionState: {
        sandbox: {
          interactivity: "interactive",
          fallback: { from: "step", id: "inner", output: "value" },
        },
      },
    };
    const errors = validateStepReferences(spec);
    expect(errors).toEqual([
      expect.objectContaining({
        code: "internal_step_id_referenced_externally",
        path: "sandbox",
      }),
    ]);
  });
});
