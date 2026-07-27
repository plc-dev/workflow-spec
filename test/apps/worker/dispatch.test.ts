import { describe, expect, it, vi } from "vitest";
import type { DispatchCapability } from "../../../src/apps/worker/dispatch.js";
import {
  buildInvokeRequest,
  dispatchStep,
  renderHeavyBindings,
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

  it("never populates dataFiles/positionalArgs/secrets/stdin when no capability is supplied (light-only, out of Scope for secrets)", () => {
    const request = buildInvokeRequest({
      executionId: 1,
      step: makeStep(),
      resolvedInput: {},
      timeoutMs: 1000,
    });
    expect(request).not.toHaveProperty("dataFiles");
    expect(request).not.toHaveProperty("positionalArgs");
    expect(request).not.toHaveProperty("secrets");
    expect(request).not.toHaveProperty("stdin");
  });
});

// design.md D17b - renderHeavyBindings/translateArgsToInvokeArgs render a
// heavy binding per the TARGET FUNCTION'S OWN declared invocationDescriptor
// style, never a platform-mandated "--data-file"/"--state-id" shape.
describe("renderHeavyBindings", () => {
  it('renders a "flag"-style entry into dataFiles, and excludes it from args', () => {
    const capability: DispatchCapability = {
      invocationDescriptor: [{ param: "dumpFile", style: "flag", flagName: "--dump-file" }],
      stateReuse: "none",
    };
    const resolvedInput = { dumpFile: "/mnt/dump.sql", other: "light" };

    const { dataFiles, positionalArgs } = renderHeavyBindings(resolvedInput, capability);
    expect(dataFiles).toEqual([{ flag: "--dump-file", path: "/mnt/dump.sql", stateId: undefined }]);
    expect(positionalArgs).toEqual([]);
    expect(translateArgsToInvokeArgs(resolvedInput, capability.invocationDescriptor)).toEqual({
      other: "light",
    });
  });

  it('renders a "positional"-style entry into positionalArgs, ordered by positionIndex, never as a dataFiles entry', () => {
    const capability: DispatchCapability = {
      invocationDescriptor: [
        { param: "second", style: "positional", positionIndex: 1 },
        { param: "first", style: "positional", positionIndex: 0 },
      ],
      stateReuse: "none",
    };
    const resolvedInput = { first: "/mnt/a", second: "/mnt/b" };

    const { dataFiles, positionalArgs } = renderHeavyBindings(resolvedInput, capability);
    expect(dataFiles).toEqual([]);
    expect(positionalArgs).toEqual(["/mnt/a", "/mnt/b"]);
  });

  it('renders a "stdin"-style entry as a flagless dataFiles entry with stdinFromPath: true', () => {
    const capability: DispatchCapability = {
      invocationDescriptor: [{ param: "payload", style: "stdin" }],
      stateReuse: "none",
    };
    const resolvedInput = { payload: "/mnt/payload.json" };

    const { dataFiles } = renderHeavyBindings(resolvedInput, capability);
    expect(dataFiles).toEqual([
      { path: "/mnt/payload.json", stateId: undefined, stdinFromPath: true },
    ]);
  });

  it('populates stateId only when stateReuse is "stateIdKeyed" AND a contentHash is supplied', () => {
    const stateIdKeyed: DispatchCapability = {
      invocationDescriptor: [{ param: "dumpFile", style: "flag", flagName: "--dump-file" }],
      stateReuse: "stateIdKeyed",
    };
    const resolvedInput = { dumpFile: "/mnt/dump.sql" };

    expect(renderHeavyBindings(resolvedInput, stateIdKeyed).dataFiles[0]?.stateId).toBeUndefined();
    expect(renderHeavyBindings(resolvedInput, stateIdKeyed, "hash123").dataFiles[0]?.stateId).toBe(
      "hash123",
    );

    const none: DispatchCapability = { ...stateIdKeyed, stateReuse: "none" };
    expect(
      renderHeavyBindings(resolvedInput, none, "hash123").dataFiles[0]?.stateId,
    ).toBeUndefined();
  });

  it("throws FatalError WORKER_INVALID_HEAVY_BINDING_VALUE when a declared heavy binding does not resolve to a non-empty string path", () => {
    const capability: DispatchCapability = {
      invocationDescriptor: [{ param: "dumpFile", style: "flag", flagName: "--dump-file" }],
      stateReuse: "none",
    };
    expect(() => renderHeavyBindings({ dumpFile: 42 }, capability)).toThrow(
      expect.objectContaining({ errorId: ERROR_IDS.WORKER_INVALID_HEAVY_BINDING_VALUE }),
    );
    expect(() => renderHeavyBindings({ dumpFile: "" }, capability)).toThrow(
      expect.objectContaining({ errorId: ERROR_IDS.WORKER_INVALID_HEAVY_BINDING_VALUE }),
    );
  });

  // Local-review fix: heavy bindings are rendered as bare argv tokens
  // (positional) or a flag's separate value token (flag/stdin) - the
  // SAME argv shape assertSafeArgValue already guards for light args.
  it.each(["flag", "positional", "stdin"] as const)(
    'rejects a heavy binding value starting with "-" for style %s (argv-injection guard)',
    (style) => {
      const capability: DispatchCapability = {
        invocationDescriptor: [
          { param: "dumpFile", style, flagName: "--dump-file", positionIndex: 0 },
        ],
        stateReuse: "none",
      };
      expect(() => renderHeavyBindings({ dumpFile: "--evil-flag" }, capability)).toThrow(
        expect.objectContaining({ errorId: ERROR_IDS.WORKER_UNSAFE_ARG_VALUE }),
      );
    },
  );

  it('rejects a heavy binding value containing a ".." path-traversal segment', () => {
    const capability: DispatchCapability = {
      invocationDescriptor: [{ param: "dumpFile", style: "flag", flagName: "--dump-file" }],
      stateReuse: "none",
    };
    expect(() => renderHeavyBindings({ dumpFile: "/mnt/../etc/passwd" }, capability)).toThrow(
      expect.objectContaining({ errorId: ERROR_IDS.WORKER_UNSAFE_ARG_VALUE }),
    );
  });

  it("throws rather than silently dropping a binding when two positional entries resolve to the same positionIndex", () => {
    const capability: DispatchCapability = {
      invocationDescriptor: [
        { param: "a", style: "positional", positionIndex: 0 },
        { param: "b", style: "positional", positionIndex: 0 },
      ],
      stateReuse: "none",
    };
    expect(() => renderHeavyBindings({ a: "/mnt/a", b: "/mnt/b" }, capability)).toThrow(
      expect.objectContaining({ errorId: ERROR_IDS.WORKER_INVALID_HEAVY_BINDING_VALUE }),
    );
  });

  it("omits an entry entirely when its resolved value is undefined (e.g. a step that doesn't bind an optional heavy parameter)", () => {
    const capability: DispatchCapability = {
      invocationDescriptor: [{ param: "dumpFile", style: "flag", flagName: "--dump-file" }],
      stateReuse: "none",
    };
    expect(renderHeavyBindings({}, capability)).toEqual({ dataFiles: [], positionalArgs: [] });
  });
});

describe("buildInvokeRequest - heavy bindings (design.md D17b)", () => {
  it("renders dataFiles/positionalArgs per the supplied capability, alongside ordinary light args", () => {
    const capability: DispatchCapability = {
      invocationDescriptor: [{ param: "dumpFile", style: "flag", flagName: "--dump-file" }],
      stateReuse: "stateIdKeyed",
    };
    const request = buildInvokeRequest({
      executionId: 7,
      step: makeStep(),
      resolvedInput: { dumpFile: "/mnt/dump.sql", limit: 10 },
      timeoutMs: 5000,
      capability,
      contentHash: "hash123",
    });
    expect(request).toEqual({
      executionId: "7",
      stepId: "stepA",
      function: "f",
      args: { limit: "10" },
      dataFiles: [{ flag: "--dump-file", path: "/mnt/dump.sql", stateId: "hash123" }],
      timeoutMs: 5000,
    });
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
