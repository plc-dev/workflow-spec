import { z } from "zod";
import {
  DEFAULT_CLAIM_LEASE_SECONDS,
  DEFAULT_INVOKE_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from "./constants.js";

// docs/impl-plans/0011-worker-cli-dispatch.md's Plan section: this app's
// OWN env vars, following shared/config.ts's exact fail-closed pattern
// (best-practices.md #1) but living in apps/worker/ itself, not
// src/shared/ - these vars are meaningful to this one entrypoint only,
// and src/shared/ is a closed set (ADR-0012 §3) this package does not
// amend.
//
// AGENT_INVOKE_BASE_URL has no `.default(...)` - required, fails closed.
// It is a deliberate placeholder for real placement-aware addressing
// (0011's "Addressing gap" section) - every dispatch in this package uses
// this ONE configured endpoint, regardless of step.service/step.function.
//
// DATABASE_URL: also required here, NOT in src/shared/config.ts, despite
// .example.env's pre-existing note suggesting the latter. Implementation-
// notes deviation (see 0011's own Implementation notes section): the
// exported `config` singleton in src/shared/config.ts is parsed EAGERLY
// at module-import time and is transitively imported by nearly every
// module in this repo (via shared/observability/logger.ts) - making
// DATABASE_URL required there would fail closed for every test/module
// that merely imports core/engine/etc. without ever opening a real
// connection (core/'s own tests hand repositories an already-connected
// testcontainers pool directly, never through shared config). Keeping it
// here means only this app's own explicit startup (main.ts calling
// parseWorkerConfig) pays that fail-closed cost - exactly the vars this
// one entrypoint needs, parsed once at ITS startup (ADR-0009's "parsed
// once at each app's startup", read literally: each app, not one global
// parse for all of them).
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  AGENT_INVOKE_BASE_URL: z.string().url(),
  // Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md):
  // optional - the agent's own AGENT_AUTH_TOKEN bearer-auth middleware
  // is also optional (ADR-0008); when unset, no Authorization header is
  // sent at all (agent-client.ts), matching a deployment that runs the
  // agent with auth disabled. This was previously an unaddressed open
  // question in this package's plan; now wired through, still optional
  // since no real auth/identity system exists yet for this repo to
  // require it against.
  AGENT_AUTH_TOKEN: z.string().min(1).optional(),
  WORKER_ID: z.string().min(1).optional(),
  CLAIM_LEASE_SECONDS: z.coerce.number().int().positive().default(DEFAULT_CLAIM_LEASE_SECONDS),
  INVOKE_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_INVOKE_TIMEOUT_MS),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(DEFAULT_POLL_INTERVAL_MS),
});

export interface WorkerConfig {
  databaseUrl: string;
  agentInvokeBaseUrl: string;
  agentAuthToken: string | undefined;
  /** Falls back to a generated id (hostname+pid) at call time in main.ts
   * if unset - config.ts itself only reports "not provided" (undefined),
   * per best-practices.md #1's "one place decides the default" rule; the
   * generated fallback lives in main.ts because it needs process.pid/
   * os.hostname(), not because config.ts is uncertain what to default to. */
  workerId: string | undefined;
  claimLeaseSeconds: number;
  invokeTimeoutMs: number;
  pollIntervalMs: number;
}

// Exported separately from the module-level singleton (best-practices.md
// #1) so tests can exercise fail-closed/default behavior against an
// arbitrary env object without module-reimport tricks.
export function parseWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid apps/worker environment configuration: ${parsed.error.message}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    agentInvokeBaseUrl: parsed.data.AGENT_INVOKE_BASE_URL,
    agentAuthToken: parsed.data.AGENT_AUTH_TOKEN,
    workerId: parsed.data.WORKER_ID,
    claimLeaseSeconds: parsed.data.CLAIM_LEASE_SECONDS,
    invokeTimeoutMs: parsed.data.INVOKE_TIMEOUT_MS,
    pollIntervalMs: parsed.data.POLL_INTERVAL_MS,
  };
}
