// design.md D8/D8a/D8c/D16: schema validation of an already-parsed
// WorkflowSpec document (JSON or already-parsed YAML - the restricted-
// YAML profile itself is a future dsl-compiler/'s job, not this
// package's - see docs/impl-plans/0004-workflow-spec-schema.md).

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { WORKFLOW_SPEC_JSON_SCHEMA } from "./constants.js";

export interface ValidationError {
  /** ajv instancePath, e.g. "/steps/0/service". */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/** Error id used for the one ValidationError this module ever fabricates
 * itself, rather than relaying ajv's own - see `validate()`'s recursion
 * guard below. */
const ERROR_ID_MAX_NESTING_DEPTH_EXCEEDED = "workflow-spec.validate.max_nesting_depth_exceeded";

// Compiled lazily, on the first call to validate() - not at module load.
// Local-review fix: this module is re-exported from `workflow-spec/`'s
// barrel, which other modules (e.g. `engine/`, via `workflow-spec/
// binding-refs.ts`'s promotion) import at runtime for reasons that have
// nothing to do with schema validation. An eager, module-load-time
// `ajv.compile(...)` meant every such importer paid this compile (and
// inherited its crash surface) on process startup, even when nothing it
// does ever calls `validate()`. Memoized here so the cost/risk is paid
// only by an actual caller of `validate()`, exactly once. validate()
// itself remains a cheap, synchronous call once compiled - no
// scheduling/registry/placement involvement (D10's own framing for
// `compute` applies equally well to schema validation: pure, in-memory,
// free to call after this one-time compile).
let cachedValidateFn: ValidateFunction | undefined;
function getValidateFn(): ValidateFunction {
  if (!cachedValidateFn) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    cachedValidateFn = ajv.compile(WORKFLOW_SPEC_JSON_SCHEMA);
  }
  return cachedValidateFn;
}

function toValidationError(error: ErrorObject): ValidationError {
  return {
    path: error.instancePath,
    message: error.message ?? "Schema validation failed with no message.",
  };
}

/**
 * Validates the parsed document structure against the workflow-spec
 * JSON Schema. Never throws on an invalid document - returns
 * `{ valid: false, errors }`
 * so callers (a future dsl-compiler/, a future workflow-spec store)
 * decide what to do with an invalid document.
 *
 * The `Binding` schema is recursive (`compute.using` and
 * `itemResource.itemId` both recurse into `#/$defs/binding`), so an
 * adversarially deep-but-small document can exhaust the call stack of
 * ajv's generated recursive validator. That would otherwise surface as an
 * uncaught `RangeError`, breaking this function's own never-throws
 * contract for exactly the kind of untrusted external input it exists to
 * check - caught here and reported as an ordinary validation failure
 * instead.
 */
export function validate(doc: unknown): ValidationResult {
  const validateFn = getValidateFn();
  let valid: boolean;
  try {
    // The schema has no $async keyword, so validateFn(doc) is always
    // synchronous - the boolean|Promise union in ajv's own type is for
    // schemas that opt into async validation, which this one never does.
    valid = validateFn(doc) as boolean;
  } catch (error) {
    if (error instanceof RangeError) {
      return {
        valid: false,
        errors: [
          {
            path: "",
            message: `${ERROR_ID_MAX_NESTING_DEPTH_EXCEEDED}: document exceeds the maximum supported binding-nesting depth`,
          },
        ],
      };
    }
    throw error;
  }
  if (valid) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: (validateFn.errors ?? []).map(toValidationError),
  };
}
