import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validate } from "../../src/workflow-spec/index.js";

// Pure module - no database, no I/O beyond loading these fixture files
// (docs/impl-plans/0004-ir-schema.md's Test design: default Vitest is
// sufficient, testcontainers-node is not needed at all).

const VALID_DIR = fileURLToPath(new URL("./fixtures/valid/", import.meta.url));
const INVALID_DIR = fileURLToPath(new URL("./fixtures/invalid/", import.meta.url));

function loadFixture(dir: string, filename: string): unknown {
  return JSON.parse(readFileSync(new URL(filename, `file://${dir}`), "utf-8"));
}

// TC-1 (in substance) + a whole-document regression suite ported and
// extended from archive/dsl/schema/examples/ (task 1.7's own deliverable).
describe("validate() - whole-document fixtures", () => {
  const validFiles = readdirSync(VALID_DIR).sort();
  const invalidFiles = readdirSync(INVALID_DIR).sort();

  it("found the expected fixture files", () => {
    // Guards against a typo silently making describe.each iterate zero
    // fixtures and reporting a false "all tests passed".
    expect(validFiles.length).toBeGreaterThanOrEqual(6);
    expect(invalidFiles.length).toBeGreaterThanOrEqual(5);
  });

  for (const filename of validFiles) {
    it(`accepts ${filename}`, () => {
      const doc = loadFixture(VALID_DIR, filename);
      const result = validate(doc);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }

  for (const filename of invalidFiles) {
    it(`rejects ${filename}`, () => {
      const doc = loadFixture(INVALID_DIR, filename);
      const result = validate(doc);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  }
});

// TC-2: required top-level fields.
describe("validate() - TC-2 required top-level fields", () => {
  it("rejects a doc missing workflowSpecVersion", () => {
    const result = validate({ name: "x", steps: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("workflowSpecVersion"))).toBe(true);
  });

  it("rejects a doc missing name", () => {
    const result = validate({ workflowSpecVersion: 1, steps: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("name"))).toBe(true);
  });

  it("rejects a doc missing steps", () => {
    const result = validate({ workflowSpecVersion: 1, name: "x" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("steps"))).toBe(true);
  });
});

function stepReading(readsBinding: unknown): unknown {
  return {
    workflowSpecVersion: 1,
    name: "binding-probe",
    steps: [
      {
        id: "s1",
        service: `registry.internal/svc@sha256:${"a".repeat(64)}`,
        function: "f",
        reads: { probe: readsBinding },
      },
    ],
  };
}

// TC-3: each Binding kind individually, well-formed.
describe("validate() - TC-3 each Binding kind validates", () => {
  it.each<[string, unknown]>([
    ["static", { from: "static", ref: "urn:workflow-platform:dataset:ns/name:v1" }],
    ["session", { from: "session", key: "k" }],
    ["request", { from: "request", param: "p" }],
    ["step", { from: "step", id: "other", output: "o" }],
    ["item", { from: "item" }],
    ["literal", { literal: { any: ["json", "value", null, 1] } }],
    ["compute", { compute: { "==": [1, 1] }, using: { a: { from: "item" } } }],
    [
      "itemResource",
      { from: "itemResource", itemId: { from: "request", param: "itemInstanceId" }, path: "/a/b" },
    ],
  ])("%s", (_kind, binding) => {
    const result = validate(stepReading(binding));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

// TC-4: itemResource.path's provisional JSON-Pointer grammar.
describe("validate() - TC-4 itemResource path grammar", () => {
  it("accepts the empty pointer", () => {
    const binding = { from: "itemResource", itemId: { from: "item" }, path: "" };
    expect(validate(stepReading(binding)).valid).toBe(true);
  });

  it("accepts a multi-segment pointer with ~0/~1 escaping", () => {
    const binding = {
      from: "itemResource",
      itemId: { from: "item" },
      path: "/resources/a~1b/c~0d",
    };
    expect(validate(stepReading(binding)).valid).toBe(true);
  });

  it("rejects a dotted path with no leading slash", () => {
    const binding = { from: "itemResource", itemId: { from: "item" }, path: "resources.dump" };
    expect(validate(stepReading(binding)).valid).toBe(false);
  });
});

// TC-5: request bindings stay flat (D8a).
describe("validate() - TC-5 request binding flatness", () => {
  it("accepts a flat param name", () => {
    expect(validate(stepReading({ from: "request", param: "query" })).valid).toBe(true);
  });

  it("rejects a dotted param path", () => {
    expect(validate(stepReading({ from: "request", param: "body.query" })).valid).toBe(false);
  });
});

// TC-6: dataset URN scheme (D8a).
describe("validate() - TC-6 dataset URN scheme", () => {
  it("accepts a tag-form URN", () => {
    const binding = { from: "static", ref: "urn:workflow-platform:dataset:team/name:v1" };
    expect(validate(stepReading(binding)).valid).toBe(true);
  });

  it("accepts a digest-form URN", () => {
    const binding = {
      from: "static",
      ref: "urn:workflow-platform:dataset:team/name@sha256:abcd1234",
    };
    expect(validate(stepReading(binding)).valid).toBe(true);
  });

  it("rejects a non-URN string", () => {
    const binding = { from: "static", ref: "not-a-urn" };
    expect(validate(stepReading(binding)).valid).toBe(false);
  });
});

// TC-7: a step's service reference is always digest-pinned (D8c).
describe("validate() - TC-7 digest-pinned service refs", () => {
  it("accepts a digest-pinned service", () => {
    const doc = {
      workflowSpecVersion: 1,
      name: "x",
      steps: [{ id: "s1", service: `r@sha256:${"a".repeat(64)}`, function: "f" }],
    };
    expect(validate(doc).valid).toBe(true);
  });

  it("rejects a bare-tag service reference", () => {
    const doc = {
      workflowSpecVersion: 1,
      name: "x",
      steps: [{ id: "s1", service: "r:v1", function: "f" }],
    };
    expect(validate(doc).valid).toBe(false);
  });
});

// TC-8: secrets are a category separate from Binding (D8c/D10).
describe("validate() - TC-8 secrets excluded from Binding", () => {
  it("accepts a well-formed secrets block on a step", () => {
    const doc = {
      workflowSpecVersion: 1,
      name: "x",
      steps: [
        {
          id: "s1",
          service: `r@sha256:${"a".repeat(64)}`,
          function: "f",
          secrets: { apiKey: { scope: "writer", name: "n" } },
        },
      ],
    };
    expect(validate(doc).valid).toBe(true);
  });

  it("rejects a SecretRef-shaped value used as a compute-binding using input", () => {
    const binding = {
      compute: { "==": [1, 1] },
      using: { a: { scope: "writer", name: "n" } },
    };
    expect(validate(stepReading(binding)).valid).toBe(false);
  });
});

// TC-9: branch cases (D8c).
describe("validate() - TC-9 branch cases", () => {
  function branchDoc(cases: unknown): unknown {
    return {
      workflowSpecVersion: 1,
      name: "x",
      steps: [
        {
          id: "b1",
          kind: "branch",
          selector: { from: "item" },
          cases,
        },
      ],
    };
  }

  it("accepts true/false/default keyed cases with yields", () => {
    const step = { id: "s", service: `r@sha256:${"a".repeat(64)}`, function: "f" };
    const cases = {
      true: { steps: [step], yields: { r: { from: "step", id: "s", output: "o" } } },
      false: { steps: [step], yields: { r: { from: "step", id: "s", output: "o" } } },
      default: { steps: [step], yields: { r: { from: "step", id: "s", output: "o" } } },
    };
    expect(validate(branchDoc(cases)).valid).toBe(true);
  });

  it("rejects an empty cases map", () => {
    expect(validate(branchDoc({})).valid).toBe(false);
  });
});

// TC-10: map body (D8c).
describe("validate() - TC-10 map body", () => {
  function mapDoc(body: unknown): unknown {
    return {
      workflowSpecVersion: 1,
      name: "x",
      steps: [{ id: "m1", kind: "map", source: { from: "item" }, body }],
    };
  }

  it("accepts a non-empty body with yields", () => {
    const body = [{ id: "s", service: `r@sha256:${"a".repeat(64)}`, function: "f" }];
    expect(validate(mapDoc(body)).valid).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(validate(mapDoc([])).valid).toBe(false);
  });
});

// TC-11: unrestricted branch/map nesting depth (D8d).
describe("validate() - TC-11 nested branch/map", () => {
  it("accepts a branch case containing a map whose body contains a branch", () => {
    const innerStep = { id: "leaf", service: `r@sha256:${"a".repeat(64)}`, function: "f" };
    const innerBranch = {
      id: "innerBranch",
      kind: "branch",
      selector: { from: "item" },
      cases: { default: { steps: [innerStep] } },
    };
    const map = {
      id: "innerMap",
      kind: "map",
      source: { from: "item" },
      body: [innerBranch],
    };
    const doc = {
      workflowSpecVersion: 1,
      name: "x",
      steps: [
        {
          id: "outerBranch",
          kind: "branch",
          selector: { from: "item" },
          cases: { default: { steps: [map] } },
        },
      ],
    };
    expect(validate(doc).valid).toBe(true);
  });
});

// TC-12: sessionState declarations (D8a).
describe("validate() - TC-12 sessionState", () => {
  it("accepts interactive-with-fallback and batch-without-fallback keys", () => {
    const doc = {
      workflowSpecVersion: 1,
      name: "x",
      sessionState: {
        a: { interactivity: "interactive", fallback: { from: "item" } },
        b: { interactivity: "batch" },
      },
      steps: [{ id: "s", service: `r@sha256:${"a".repeat(64)}`, function: "f" }],
    };
    expect(validate(doc).valid).toBe(true);
  });

  it("rejects a sessionState key missing interactivity", () => {
    const doc = {
      workflowSpecVersion: 1,
      name: "x",
      sessionState: { a: { fallback: { from: "item" } } },
      steps: [{ id: "s", service: `r@sha256:${"a".repeat(64)}`, function: "f" }],
    };
    expect(validate(doc).valid).toBe(false);
  });
});

// TC-13: additionalProperties: false throughout.
describe("validate() - TC-13 additionalProperties: false", () => {
  it("rejects an unrecognized top-level property", () => {
    const doc = { workflowSpecVersion: 1, name: "x", steps: [], foo: 1 };
    expect(validate(doc).valid).toBe(false);
  });

  it("rejects a Binding with an extra unrecognized property", () => {
    const binding = { from: "item", extra: true };
    expect(validate(stepReading(binding)).valid).toBe(false);
  });
});

// TC-14: validate() never throws; returns a structured, non-empty error.
describe("validate() - TC-14 never throws", () => {
  it("returns { valid: false, errors } with a non-empty path and message", () => {
    let result: ReturnType<typeof validate> | undefined;
    expect(() => {
      result = validate({ not: "a workflow spec" });
    }).not.toThrow();
    expect(result?.valid).toBe(false);
    expect(result?.errors.length).toBeGreaterThan(0);
    expect(typeof result?.errors[0]?.path).toBe("string");
    expect(result?.errors[0]?.message.length).toBeGreaterThan(0);
  });

  it("does not throw on wildly malformed input (null, array, primitive)", () => {
    for (const doc of [null, [], 42, "x", undefined]) {
      expect(() => validate(doc)).not.toThrow();
    }
  });

  // Post-review fix: the Binding schema is recursive (compute.using and
  // itemResource.itemId both recurse into #/$defs/binding) - an
  // adversarially deep-but-small document previously blew ajv's generated
  // recursive validator's call stack, surfacing as an uncaught
  // RangeError instead of an ordinary validation failure.
  it("does not throw on an adversarially deep binding-nesting chain - returns invalid instead", () => {
    let binding: unknown = { from: "item" };
    for (let i = 0; i < 5000; i++) {
      binding = { compute: {}, using: { a: binding } };
    }
    let result: ReturnType<typeof validate> | undefined;
    expect(() => {
      result = validate(stepReading(binding));
    }).not.toThrow();
    expect(result?.valid).toBe(false);
    expect(result?.errors.length).toBeGreaterThan(0);
  });
});
