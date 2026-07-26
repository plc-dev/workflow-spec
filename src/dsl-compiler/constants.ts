// ADR-0012: module-wide named constants live here, not inlined at call
// sites (implementation-best-practices.md #3 - no magic numbers/strings).

import type { CompileErrorCode } from "./domain/compile-result.js";

/** Every `CompileErrorCode` this module ever produces, named once so
 * `compile.ts`/`restricted-yaml.ts`/`semantic-validation.ts`/
 * `registry-validation.ts` all construct `CompileError`s from this single
 * source rather than repeating the string literals independently. */
export const COMPILE_ERROR_CODES: Record<CompileErrorCode, CompileErrorCode> = {
  restricted_yaml_violation: "restricted_yaml_violation",
  schema_invalid: "schema_invalid",
  duplicate_step_id: "duplicate_step_id",
  unresolved_step_reference: "unresolved_step_reference",
  internal_step_id_referenced_externally: "internal_step_id_referenced_externally",
  unknown_service_digest: "unknown_service_digest",
  unknown_service_function: "unknown_service_function",
};

/** D8a: the literal YAML 1.1 merge-key string this profile bans. The
 * `yaml` package only *expands* `<<:` into its target mapping when its
 * `merge` parse option is explicitly enabled (never passed by this
 * module) - left un-expanded, a merge key otherwise silently survives as
 * an ordinary-looking `"<<"` map key, which is what this constant lets
 * `restricted-yaml.ts` detect directly. */
export const YAML_MERGE_KEY = "<<";

/** Path used for the single whole-document `CompileError` a restricted-
 * YAML profile violation produces - there is no one owning step id for
 * "this document used an anchor/alias/merge-key/custom-tag somewhere". */
export const WHOLE_DOCUMENT_ERROR_PATH = "";
