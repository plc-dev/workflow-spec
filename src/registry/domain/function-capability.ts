import type { MaterializationCostClass } from "../constants.js";
import type { NestingDeclaration } from "./nesting-declaration.js";

// Per-(digest, function) capability metadata (design.md D5).
export interface FunctionCapability {
  digest: string;
  functionName: string;
  mutates: boolean;
  materializationCostClass: MaterializationCostClass;
  cowSupport: boolean;
  changeDetectionSupport: boolean;
  nestingDeclaration: NestingDeclaration | null;
}

// The capability shape a caller SUPPLIES (digest/functionName are the
// caller-provided keys a capability is stored/looked up under, not part
// of the capability data itself) - the canonical alias every input/
// composed-read shape in this module reuses, rather than each repeating
// `Omit<FunctionCapability, "digest" | "functionName">` independently
// (a real drift risk a local code review flagged - see
// docs/impl-plans/0008-shared-database-consolidation.md).
export type FunctionCapabilityInput = Omit<FunctionCapability, "digest" | "functionName">;
