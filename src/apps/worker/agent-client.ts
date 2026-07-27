import { ERROR_IDS, FatalError, RetryableError } from "../../shared/index.js";
import { AGENT_FETCH_TIMEOUT_MARGIN_MS, AGENT_INVOKE_PATH } from "./constants.js";

// TS mirror of agent/internal/api/types.go (docs/adr/0008-in-pod-exec-
// agent.md) - field names/optionality kept byte-identical to the Go JSON
// tags, since this is the wire contract, not an independently invented
// shape. `stdin` is base64 here (matching Go's `[]byte` JSON encoding);
// this package never populates it directly (see `AgentDataFile.stdinFromPath`
// below for how a heavy binding reaches a subprocess's stdin instead).
//
// design.md D17b - supersedes D17/D17a's single universal
// `--data-file <path> --state-id <key>` shape. A DataFile entry now
// describes ONE of three ways a function's OWN native CLI signature
// (registry/'s per-function invocationDescriptor, Layer 2) accepts a
// materialized local path - `flag` is only set for style "flag";
// `stdinFromPath` is only set for style "stdin" (the agent pipes the
// file's CONTENTS to the subprocess, never the path itself, and never
// carries the bytes over THIS RPC - design.md D6/R3). `stateId` is only
// set for a function declaring `stateReuse: "stateIdKeyed"` (Layer 3,
// opt-in) - omitted entirely for the conservative "none" default. This
// is a clean override of D17/D17a's old shape, not a superset kept for
// backward compatibility.
export interface AgentDataFile {
  flag?: string;
  path: string;
  stateId?: string;
  stdinFromPath?: boolean;
}

export interface AgentSecret {
  name: string;
  value: string;
}

export interface InvokeRequest {
  executionId: string;
  stepId: string;
  function: string;
  args?: Record<string, string>;
  // design.md D17b - positional heavy bindings (invocationDescriptor
  // style "positional"), ordered by the descriptor's positionIndex.
  positionalArgs?: string[];
  dataFiles?: AgentDataFile[];
  secrets?: AgentSecret[];
  stdin?: string;
  timeoutMs: number;
}

export type InvokeStatus = "ok" | "error" | "timeout";

export interface InvokeResponse {
  status: InvokeStatus;
  stdout: string;
  stderr: string;
  exitCode: number;
  output?: unknown;
}

// Genuinely transport-level failures (connection refused, DNS failure,
// non-2xx/non-4xx status, or a client-side timeout) - safe to retry per
// ADR-0008's Window A/C framing. A 4xx means OUR request shape was
// rejected by the agent's own validation (a bug on this side, not a
// transient condition) - see invoke()'s status-code handling below.
//
// Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md):
// `request.timeoutMs` was previously ONLY advisory to the agent's own
// runner - `fetch` itself had no client-side timeout, so a hung agent or
// half-open connection left the call pending indefinitely, holding the
// caller's open DB transaction (and its claimed row's lease) for as
// long as the connection stayed open. `AbortSignal.timeout` bounds the
// wait on THIS side too, independent of whatever the agent does.
async function postJson<T>(
  url: string,
  body: unknown,
  opts: { timeoutMs: number; authToken?: string },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs + AGENT_FETCH_TIMEOUT_MARGIN_MS),
    });
  } catch (cause) {
    throw new RetryableError(ERROR_IDS.WORKER_AGENT_UNREACHABLE, {
      cause,
      context: { url },
    });
  }

  if (response.status >= 400 && response.status < 500) {
    const text = await response.text().catch(() => "");
    throw new FatalError(ERROR_IDS.WORKER_INVOKE_REQUEST_REJECTED, {
      context: { url, status: response.status, body: text },
    });
  }

  if (!response.ok) {
    throw new RetryableError(ERROR_IDS.WORKER_AGENT_UNREACHABLE, {
      context: { url, status: response.status },
    });
  }

  return (await response.json()) as T;
}

export interface InvokeOptions {
  /** Sent as `Authorization: Bearer <authToken>` when set - the agent's
   * own optional AGENT_AUTH_TOKEN bearer-auth middleware (ADR-0008).
   * Omitted entirely (no header) when unset, matching a deployment
   * running the agent with auth disabled. */
  authToken?: string;
}

/** POSTs to the agent's /invoke - see docs/impl-plans/0011-worker-cli-
 * dispatch.md's "Test design" for why this is exercised against a REAL
 * spawned agent binary in this package's integration tests, not a mock. */
export function invoke(
  baseUrl: string,
  request: InvokeRequest,
  opts: InvokeOptions = {},
): Promise<InvokeResponse> {
  return postJson<InvokeResponse>(`${baseUrl}${AGENT_INVOKE_PATH}`, request, {
    timeoutMs: request.timeoutMs,
    authToken: opts.authToken,
  });
}
