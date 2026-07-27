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
  CORE_SESSION_LOG_NO_ROW_RETURNED: "core.session_log.insert_no_row_returned",
  CORE_SESSION_POINTER_NO_ROW_RETURNED: "core.session_pointer.no_row_returned",
  CORE_PLACEMENT_UPSERT_NO_ROW_RETURNED: "core.placement.upsert_no_row_returned",
  CORE_PLACEMENT_SET_PINNED_NOT_FOUND: "core.placement.set_pinned_not_found",
  SESSION_REWIND_TARGET_OUT_OF_RANGE: "session.rewind.target_out_of_range",
  CORE_WORKFLOW_RUN_NO_ROW_RETURNED: "core.workflow_runs.no_row_returned",
  CORE_WORKFLOW_RUN_NOT_FOUND: "core.workflow_runs.not_found",
  CORE_RUN_NODE_OUTPUT_NO_ROW_RETURNED: "core.run_node_outputs.insert_no_row_returned",
  ENGINE_UNSUPPORTED_NODE_KIND: "engine.interpreter.unsupported_node_kind",
  ENGINE_DUPLICATE_NODE_ID: "engine.interpreter.duplicate_node_id",
  ENGINE_RUN_NOT_FOUND: "engine.interpreter.run_not_found",
  ENGINE_NODE_NOT_FOUND: "engine.interpreter.node_not_found",
  ENGINE_BINDING_KIND_NOT_SUPPORTED: "engine.bindings.kind_not_supported",
  ENGINE_NODE_OUTPUT_MISSING: "engine.bindings.step_output_missing",
  REGISTRY_VALIDATION_FAILED: "registry.registration.validation_failed",
  REGISTRY_TRUST_TIER_INVALID: "registry.trust_tier.invalid",
  REGISTRY_TRUST_TIER_UNKNOWN_DIGEST: "registry.trust_tier.unknown_digest",
  REGISTRY_SERVICE_IMAGE_UPSERT_NO_ROW_RETURNED: "registry.service_images.upsert_no_row_returned",
  // Package 0011 (docs/impl-plans/0011-worker-cli-dispatch.md).
  WORKER_AGENT_UNREACHABLE: "apps.worker.agent_client.unreachable",
  WORKER_INVOKE_REQUEST_REJECTED: "apps.worker.agent_client.invoke_request_rejected",
  WORKER_INVALID_ARG_FLAG_NAME: "apps.worker.dispatch.invalid_arg_flag_name",
  WORKER_UNSAFE_ARG_VALUE: "apps.worker.dispatch.unsafe_arg_value",
  WORKER_MALFORMED_INVOKE_OUTPUT: "apps.worker.dispatch.malformed_invoke_output",
  WORKER_EXECUTION_MISSING_RUN: "apps.worker.loop.execution_missing_run",
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
  [ERROR_IDS.CORE_SESSION_LOG_NO_ROW_RETURNED]:
    "Inserting a session log entry did not return the inserted row.",
  [ERROR_IDS.CORE_SESSION_POINTER_NO_ROW_RETURNED]:
    "Locking or updating a session pointer did not return a row.",
  [ERROR_IDS.CORE_PLACEMENT_UPSERT_NO_ROW_RETURNED]:
    "Upserting a placement access did not return the upserted row.",
  [ERROR_IDS.CORE_PLACEMENT_SET_PINNED_NOT_FOUND]:
    "Setting a placement's pinned residency found no existing row for that content hash.",
  [ERROR_IDS.SESSION_REWIND_TARGET_OUT_OF_RANGE]:
    "A session rewind's target sequence is negative or ahead of the session's current sequence.",
  [ERROR_IDS.CORE_WORKFLOW_RUN_NO_ROW_RETURNED]:
    "Creating or updating a workflow run did not return a row.",
  [ERROR_IDS.CORE_WORKFLOW_RUN_NOT_FOUND]: "No workflow run exists for the given id.",
  [ERROR_IDS.CORE_RUN_NODE_OUTPUT_NO_ROW_RETURNED]:
    "Recording a run node output did not return the inserted row.",
  [ERROR_IDS.ENGINE_UNSUPPORTED_NODE_KIND]:
    "submitRun only supports plain Step nodes (no kind) - branch/map nodes are task 6.2b, not yet implemented.",
  [ERROR_IDS.ENGINE_DUPLICATE_NODE_ID]:
    "A workflow spec's top-level steps must have unique ids - a repeated id was found.",
  [ERROR_IDS.ENGINE_RUN_NOT_FOUND]: "No workflow run exists for the given id.",
  [ERROR_IDS.ENGINE_NODE_NOT_FOUND]:
    "No node with the given id exists in this run's workflow spec.",
  [ERROR_IDS.ENGINE_BINDING_KIND_NOT_SUPPORTED]:
    "This binding kind is not yet resolvable by the plain-step interpreter (task 6.2b, not yet implemented).",
  [ERROR_IDS.ENGINE_NODE_OUTPUT_MISSING]:
    "A step binding referenced a dependency's output that has not been recorded yet.",
  [ERROR_IDS.REGISTRY_VALIDATION_FAILED]:
    "A registry registration payload failed schema/referential validation.",
  [ERROR_IDS.REGISTRY_TRUST_TIER_INVALID]:
    "The given trust tier is not one of the recognized values.",
  [ERROR_IDS.REGISTRY_TRUST_TIER_UNKNOWN_DIGEST]:
    "No registered image exists for the given digest - the runtime can only annotate trust on an image a developer already registered.",
  [ERROR_IDS.REGISTRY_SERVICE_IMAGE_UPSERT_NO_ROW_RETURNED]:
    "Upserting a service image did not return the upserted row.",
  [ERROR_IDS.WORKER_AGENT_UNREACHABLE]:
    "The exec-agent could not be reached - safe to retry (the transaction that claimed this execution is rolled back by the caller).",
  [ERROR_IDS.WORKER_INVOKE_REQUEST_REJECTED]:
    "The exec-agent rejected the Invoke request itself (a malformed request on our side) - not a transient condition.",
  [ERROR_IDS.WORKER_INVALID_ARG_FLAG_NAME]:
    "A step's resolved binding key is not a valid CLI flag name (must match ^[a-zA-Z][a-zA-Z0-9-]*$).",
  [ERROR_IDS.WORKER_UNSAFE_ARG_VALUE]:
    "A step's resolved binding value looks like a CLI flag itself (starts with '-') - refusing to dispatch to avoid argument injection into the invoked subprocess.",
  [ERROR_IDS.WORKER_MALFORMED_INVOKE_OUTPUT]:
    "The exec-agent's InvokeResponse.output was not a JSON object - this package cannot resolve it into a step's outputs.",
  [ERROR_IDS.WORKER_EXECUTION_MISSING_RUN]:
    "A claimed execution referenced a workflow run id that no longer exists.",
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
