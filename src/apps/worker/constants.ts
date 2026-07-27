// Named constants for apps/worker - see docs/impl-plans/0011-worker-cli-
// dispatch.md's Plan section for the rationale behind each default.

// Config-schema defaults (config.ts) - separate constants so a default
// value has a name, not a bare literal sitting inside a zod schema.
export const DEFAULT_CLAIM_LEASE_SECONDS = 30;
export const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;

// execrunner.go's own flag-name constraint (agent/internal/execrunner/
// execrunner.go) - dispatch.ts validates against the SAME pattern before
// ever calling the agent, so a malformed flag name fails clearly on this
// side instead of surfacing as the agent's opaque 400 response.
export const AGENT_ARG_FLAG_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/;

// agent/internal/server/invoke.go's own HTTP path.
export const AGENT_INVOKE_PATH = "/invoke";

// Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md): how
// much longer than the agent's OWN `timeoutMs` this client waits before
// giving up client-side (AbortSignal.timeout in agent-client.ts) -
// gives the agent a chance to respond with a real "timeout" status
// itself before this side gives up first.
export const AGENT_FETCH_TIMEOUT_MARGIN_MS = 5_000;

// Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md): the
// max number of characters of a failed step's stderr logged verbatim -
// never the full (up to 8 MiB) stdout/stderr, since pino's redact config
// can't reach free-form subprocess output and a step's real output may
// echo sensitive payload data.
export const STDERR_LOG_EXCERPT_LENGTH = 500;

// Log event names (pino, per shared/observability/logger.ts's convention
// of a stable, dot-namespaced event string per log site).
export const LOG_EVENT_RUN_ONCE_DISPATCH = "apps.worker.run_once.dispatch";
export const LOG_EVENT_RUN_ONCE_TRANSIENT_FAILURE = "apps.worker.run_once.transient_failure";
export const LOG_EVENT_RUN_ONCE_TERMINAL_FAILURE = "apps.worker.run_once.terminal_failure";
export const LOG_EVENT_WORKER_LOOP_STOPPED = "apps.worker.loop.stopped";
