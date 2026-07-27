import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../../src/apps/worker/agent-client.js";
import { ERROR_IDS, FatalError, RetryableError } from "../../../src/shared/index.js";

// T3/T4/T5 (docs/impl-plans/0011-worker-cli-dispatch.md): agent-client.ts
// is the ONLY place this package classifies a wire-level failure as
// retryable vs. fatal - the ok/error/timeout status DECISION itself
// stays in dispatch.ts/worker-loop.ts (T5 - passthrough fidelity).

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("invoke", () => {
  it("throws RetryableError WORKER_AGENT_UNREACHABLE when fetch itself throws (connection refused etc.)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(
      invoke("http://agent.local", {
        executionId: "1",
        stepId: "s",
        function: "f",
        timeoutMs: 1000,
      }),
    ).rejects.toEqual(expect.objectContaining({ errorId: ERROR_IDS.WORKER_AGENT_UNREACHABLE }));
  });

  it("throws RetryableError WORKER_AGENT_UNREACHABLE on a non-2xx/non-4xx status (e.g. 503)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(
      invoke("http://agent.local", {
        executionId: "1",
        stepId: "s",
        function: "f",
        timeoutMs: 1000,
      }),
    ).rejects.toEqual(expect.objectContaining({ errorId: ERROR_IDS.WORKER_AGENT_UNREACHABLE }));
  });

  it("throws FatalError WORKER_INVOKE_REQUEST_REJECTED on a 400 (our own request shape rejected)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));
    await expect(
      invoke("http://agent.local", {
        executionId: "1",
        stepId: "s",
        function: "f",
        timeoutMs: 1000,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ errorId: ERROR_IDS.WORKER_INVOKE_REQUEST_REJECTED }),
    );
  });

  it("returns a status:ok InvokeResponse unchanged, matching agent/internal/api/types.go's field names", async () => {
    const body = { status: "ok", stdout: "hi", stderr: "", exitCode: 0, output: { x: 1 } };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
    );
    const response = await invoke("http://agent.local", {
      executionId: "1",
      stepId: "s",
      function: "f",
      timeoutMs: 1000,
    });
    expect(response).toEqual(body);
  });

  it("returns a status:error/timeout InvokeResponse unchanged, without throwing - the decision is the caller's job", async () => {
    const body = { status: "timeout", stdout: "", stderr: "", exitCode: -1 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
    );
    const response = await invoke("http://agent.local", {
      executionId: "1",
      stepId: "s",
      function: "f",
      timeoutMs: 1000,
    });
    expect(response).toEqual(body);
  });

  it("sends a JSON POST to <baseUrl>/invoke", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", stdout: "", stderr: "", exitCode: 0 }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await invoke("http://agent.local", {
      executionId: "1",
      stepId: "s",
      function: "f",
      timeoutMs: 1000,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://agent.local/invoke",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

// Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md): sends
// an Authorization header when an authToken is supplied, and none at
// all when it isn't (matching a deployment running the agent with auth
// disabled).
describe("invoke - auth token", () => {
  it("sends an Authorization: Bearer header when an authToken is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", stdout: "", stderr: "", exitCode: 0 }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await invoke(
      "http://agent.local",
      { executionId: "1", stepId: "s", function: "f", timeoutMs: 1000 },
      { authToken: "secret-token" },
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
  });

  it("sends no Authorization header when no authToken is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", stdout: "", stderr: "", exitCode: 0 }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await invoke("http://agent.local", {
      executionId: "1",
      stepId: "s",
      function: "f",
      timeoutMs: 1000,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("authorization");
  });
});

// Sanity check that the classification errors really are the taxonomy's
// distinct subclasses, not just objects that happen to carry the right
// errorId.
describe("error class identity", () => {
  it("WORKER_AGENT_UNREACHABLE is a RetryableError instance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    try {
      await invoke("http://agent.local", {
        executionId: "1",
        stepId: "s",
        function: "f",
        timeoutMs: 1000,
      });
      throw new Error("expected invoke to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RetryableError);
    }
  });

  it("WORKER_INVOKE_REQUEST_REJECTED is a FatalError instance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 400 })));
    try {
      await invoke("http://agent.local", {
        executionId: "1",
        stepId: "s",
        function: "f",
        timeoutMs: 1000,
      });
      throw new Error("expected invoke to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FatalError);
    }
  });
});
