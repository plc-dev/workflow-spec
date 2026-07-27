// Schema-level validation for registry entries (task 2.2).
//
// Hand-rolled rather than pulling in a JSON-Schema validator: the shape is
// small, fixed, and the most valuable check here - a REFERENTIAL check
// between the OpenAPI spec's declared operations and the capability-
// metadata function keys - is not expressible as pure JSON Schema anyway
// (it is a cross-field consistency rule). Promoted from
// `archive/registry/src/validate.js`.
//
// These are the DB-independent checks: enum constraints, required fields,
// well-formed nesting declarations, and the OpenAPI-vs-capability-metadata
// referential check. The Postgres CHECK constraints in schema.sql are a
// second, defense-in-depth layer for the enums; validating here gives a
// clear error BEFORE a round-trip and lets admin.ts reject bad input up
// front.

import {
  INVOCATION_FLAG_NAME_PATTERN,
  INVOCATION_STYLES,
  MATERIALIZATION_COST_CLASSES,
  NESTING_TRANSPORTS,
  STATE_REUSE_KINDS,
  TRUST_TIERS,
} from "./constants.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// Extract the set of operation names a given OpenAPI spec declares. The
// registry treats an operation's `operationId` as the canonical function
// name (that is what the CLI/MCP surfaces are projected from, per D9c).
// Accepts operationIds across all paths/methods.
export function operationIdsFromOpenApi(openapiSpec: unknown): Set<string> {
  const ids = new Set<string>();
  if (!openapiSpec || typeof openapiSpec !== "object") return ids;
  const paths = (openapiSpec as Record<string, unknown>).paths;
  if (!paths || typeof paths !== "object") return ids;
  for (const pathItem of Object.values(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const op of Object.values(pathItem as Record<string, unknown>)) {
      if (
        op &&
        typeof op === "object" &&
        typeof (op as Record<string, unknown>).operationId === "string"
      ) {
        ids.add((op as Record<string, unknown>).operationId as string);
      }
    }
  }
  return ids;
}

function validateNestingDeclaration(nesting: unknown, fnName: string, errors: string[]): void {
  if (nesting === null || nesting === undefined) return; // no nesting is valid
  if (typeof nesting !== "object" || Array.isArray(nesting)) {
    errors.push(`function "${fnName}": nestingDeclaration must be an object or null`);
    return;
  }
  const { via, targets } = nesting as Record<string, unknown>;
  if (!NESTING_TRANSPORTS.includes(via as (typeof NESTING_TRANSPORTS)[number])) {
    errors.push(
      `function "${fnName}": nestingDeclaration.via must be one of ${NESTING_TRANSPORTS.join(
        "|",
      )} (got ${JSON.stringify(via)})`,
    );
  }
  const targetsOk =
    targets === "open" || (Array.isArray(targets) && targets.every((t) => typeof t === "string"));
  if (!targetsOk) {
    errors.push(
      `function "${fnName}": nestingDeclaration.targets must be the string "open" or an array of strings`,
    );
  }
}

// design.md D17b, Layer 2 - a function's OWN native CLI signature for
// each heavy parameter it accepts. Validated structurally here (shape/
// enum/required-companion-field checks); this is deliberately NOT a
// mandated single shape (D17/D17a's old universal `--data-file <path>
// --state-id <key>` contract) - each entry describes whatever the
// service's real binary already does.
function validateInvocationDescriptor(descriptor: unknown, fnName: string, errors: string[]): void {
  if (!Array.isArray(descriptor)) {
    errors.push(`function "${fnName}": invocationDescriptor must be an array`);
    return;
  }
  const seenParams = new Set<string>();
  // Local-review fix: neither of these was tracked before, letting a
  // dispatch-time-only failure through registration:
  //  - two "positional" entries at the same positionIndex silently
  //    collapse (one overwrites the other) in apps/worker's dispatch.ts
  //    Map-based rendering - see that file's own defense-in-depth throw.
  //  - agent/'s execrunner.stdinSource only ever honors the FIRST
  //    "stdin"-style DataFile entry for a given Invoke call; a second
  //    one's materialized file is silently never delivered.
  const seenPositionIndexes = new Set<number>();
  let stdinEntryCount = 0;
  for (const entry of descriptor) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`function "${fnName}": every invocationDescriptor entry must be an object`);
      continue;
    }
    const { param, style, flagName, positionIndex } = entry as Record<string, unknown>;
    if (typeof param !== "string" || param.length === 0) {
      errors.push(
        `function "${fnName}": invocationDescriptor entry.param must be a non-empty string`,
      );
    } else if (seenParams.has(param)) {
      errors.push(
        `function "${fnName}": invocationDescriptor has a duplicate entry for param "${param}"`,
      );
    } else {
      seenParams.add(param);
    }
    if (!INVOCATION_STYLES.includes(style as (typeof INVOCATION_STYLES)[number])) {
      errors.push(
        `function "${fnName}": invocationDescriptor entry for param "${String(
          param,
        )}" has an invalid style (must be one of ${INVOCATION_STYLES.join("|")}, got ${JSON.stringify(
          style,
        )})`,
      );
      continue;
    }
    if (style === "flag") {
      if (typeof flagName !== "string" || flagName.length === 0) {
        errors.push(
          `function "${fnName}": invocationDescriptor entry for param "${String(
            param,
          )}" has style "flag" and requires a non-empty flagName`,
        );
      } else if (!INVOCATION_FLAG_NAME_PATTERN.test(flagName)) {
        errors.push(
          `function "${fnName}": invocationDescriptor entry for param "${String(
            param,
          )}" has flagName ${JSON.stringify(
            flagName,
          )}, which does not match ${INVOCATION_FLAG_NAME_PATTERN} (must be "--" followed by letters/digits/hyphens, starting with a letter - the exact shape agent/'s execrunner requires)`,
        );
      }
    }
    if (style === "positional") {
      if (
        typeof positionIndex !== "number" ||
        !Number.isInteger(positionIndex) ||
        positionIndex < 0
      ) {
        errors.push(
          `function "${fnName}": invocationDescriptor entry for param "${String(
            param,
          )}" has style "positional" and requires a non-negative integer positionIndex`,
        );
      } else if (seenPositionIndexes.has(positionIndex)) {
        errors.push(
          `function "${fnName}": invocationDescriptor has more than one "positional" entry at positionIndex ${positionIndex} (param "${String(
            param,
          )}") - each positional slot must be unique`,
        );
      } else {
        seenPositionIndexes.add(positionIndex);
      }
    }
    if (style === "stdin") {
      stdinEntryCount += 1;
    }
  }
  if (stdinEntryCount > 1) {
    errors.push(
      `function "${fnName}": invocationDescriptor declares ${stdinEntryCount} "stdin"-style entries - agent/'s exec-agent only ever delivers the FIRST to the subprocess's stdin, silently dropping the rest; at most one "stdin" entry is allowed`,
    );
  }
}

function validateCapability(fnName: string, cap: unknown, errors: string[]): void {
  if (typeof fnName !== "string" || fnName.length === 0) {
    errors.push("capability metadata has an empty/invalid function name");
  }
  if (!cap || typeof cap !== "object") {
    errors.push(`function "${fnName}": capability metadata must be an object`);
    return;
  }
  const c = cap as Record<string, unknown>;
  if (typeof c.mutates !== "boolean") {
    errors.push(`function "${fnName}": mutates must be a boolean`);
  }
  if (
    !MATERIALIZATION_COST_CLASSES.includes(
      c.materializationCostClass as (typeof MATERIALIZATION_COST_CLASSES)[number],
    )
  ) {
    errors.push(
      `function "${fnName}": materializationCostClass must be one of ${MATERIALIZATION_COST_CLASSES.join(
        "|",
      )} (got ${JSON.stringify(c.materializationCostClass)})`,
    );
  }
  if (typeof c.cowSupport !== "boolean") {
    errors.push(`function "${fnName}": cowSupport must be a boolean`);
  }
  if (typeof c.changeDetectionSupport !== "boolean") {
    errors.push(`function "${fnName}": changeDetectionSupport must be a boolean`);
  }
  validateNestingDeclaration(c.nestingDeclaration, fnName, errors);

  // design.md D17b - REQUIRED, no fallback to D17/D17a's old universal
  // shape (a clean override, not a migration).
  validateInvocationDescriptor(c.invocationDescriptor, fnName, errors);

  if (!STATE_REUSE_KINDS.includes(c.stateReuse as (typeof STATE_REUSE_KINDS)[number])) {
    errors.push(
      `function "${fnName}": stateReuse must be one of ${STATE_REUSE_KINDS.join(
        "|",
      )} (got ${JSON.stringify(c.stateReuse)})`,
    );
  }
  if (typeof c.additiveWarmUpdate !== "boolean") {
    errors.push(`function "${fnName}": additiveWarmUpdate must be a boolean`);
  } else if (c.additiveWarmUpdate && c.stateReuse !== "stateIdKeyed") {
    errors.push(
      `function "${fnName}": additiveWarmUpdate is only meaningful when stateReuse is "stateIdKeyed"`,
    );
  }
  // A state-reusing function must declare at least one heavy binding it
  // actually reuses state for - stateReuse with no invocationDescriptor
  // entries is a contradiction (nothing to key state off of).
  if (
    c.stateReuse === "stateIdKeyed" &&
    Array.isArray(c.invocationDescriptor) &&
    c.invocationDescriptor.length === 0
  ) {
    errors.push(
      `function "${fnName}": stateReuse "stateIdKeyed" requires at least one invocationDescriptor entry`,
    );
  }

  // design.md D17b: only "flag" and "stdin" style entries are rendered via
  // agent/'s DataFile struct, the ONLY wire shape that carries a stateId.
  // "positional" heavy bindings go over InvokeRequest.PositionalArgs (a
  // bare string list, no per-entry metadata) - there is no wire channel
  // for a state-id on a positional argument, and omitting one on a warm
  // hit would silently shift every LATER positional argument's index. A
  // "stateIdKeyed" function must not declare a "positional" entry.
  if (c.stateReuse === "stateIdKeyed" && Array.isArray(c.invocationDescriptor)) {
    const positionalParams = (c.invocationDescriptor as Record<string, unknown>[])
      .filter((entry) => entry && typeof entry === "object" && entry.style === "positional")
      .map((entry) => entry.param);
    if (positionalParams.length > 0) {
      errors.push(
        `function "${fnName}": stateReuse "stateIdKeyed" is not supported for "positional"-style invocationDescriptor entries (${positionalParams.join(
          ", ",
        )}) - no wire channel carries a state-id for a positional argument; use "flag" or "stdin" instead`,
      );
    }
  }
}

export interface ValidateRegistrationInput {
  digest?: unknown;
  ociRef?: unknown;
  openapiSpec?: unknown;
  capabilityMetadata?: unknown;
  hardwareRequirements?: unknown;
}

// Validate a full registerImage payload. capabilityMetadata is an object
// keyed by function name.
export function validateRegistration({
  digest,
  ociRef,
  openapiSpec,
  capabilityMetadata,
  hardwareRequirements,
}: ValidateRegistrationInput = {}): ValidationResult {
  const errors: string[] = [];

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
    errors.push("capabilityMetadata is required and must be an object keyed by function name");
    return { valid: false, errors };
  }

  for (const [fnName, cap] of Object.entries(capabilityMetadata as Record<string, unknown>)) {
    validateCapability(fnName, cap, errors);
  }

  // REFERENTIAL CHECK (the core of 2.2): every function given capability
  // metadata MUST be declared as an operation in the OpenAPI spec. Reject
  // capability metadata that references a function the contract does not
  // expose - that is exactly the kind of drift the "sole stored contract"
  // rule (D12) exists to prevent.
  if (openapiSpec && typeof openapiSpec === "object") {
    const declared = operationIdsFromOpenApi(openapiSpec);
    for (const fnName of Object.keys(capabilityMetadata as Record<string, unknown>)) {
      if (!declared.has(fnName)) {
        errors.push(
          `capability metadata references function "${fnName}", which is not declared as an operationId in openapiSpec (declared: ${
            [...declared].join(", ") || "<none>"
          })`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateTrustTier(tier: unknown): ValidationResult {
  const errors: string[] = [];
  if (!TRUST_TIERS.includes(tier as (typeof TRUST_TIERS)[number])) {
    errors.push(`trust tier must be one of ${TRUST_TIERS.join("|")} (got ${JSON.stringify(tier)})`);
  }
  return { valid: errors.length === 0, errors };
}
