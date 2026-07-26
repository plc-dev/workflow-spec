// ADR-0009: "One shared src/shared/errors.ts: a PlatformError base, with
// RetryableError and FatalError subclasses." (path grouped under
// src/shared/ per ADR-0012.) D6 R7 (native retries) and D8d (no DSL-level
// retry surface - platform-managed) both require the engine to
// mechanically distinguish these somewhere; one shared place avoids each
// module inventing its own ad hoc convention.
//
// Every PlatformError carries a stable `errorId` separate from its
// human-readable `message` - the id is the thing an external system can
// key its OWN user-facing copy off of; `message` is only this codebase's
// own default (used in logs/dev), never assumed to be end-user-facing.

export const ERROR_IDS = {
  CORE_ENQUEUE_NO_ROW_RETURNED: "core.executions.enqueue_no_row_returned",
  CORE_CHECKPOINT_CONFLICT_NOT_FOUND: "core.checkpoints.conflict_not_found",
  CORE_WAIT_NO_ROW_RETURNED: "core.waits.insert_no_row_returned",
  CORE_WAIT_KEY_TOO_LONG: "core.waits.wait_key_too_long",
} as const;

export type ErrorId = (typeof ERROR_IDS)[keyof typeof ERROR_IDS];

// Default messages, keyed by errorId - the fallback used when no caller
// supplies its own. External systems that want their own user-facing copy
// key off `errorId`, not off this text.
export const DEFAULT_ERROR_MESSAGES: Record<ErrorId, string> = {
  [ERROR_IDS.CORE_ENQUEUE_NO_ROW_RETURNED]:
    "Enqueuing an execution did not return the inserted row.",
  [ERROR_IDS.CORE_CHECKPOINT_CONFLICT_NOT_FOUND]:
    "A checkpoint insert conflicted with an existing row, but that row could not be found.",
  [ERROR_IDS.CORE_WAIT_NO_ROW_RETURNED]: "Inserting a wait did not return the inserted row.",
  [ERROR_IDS.CORE_WAIT_KEY_TOO_LONG]: "A wait's waitKey exceeds the maximum allowed length.",
};

export interface PlatformErrorOptions {
  cause?: unknown;
  /** Extra structured context - never a secret-shaped field (ADR-0009's redact config only covers logger fields, not error context). */
  context?: Record<string, unknown>;
}

export class PlatformError extends Error {
  readonly errorId: ErrorId;
  readonly context: Record<string, unknown> | undefined;

  constructor(errorId: ErrorId, options: PlatformErrorOptions = {}) {
    super(DEFAULT_ERROR_MESSAGES[errorId], { cause: options.cause });
    this.name = "PlatformError";
    this.errorId = errorId;
    this.context = options.context;
  }
}

/** Safe to retry the operation that produced this (D6 R7). */
export class RetryableError extends PlatformError {
  constructor(errorId: ErrorId, options: PlatformErrorOptions = {}) {
    super(errorId, options);
    this.name = "RetryableError";
  }
}

/** Retrying will not help - the caller must not mechanically retry this. */
export class FatalError extends PlatformError {
  constructor(errorId: ErrorId, options: PlatformErrorOptions = {}) {
    super(errorId, options);
    this.name = "FatalError";
  }
}
