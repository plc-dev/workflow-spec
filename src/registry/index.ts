// ADR-0006/0007: this barrel is the data-plane-safe read/validation
// surface of `registry/`. It deliberately does NOT re-export
// registerImage (admin.ts) or recordTrustTier (conformance.ts) - those
// are separately importable surfaces, reached only by importing
// `registry/admin.js`/`registry/conformance.js` directly. That omission
// IS the structural privilege split D12 requires, not an oversight - see
// docs/impl-plans/0007-registry.md's "Open questions".

export {
  MATERIALIZATION_COST_CLASSES,
  type MaterializationCostClass,
  NESTING_TRANSPORTS,
  type NestingTransport,
  TRUST_TIERS,
  type TrustTier,
} from "./constants.js";
export { createPool, type Queryable } from "./database/connection-pool.js";
export type {
  FunctionCapability,
  NestingDeclaration,
  PlacementFacts,
  RegistryEntry,
  ServiceImage,
} from "./domain/index.js";
export { getEntry } from "./get-entry.js";
export { getPlacementFacts } from "./get-placement-facts.js";
export {
  operationIdsFromOpenApi,
  validateRegistration,
  type ValidateRegistrationInput,
  validateTrustTier,
  type ValidationResult,
} from "./validate.js";
