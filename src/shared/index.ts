// ADR-0012: `src/shared/` is a closed set of named cross-cutting concerns
// (config, errors, observability) - this barrel is the only way another
// module may import from it.
export { config, type Config, parseConfig } from "./config.js";
export {
  DEFAULT_ERROR_MESSAGES,
  ERROR_IDS,
  type ErrorId,
  FatalError,
  PlatformError,
  type PlatformErrorOptions,
  RetryableError,
} from "./errors.js";
export { logger, REDACT_CONFIG } from "./observability/index.js";
