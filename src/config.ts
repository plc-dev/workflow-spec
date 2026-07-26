import { z } from "zod";

// ADR-0009: "Config loading: one src/config.ts. A zod schema over
// process.env, parsed once at each app's startup; fails closed (a startup
// crash, not a silent default) on anything missing or invalid. No
// scattered process.env.X reads elsewhere in the codebase."
//
// Required env vars have no `.default(...)` - a missing/invalid value
// throws at import time (fail-closed). Optional env vars carry an explicit
// default here, so "what happens if this isn't set" is answered in
// exactly one place rather than wherever the value happens to be read.
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const EnvSchema = z.object({
  // Optional: defaults to "info" if unset.
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});

// Exported (not just called internally) so tests can exercise fail-closed
// behavior against an arbitrary env object, without relying on module
// re-import tricks to get a second module-level singleton.
export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Fail closed: a misconfigured environment crashes at startup rather
    // than silently falling back to a default for a REQUIRED variable.
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return {
    logLevel: parsed.data.LOG_LEVEL,
  };
}

export interface Config {
  logLevel: (typeof LOG_LEVELS)[number];
}

// Parsed once, at module load - every other module imports THIS, never
// `process.env` directly.
export const config: Config = parseConfig(process.env);
