// Schema-level validation for registry entries (task 2.2).
//
// Hand-rolled rather than pulling in a JSON-Schema validator: the shape is
// small, fixed, and the most valuable check here - a REFERENTIAL check
// between the OpenAPI spec's declared operations and the capability-metadata
// function keys - is not expressible as pure JSON Schema anyway (it is a
// cross-field consistency rule). Keeping it dependency-light also matches
// the small-focused-module convention from spike 1.2.
//
// These are the DB-independent checks: enum constraints, required fields,
// well-formed nesting declarations, and the OpenAPI-vs-capability-metadata
// referential check. The Postgres CHECK constraints in schema.sql are a
// second, defense-in-depth layer for the enums; validating here gives a
// clear error BEFORE a round-trip and lets admin.js reject bad input up
// front.

export const MATERIALIZATION_COST_CLASSES = ["negligible", "heavy"];
export const TRUST_TIERS = [
  "unverified",
  "conformance-passed",
  "production-proven",
];
export const NESTING_TRANSPORTS = ["sdk", "http", "cli", "mcp"];

// Extract the set of operation names a given OpenAPI spec declares. The
// registry treats an operation's `operationId` as the canonical function
// name (that is what the CLI/MCP surfaces are projected from per D9c). We
// accept operationIds across all paths/methods.
export function operationIdsFromOpenApi(openapiSpec) {
  const ids = new Set();
  if (!openapiSpec || typeof openapiSpec !== "object") return ids;
  const paths = openapiSpec.paths;
  if (!paths || typeof paths !== "object") return ids;
  for (const pathItem of Object.values(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const op of Object.values(pathItem)) {
      if (op && typeof op === "object" && typeof op.operationId === "string") {
        ids.add(op.operationId);
      }
    }
  }
  return ids;
}

function validateNestingDeclaration(nesting, fnName, errors) {
  if (nesting === null || nesting === undefined) return; // no nesting is valid
  if (typeof nesting !== "object" || Array.isArray(nesting)) {
    errors.push(
      `function "${fnName}": nesting_declaration must be an object or null`
    );
    return;
  }
  if (!NESTING_TRANSPORTS.includes(nesting.via)) {
    errors.push(
      `function "${fnName}": nesting_declaration.via must be one of ${NESTING_TRANSPORTS.join(
        "|"
      )} (got ${JSON.stringify(nesting.via)})`
    );
  }
  const targets = nesting.targets;
  const targetsOk =
    targets === "open" ||
    (Array.isArray(targets) && targets.every((t) => typeof t === "string"));
  if (!targetsOk) {
    errors.push(
      `function "${fnName}": nesting_declaration.targets must be the string "open" or an array of strings`
    );
  }
}

function validateCapability(fnName, cap, errors) {
  if (typeof fnName !== "string" || fnName.length === 0) {
    errors.push(`capability metadata has an empty/invalid function name`);
  }
  if (!cap || typeof cap !== "object") {
    errors.push(`function "${fnName}": capability metadata must be an object`);
    return;
  }
  if (typeof cap.mutates !== "boolean") {
    errors.push(`function "${fnName}": mutates must be a boolean`);
  }
  if (!MATERIALIZATION_COST_CLASSES.includes(cap.materializationCostClass)) {
    errors.push(
      `function "${fnName}": materializationCostClass must be one of ${MATERIALIZATION_COST_CLASSES.join(
        "|"
      )} (got ${JSON.stringify(cap.materializationCostClass)})`
    );
  }
  if (typeof cap.cowSupport !== "boolean") {
    errors.push(`function "${fnName}": cowSupport must be a boolean`);
  }
  if (typeof cap.changeDetectionSupport !== "boolean") {
    errors.push(`function "${fnName}": changeDetectionSupport must be a boolean`);
  }
  validateNestingDeclaration(cap.nestingDeclaration, fnName, errors);
}

// Validate a full registerImage payload. `capabilityMetadata` is an object
// keyed by function name. Returns { valid, errors }.
export function validateRegistration({
  digest,
  ociRef,
  openapiSpec,
  capabilityMetadata,
  hardwareRequirements,
} = {}) {
  const errors = [];

  if (typeof digest !== "string" || digest.length === 0) {
    errors.push("digest is required and must be a non-empty string");
  }
  if (typeof ociRef !== "string" || ociRef.length === 0) {
    errors.push("ociRef is required and must be a non-empty string");
  }
  if (!openapiSpec || typeof openapiSpec !== "object") {
    errors.push("openapiSpec is required and must be an object");
  }
  if (
    hardwareRequirements !== undefined &&
    (hardwareRequirements === null ||
      typeof hardwareRequirements !== "object" ||
      Array.isArray(hardwareRequirements))
  ) {
    errors.push("hardwareRequirements must be an object when provided");
  }
  if (
    !capabilityMetadata ||
    typeof capabilityMetadata !== "object" ||
    Array.isArray(capabilityMetadata)
  ) {
    errors.push(
      "capabilityMetadata is required and must be an object keyed by function name"
    );
    return { valid: false, errors };
  }

  for (const [fnName, cap] of Object.entries(capabilityMetadata)) {
    validateCapability(fnName, cap, errors);
  }

  // REFERENTIAL CHECK (the core of 2.2): every function given capability
  // metadata MUST be declared as an operation in the OpenAPI spec. Reject
  // capability metadata that references a function the contract does not
  // expose - that is exactly the kind of drift the "sole stored contract"
  // rule (D12) exists to prevent.
  if (openapiSpec && typeof openapiSpec === "object") {
    const declared = operationIdsFromOpenApi(openapiSpec);
    for (const fnName of Object.keys(capabilityMetadata)) {
      if (!declared.has(fnName)) {
        errors.push(
          `capability metadata references function "${fnName}", which is not declared as an operationId in openapi_spec (declared: ${
            [...declared].join(", ") || "<none>"
          })`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateTrustTier(tier) {
  const errors = [];
  if (!TRUST_TIERS.includes(tier)) {
    errors.push(
      `trust tier must be one of ${TRUST_TIERS.join("|")} (got ${JSON.stringify(
        tier
      )})`
    );
  }
  return { valid: errors.length === 0, errors };
}
