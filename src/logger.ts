import pino from "pino";
import { config } from "./config.js";

// ADR-0009: pino for structured, JSON logging, with a shared `redact`
// configuration covering known secret-shaped fields - directly serving
// D7/task 9.6 rather than retrofitting redaction later. This module is the
// one shared instance every future module/app imports; no scattered
// `pino()` construction elsewhere.
//
// Not related to `session_log` (D3) - that is a durable, queryable domain
// record of session mutations (lives in `core/`'s schema), not an
// application log.
//
// Log LEVEL comes from `config` (src/config.ts), never `process.env`
// directly (ADR-0009: "no scattered process.env.X reads elsewhere in the
// codebase").
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
] as const;

const REDACT_CENSOR_TEXT = "[REDACTED]";

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [...REDACT_PATHS],
    censor: REDACT_CENSOR_TEXT,
  },
});

export const REDACT_CONFIG = { paths: REDACT_PATHS } as const;
