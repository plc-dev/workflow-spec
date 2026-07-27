import type { InvocationDescriptorEntry, StateReuse } from "../../registry/index.js";
import { ERROR_IDS, FatalError } from "../../shared/index.js";
import type { Step } from "../../workflow-spec/index.js";
import { type AgentDataFile, type InvokeResponse, invoke } from "./agent-client.js";
import { AGENT_ARG_FLAG_NAME_PATTERN } from "./constants.js";

// design.md D17b - the function's own capability declaration this
// package needs to render an InvokeRequest correctly: which resolved
// parameter names are heavy (and how each one's materialized local path
// reaches the service's own native CLI signature), and whether the
// function may reuse local state across execs. Sourced from
// registry/getPlacementFacts, never invented per-call.
export interface DispatchCapability {
  invocationDescriptor: InvocationDescriptorEntry[];
  stateReuse: StateReuse;
}

// docs/impl-plans/0011-worker-cli-dispatch.md's Plan, "Args translation" -
// resolveStepReads (engine/, task 6.2a) returns plain JS values for the
// light binding kinds it supports (literal/request/step); the agent's
// Args field is Record<string, string> (every value becomes one literal
// CLI flag value, per agent/internal/execrunner/execrunner.go's
// `--<flagName> <value>` construction).
//
// design.md D17b - a resolved key that has a matching invocationDescriptor
// entry is a HEAVY binding, rendered per Layer 2's declared style instead
// of an ordinary light flag; every other key falls through to the
// original ordinary-flag rendering. (Dataset-scoped resolution itself -
// producing a materialized local path under that key - is task 5.6d, not
// yet built; this rendering rule is written to already be correct once
// it lands, per this package's own established pattern of stating a real
// gap explicitly rather than guessing a shape.)
export function translateArgsToInvokeArgs(
  resolvedInput: Record<string, unknown>,
  invocationDescriptor: InvocationDescriptorEntry[] = [],
): Record<string, string> {
  const heavyParams = new Set(invocationDescriptor.map((entry) => entry.param));
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolvedInput)) {
    if (value === undefined) continue;
    if (heavyParams.has(key)) continue; // rendered by renderHeavyBindings instead
    assertValidArgFlagName(key);
    const stringified = stringifyArgValue(value);
    assertSafeArgValue(key, stringified);
    args[key] = stringified;
  }
  return args;
}

export interface RenderedHeavyBindings {
  dataFiles: AgentDataFile[];
  positionalArgs: string[];
}

// design.md D17b, Layer 2 - renders every heavy binding present in
// resolvedInput according to the function's OWN declared invocation
// style (flag/positional/stdin), never a platform-mandated shape.
// `stateId` (Layer 3) is populated only for a function declaring
// `stateReuse: "stateIdKeyed"`, and only when the caller actually has a
// content hash to key it by (see buildInvokeRequest's `contentHash`
// param - real content-hash-to-dispatch wiring is a scheduler/placement
// concern (4.1/4.3, not yet built here), so its absence is an accepted,
// explicitly stated gap, not silently guessed).
export function renderHeavyBindings(
  resolvedInput: Record<string, unknown>,
  capability: DispatchCapability,
  contentHash?: string,
): RenderedHeavyBindings {
  const dataFiles: AgentDataFile[] = [];
  const positionalByIndex = new Map<number, string>();

  for (const entry of capability.invocationDescriptor) {
    const value = resolvedInput[entry.param];
    if (value === undefined) continue;
    const path = assertHeavyBindingIsPath(entry.param, value);
    const stateId =
      capability.stateReuse === "stateIdKeyed" && contentHash ? contentHash : undefined;

    switch (entry.style) {
      case "flag":
        dataFiles.push({ flag: entry.flagName, path, stateId });
        break;
      case "positional": {
        const positionIndex = entry.positionIndex ?? 0;
        // Local-review fix: registry/validate.ts now rejects a duplicate
        // positionIndex at registration time, but this Map-based
        // construction would otherwise silently DROP one heavy binding
        // (a later entry overwriting an earlier one at the same index)
        // rather than erroring - fail closed instead of losing a
        // binding silently, in case that registration-time guard is
        // ever bypassed or has its own bug.
        if (positionalByIndex.has(positionIndex)) {
          throw new FatalError(ERROR_IDS.WORKER_INVALID_HEAVY_BINDING_VALUE, {
            context: { param: entry.param, positionIndex, reason: "duplicate positionIndex" },
          });
        }
        positionalByIndex.set(positionIndex, path);
        break;
      }
      case "stdin":
        dataFiles.push({ path, stateId, stdinFromPath: true });
        break;
    }
  }

  const positionalArgs = [...positionalByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, path]) => path);

  return { dataFiles, positionalArgs };
}

// Local-review fix: this package's own `assertSafeArgValue` guard (below)
// was, until this fix, applied ONLY to light args - a heavy binding's
// value is rendered as a bare positional argv token, or a flag's SEPARATE
// value token, exactly the same argv shape `assertSafeArgValue` already
// exists to protect (see its own comment). A leading "-" would let the
// wrapped CLI reparse this binding's value as an unrelated flag.
function assertHeavyBindingIsPath(param: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FatalError(ERROR_IDS.WORKER_INVALID_HEAVY_BINDING_VALUE, {
      context: { param, value },
    });
  }
  assertSafeArgValue(param, value);
  // Local-review fix: defense-in-depth against path traversal. This is
  // NOT a full containment check - this package has no configured
  // materialization root to validate against (Layer 1's actual
  // materialization mechanism remains unspecified, design.md D17/D6) -
  // but a ".." path segment never legitimately appears in a real
  // materialized local path, only ever signaling traversal intent.
  if (value.split(/[/\\]/).includes("..")) {
    throw new FatalError(ERROR_IDS.WORKER_UNSAFE_ARG_VALUE, { context: { key: param, value } });
  }
  return value;
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
  // design.md D17b - the target function's registry-declared invocation
  // descriptor/state-reuse capability. Defaults to "no heavy bindings,
  // no state reuse" (an all-light-bindings function) so existing callers
  // that only ever exercise light bindings are unaffected; a real heavy
  // binding with no capability supplied still fails via
  // renderHeavyBindings/translateArgsToInvokeArgs's own checks, never
  // silently.
  capability?: DispatchCapability;
  // design.md D17b, Layer 3 - the content hash to key `--state-id`-
  // equivalent reuse by, when the target function declares
  // `stateReuse: "stateIdKeyed"`. Real content-hash-to-dispatch wiring is
  // a scheduler/placement concern (4.1/4.3, not yet built) - omitted by
  // every caller today, an accepted, explicitly stated gap.
  contentHash?: string;
}

const NO_HEAVY_BINDINGS_CAPABILITY: DispatchCapability = {
  invocationDescriptor: [],
  stateReuse: "none",
};

/** Builds the InvokeRequest for one step. Never populates secrets
 * (9.1-9.4) - explicitly out of Scope for this package (0011's Scope
 * section). Heavy bindings (design.md D17b) are rendered per the target
 * function's own declared invocationDescriptor/stateReuse capability,
 * never a platform-mandated shape. */
export function buildInvokeRequest(params: BuildInvokeRequestParams) {
  const { executionId, step, resolvedInput, timeoutMs } = params;
  const capability = params.capability ?? NO_HEAVY_BINDINGS_CAPABILITY;
  const { dataFiles, positionalArgs } = renderHeavyBindings(
    resolvedInput,
    capability,
    params.contentHash,
  );

  return {
    executionId: String(executionId),
    stepId: step.id,
    function: step.function,
    args: translateArgsToInvokeArgs(resolvedInput, capability.invocationDescriptor),
    ...(positionalArgs.length > 0 ? { positionalArgs } : {}),
    ...(dataFiles.length > 0 ? { dataFiles } : {}),
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
