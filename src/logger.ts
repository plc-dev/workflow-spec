import pino from "pino";

// ADR-0009: pino for structured, JSON logging, with a shared `redact`
// configuration covering known secret-shaped fields - directly serving
// D7/task 9.6 rather than retrofitting redaction later. This module is the
// one shared instance every future module/app imports; no scattered
// `pino()` construction elsewhere.
//
// Not related to `session_log` (D3) - that is a durable, queryable domain
// record of session mutations (lives in `core/`'s schema), not an
// application log.
const REDACT_PATHS = [
  "secret",
  "*.secret",
  "*.secrets",
  "*.password",
  "*.token",
  "*.apiKey",
  "*.api_key",
  "*.accessToken",
  "*.access_token",
  "*.authorization",
  "req.headers.authorization",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
  },
});

export const REDACT_CONFIG = { paths: REDACT_PATHS } as const;
