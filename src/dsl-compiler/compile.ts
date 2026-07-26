// Task 5.2 (docs/impl-plans/0009-dsl-compiler-plain-steps.md), design.md
// D8/D8a/D8c/D12. Orchestrates this package's four validation stages in
// order, short-circuiting once a stage produces errors (each later stage
// assumes the document already passed every earlier one - see the plan
// doc's "Data flow inside compile()").

import type { Queryable } from "../shared/index.js";
import { validate } from "../workflow-spec/index.js";
import type { ExecutionPlan, WorkflowSpec } from "../workflow-spec/index.js";
import { COMPILE_ERROR_CODES } from "./constants.js";
import type { CompileError, CompileResult } from "./domain/compile-result.js";
import { validateServiceReferences } from "./registry-validation.js";
import { parseRestrictedYaml } from "./restricted-yaml.js";
import { validateStepReferences } from "./semantic-validation.js";

function failed(errors: CompileError[]): CompileResult {
  return { ok: false, errors };
}

/**
 * Compiles authoring-surface input into an `ExecutionPlan`.
 *
 * `input` is either restricted-YAML source (a `string` - see
 * `restricted-yaml.ts`) or an already-parsed document (any other value,
 * e.g. raw JSON already loaded by the caller - see the plan doc's "Open
 * questions" for why only `string` input goes through the restricted-
 * profile check).
 *
 * `deps.registryPool` is required, not optional - task 5.3's registry
 * check is in-scope work this function always performs, never a
 * best-effort extra a caller can opt out of.
 *
 * Never throws for an invalid *document* - returns `{ ok: false, errors }`
 * for every rejection this pipeline's four stages can produce. A genuine
 * infrastructure failure (e.g. the registry pool's own connection
 * erroring) propagates uncaught, exactly as `registry/getEntry` already
 * does on its own - this function adds no additional fault-tolerance
 * behavior around it.
 */
export async function compile(
  input: string | unknown,
  deps: { registryPool: Queryable },
): Promise<CompileResult> {
  let doc: unknown;
  if (typeof input === "string") {
    const parsed = parseRestrictedYaml(input);
    if (!parsed.ok) return failed(parsed.errors);
    doc = parsed.doc;
  } else {
    doc = input;
  }

  const schemaResult = validate(doc);
  if (!schemaResult.valid) {
    return failed(
      schemaResult.errors.map((error) => ({
        code: COMPILE_ERROR_CODES.schema_invalid,
        path: error.path,
        message: error.message,
      })),
    );
  }

  // Safe: `validate()` just confirmed `doc` conforms to the WorkflowSpec
  // JSON Schema - this is the one place in this module that trusts that
  // conformance rather than re-deriving it structurally.
  const spec = doc as WorkflowSpec;

  const semanticErrors = validateStepReferences(spec);
  if (semanticErrors.length > 0) return failed(semanticErrors);

  const registryErrors = await validateServiceReferences(spec, deps.registryPool);
  if (registryErrors.length > 0) return failed(registryErrors);

  return { ok: true, executionPlan: spec as ExecutionPlan };
}
