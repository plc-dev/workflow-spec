import { ERROR_IDS, FatalError } from "../../shared/index.js";
import type { Step } from "../../workflow-spec/index.js";
import { type InvokeResponse, invoke } from "./agent-client.js";
import { AGENT_ARG_FLAG_NAME_PATTERN } from "./constants.js";

// docs/impl-plans/0011-worker-cli-dispatch.md's Plan, "Args translation" -
// resolveStepReads (engine/, task 6.2a) returns plain JS values for the
// light binding kinds it supports (literal/request/step); the agent's
// Args field is Record<string, string> (every value becomes one literal
// CLI flag value, per agent/internal/execrunner/execrunner.go's
// `--<flagName> <value>` construction).
export function translateArgsToInvokeArgs(
  resolvedInput: Record<string, unknown>,
): Record<string, string> {
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolvedInput)) {
    if (value === undefined) continue;
    assertValidArgFlagName(key);
    const stringified = stringifyArgValue(value);
    assertSafeArgValue(key, stringified);
    args[key] = stringified;
  }
  return args;
}

function stringifyArgValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // object/array/null - the function's CLI entrypoint is responsible for
  // parsing this back; no richer convention exists yet in design.md/the
  // registry's OpenAPI-spec metadata to do better (0011's Plan).
  return JSON.stringify(value);
}

function assertValidArgFlagName(key: string): void {
  if (!AGENT_ARG_FLAG_NAME_PATTERN.test(key)) {
    throw new FatalError(ERROR_IDS.WORKER_INVALID_ARG_FLAG_NAME, { context: { key } });
  }
}

// Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md):
// AGENT_ARG_FLAG_NAME_PATTERN only constrains flag NAMES.
// agent/internal/execrunner/execrunner.go appends `--<flagName>` and
// `value` as two SEPARATE argv tokens (never a single "--flag=value"
// token) - a resolved binding VALUE that itself starts with "-" (e.g. a
// request parameter or a prior step's output under attacker/author
// control) would be parsed by the wrapped CLI as an unrelated flag, not
// as this binding's own value. Fails closed rather than risk argument
// injection into the invoked subprocess.
function assertSafeArgValue(key: string, value: string): void {
  if (value.startsWith("-")) {
    throw new FatalError(ERROR_IDS.WORKER_UNSAFE_ARG_VALUE, { context: { key } });
  }
}

export interface BuildInvokeRequestParams {
  executionId: number;
  step: Step;
  resolvedInput: Record<string, unknown>;
  timeoutMs: number;
}

/** Builds the InvokeRequest for one step. Never populates dataFiles
 * (dataset-scoped bindings, 5.6d) or secrets (9.1-9.4) or stdin -
 * explicitly out of Scope for this package (0011's Scope section). */
export function buildInvokeRequest(params: BuildInvokeRequestParams) {
  const { executionId, step, resolvedInput, timeoutMs } = params;
  return {
    executionId: String(executionId),
    stepId: step.id,
    function: step.function,
    args: translateArgsToInvokeArgs(resolvedInput),
    timeoutMs,
  };
}

/** Dispatches one step to the real exec-agent and resolves its output
 * into the plain Record<string, unknown> shape completeStep (engine/)
 * expects - or returns null if the invocation was a genuine, non-
 * transient failure (nonzero exit / timeout) that the caller (worker-
 * loop.ts) should treat as terminal for the run, per 0011's Plan,
 * "Dispatch failure handling". A transport-level failure (agent
 * unreachable) is never caught here - it propagates as a RetryableError
 * so the caller's transaction rolls back. */
export async function dispatchStep(
  agentBaseUrl: string,
  params: BuildInvokeRequestParams,
  opts: { authToken?: string } = {},
): Promise<
  { ok: true; output: Record<string, unknown> } | { ok: false; response: InvokeResponse }
> {
  const request = buildInvokeRequest(params);
  const response = await invoke(agentBaseUrl, request, opts);

  if (response.status !== "ok") {
    return { ok: false, response };
  }

  return { ok: true, output: parseInvokeOutput(response) };
}

// Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md):
// agent/internal/execrunner/execrunner.go only sets InvokeResponse.Output
// when stdout parses as JSON (`omitempty`) - a step that legitimately
// succeeds with empty or plain-text stdout (e.g. a Step declaring no
// `writes`) has `status: "ok"` with `output` ABSENT, not malformed. Only
// an output that is PRESENT but not a plain JSON object is a real
// malformed-response condition.
function parseInvokeOutput(response: InvokeResponse): Record<string, unknown> {
  const { output } = response;
  if (output === undefined || output === null) {
    return {};
  }
  if (typeof output !== "object" || Array.isArray(output)) {
    throw new FatalError(ERROR_IDS.WORKER_MALFORMED_INVOKE_OUTPUT, {
      context: { output },
    });
  }
  return output as Record<string, unknown>;
}
