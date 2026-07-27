import { describe, expect, it, vi } from "vitest";
import {
  buildInvokeRequest,
  dispatchStep,
  translateArgsToInvokeArgs,
} from "../../../src/apps/worker/dispatch.js";
import { ERROR_IDS } from "../../../src/shared/index.js";
import type { Step } from "../../../src/workflow-spec/index.js";

// T1 (docs/impl-plans/0011-worker-cli-dispatch.md): the args-translation
// rule - resolveStepReads (engine/, light bindings only) returns plain JS
// values; the agent's Args field is Record<string, string>.
describe("translateArgsToInvokeArgs", () => {
  it("passes a string value through unchanged", () => {
    expect(translateArgsToInvokeArgs({ name: "alice" })).toEqual({ name: "alice" });
  });

  it("stringifies a number", () => {
    expect(translateArgsToInvokeArgs({ amount: 10 })).toEqual({ amount: "10" });
  });

  it("stringifies a boolean", () => {
    expect(translateArgsToInvokeArgs({ dryRun: true })).toEqual({ dryRun: "true" });
  });

  it("JSON.stringifies an object", () => {
    expect(translateArgsToInvokeArgs({ payload: { a: 1 } })).toEqual({ payload: '{"a":1}' });
  });

  it("JSON.stringifies an array", () => {
    expect(translateArgsToInvokeArgs({ items: [1, 2, 3] })).toEqual({ items: "[1,2,3]" });
  });

  it("JSON.stringifies null", () => {
    expect(translateArgsToInvokeArgs({ value: null })).toEqual({ value: "null" });
  });

  it('omits a key whose resolved value is undefined, rather than sending the string "undefined"', () => {
    expect(translateArgsToInvokeArgs({ missing: undefined, present: "x" })).toEqual({
      present: "x",
    });
  });
});

// T2: mirrors agent/internal/execrunner/execrunner.go's own
// ^[a-zA-Z][a-zA-Z0-9-]*$ flag-name constraint (ADR-0008) - failing on
// this side with a clear error instead of the agent's opaque 400.
describe("translateArgsToInvokeArgs - flag-name validation", () => {
  it.each(["foo", "fooBar", "foo-bar", "a"])("accepts a valid flag name %s", (key) => {
    expect(() => translateArgsToInvokeArgs({ [key]: "v" })).not.toThrow();
  });

  it.each(["1abc", "foo.bar", "foo bar", "foo_bar", ""])(
    "rejects an invalid flag name %s with FatalError WORKER_INVALID_ARG_FLAG_NAME",
    (key) => {
      expect(() => translateArgsToInvokeArgs({ [key]: "v" })).toThrow(
        expect.objectContaining({ errorId: ERROR_IDS.WORKER_INVALID_ARG_FLAG_NAME }),
      );
    },
  );
});

// Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md):
// execrunner.go appends "--<flagName>" and the value as two SEPARATE
// argv tokens - a value that itself looks like a flag would be parsed by
// the wrapped CLI as an unrelated flag, not this binding's value.
describe("translateArgsToInvokeArgs - arg-value injection guard", () => {
  it.each(["-x", "--evil-flag", "-"])(
    "rejects a resolved value %s that starts with '-' with FatalError WORKER_UNSAFE_ARG_VALUE",
    (value) => {
      expect(() => translateArgsToInvokeArgs({ foo: value })).toThrow(
        expect.objectContaining({ errorId: ERROR_IDS.WORKER_UNSAFE_ARG_VALUE }),
      );
    },
  );

  it("rejects a negative number, since it stringifies to a value starting with '-'", () => {
    expect(() => translateArgsToInvokeArgs({ foo: -5 })).toThrow(
      expect.objectContaining({ errorId: ERROR_IDS.WORKER_UNSAFE_ARG_VALUE }),
    );
  });

  it("accepts a value that merely contains a hyphen without leading it", () => {
    expect(translateArgsToInvokeArgs({ foo: "well-formed" })).toEqual({ foo: "well-formed" });
  });
});

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: "stepA",
    service: "svc@sha256:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    function: "f",
    ...overrides,
  };
}

describe("buildInvokeRequest", () => {
  it("builds the exact InvokeRequest shape, with executionId/stepId as the idempotency key", () => {
    const request = buildInvokeRequest({
      executionId: 42,
      step: makeStep(),
      resolvedInput: { x: 10 },
      timeoutMs: 5000,
    });
    expect(request).toEqual({
      executionId: "42",
      stepId: "stepA",
      function: "f",
      args: { x: "10" },
      timeoutMs: 5000,
    });
  });

  it("never populates dataFiles/secrets/stdin (out of Scope for this package)", () => {
    const request = buildInvokeRequest({
      executionId: 1,
      step: makeStep(),
      resolvedInput: {},
      timeoutMs: 1000,
    });
    expect(request).not.toHaveProperty("dataFiles");
    expect(request).not.toHaveProperty("secrets");
    expect(request).not.toHaveProperty("stdin");
  });
});

describe("dispatchStep", () => {
  it("resolves ok:true with the parsed output when the agent returns status ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "ok",
            stdout: "",
            stderr: "",
            exitCode: 0,
            output: { value: 5 },
          }),
          {
            status: 200,
          },
        ),
      ),
    );
    const result = await dispatchStep("http://agent.local", {
      executionId: 1,
      step: makeStep(),
      resolvedInput: {},
      timeoutMs: 1000,
    });
    expect(result).toEqual({ ok: true, output: { value: 5 } });
    vi.unstubAllGlobals();
  });

  it("resolves ok:false, carrying the raw InvokeResponse, when the agent returns status error", async () => {
    const errorResponse = { status: "error", stdout: "", stderr: "boom", exitCode: 1 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(errorResponse), { status: 200 })),
    );
    const result = await dispatchStep("http://agent.local", {
      executionId: 1,
      step: makeStep(),
      resolvedInput: {},
      timeoutMs: 1000,
    });
    expect(result).toEqual({ ok: false, response: errorResponse });
    vi.unstubAllGlobals();
  });

  it("throws FatalError WORKER_MALFORMED_INVOKE_OUTPUT when a status:ok response's output is not a plain object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "ok",
            stdout: "[1,2]",
            stderr: "",
            exitCode: 0,
            output: [1, 2],
          }),
          {
            status: 200,
          },
        ),
      ),
    );
    await expect(
      dispatchStep("http://agent.local", {
        executionId: 1,
        step: makeStep(),
        resolvedInput: {},
        timeoutMs: 1000,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ errorId: ERROR_IDS.WORKER_MALFORMED_INVOKE_OUTPUT }),
    );
    vi.unstubAllGlobals();
  });

  // Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md):
  // agent/internal/execrunner/execrunner.go omits Output entirely when
  // stdout isn't valid JSON (e.g. empty stdout, or a Step declaring no
  // `writes`) - this is a genuinely successful step, not a malformed
  // response, and must resolve to an empty output object rather than
  // throwing.
  it("resolves ok:true with an empty output object when a status:ok response has no output field at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", stdout: "", stderr: "", exitCode: 0 }), {
          status: 200,
        }),
      ),
    );
    const result = await dispatchStep("http://agent.local", {
      executionId: 1,
      step: makeStep(),
      resolvedInput: {},
      timeoutMs: 1000,
    });
    expect(result).toEqual({ ok: true, output: {} });
    vi.unstubAllGlobals();
  });
});
