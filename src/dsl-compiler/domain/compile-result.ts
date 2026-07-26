// docs/impl-plans/0009-dsl-compiler-plain-steps.md - the compiler's own
// result/error shape. Mirrors `workflow-spec/validate()`'s
// never-throws-for-an-invalid-document contract (ValidationResult), not
// `shared/errors.ts`'s thrown-PlatformError taxonomy - these are expected,
// recoverable authoring-input rejections, not exceptional platform
// failures (see the plan doc's "New error/constant surface" note).

import type { ExecutionPlan } from "../../workflow-spec/index.js";

/** One compile-time rejection reason. Each member maps 1:1 to one of this
 * package's four validation stages (restricted-YAML parse, JSON Schema,
 * document-wide semantic checks, registry checks) - see the plan doc's
 * "Data flow inside compile()". */
export type CompileErrorCode =
  | "restricted_yaml_violation"
  | "schema_invalid"
  | "duplicate_step_id"
  | "unresolved_step_reference"
  | "internal_step_id_referenced_externally"
  | "unknown_service_digest"
  | "unknown_service_function";

export interface CompileError {
  code: CompileErrorCode;
  /** A step id, an ajv instancePath, or "" for a whole-document error
   * (e.g. a restricted-YAML profile violation with no single owning
   * step). */
  path: string;
  message: string;
}

export type CompileResult =
  | { ok: true; executionPlan: ExecutionPlan }
  | { ok: false; errors: CompileError[] };
