import { describe, expect, it } from "vitest";
import type {
  Binding,
  ComputeBinding,
  ItemBinding,
  ItemResourceBinding,
  LiteralBinding,
  RequestBinding,
  SecretRef,
  SessionBinding,
  SessionStateDeclaration,
  SessionWriteTarget,
  StaticBinding,
  Step,
  StepBinding,
  WorkflowSpec,
} from "../../src/ir/index.js";

// This file has no correctness property of its own beyond "this compiles"
// (docs/impl-plans/0004-ir-schema.md's Test design) - TypeScript's
// structural typing means the domain types have no runtime behavior.
// Exercising each Binding kind in a realistic composed WorkflowSpec means
// a future refactor that silently narrows a type incorrectly is caught by
// `tsc --noEmit`, not left undiscovered until some other package's code
// fails to compile against it.

describe("ir domain types", () => {
  it("composes a WorkflowSpec exercising every Binding kind", () => {
    const staticBinding: StaticBinding = {
      from: "static",
      ref: "urn:workflow-platform:dataset:ns/name:v1",
    };
    const sessionBinding: SessionBinding = { from: "session", key: "k" };
    const requestBinding: RequestBinding = { from: "request", param: "p" };
    const stepBinding: StepBinding = { from: "step", id: "other", output: "o" };
    const itemBinding: ItemBinding = { from: "item" };
    const literalBinding: LiteralBinding = { literal: { nested: [1, 2, 3] } };
    const computeBinding: ComputeBinding = {
      compute: { "==": [{ var: "a" }, 1] },
      using: { a: itemBinding },
    };
    const itemResourceBinding: ItemResourceBinding = {
      from: "itemResource",
      itemId: requestBinding,
      path: "/resources/dump",
    };

    const secretRef: SecretRef = { scope: "writer", name: "apiKey" };
    const writeTarget: SessionWriteTarget = { to: "session", key: "k" };
    const sessionStateDecl: SessionStateDeclaration = {
      interactivity: "interactive",
      fallback: staticBinding,
    };

    const step: Step = {
      id: "s1",
      service: `registry.internal/svc@sha256:${"a".repeat(64)}`,
      function: "f",
      dependsOn: ["s0"],
      reads: {
        a: staticBinding,
        b: sessionBinding,
        c: requestBinding,
        d: stepBinding,
        e: itemBinding,
        f: literalBinding,
        g: computeBinding,
        h: itemResourceBinding,
      },
      writes: { a: writeTarget },
      secrets: { apiKey: secretRef },
    };

    const outputBinding: Binding = stepBinding;

    const spec: WorkflowSpec = {
      irVersion: 1,
      name: "compile-check",
      sessionState: { k: sessionStateDecl },
      steps: [step],
      outputs: { result: outputBinding },
    };

    expect(spec.steps).toHaveLength(1);
    expect(spec.steps[0]).toBe(step);
  });
});
