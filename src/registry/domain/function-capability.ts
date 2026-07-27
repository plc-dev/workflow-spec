import type { MaterializationCostClass, StateReuse } from "../constants.js";
import type { InvocationDescriptorEntry } from "./invocation-descriptor.js";
import type { NestingDeclaration } from "./nesting-declaration.js";

// Per-(digest, function) capability metadata (design.md D5).
//
// invocationDescriptor/stateReuse/additiveWarmUpdate (design.md D17b):
// REQUIRED, not optional - every registered function must declare its
// own native CLI signature (Layer 2) and whether it may reuse local
// state across execs (Layer 3, opt-in, conservative default "none").
// This supersedes D17/D17a's single universal `--data-file`/`--state-id`
// shape; there is no fallback to that shape (a clean override, not a
// migration).
export interface FunctionCapability {
  digest: string;
  functionName: string;
  mutates: boolean;
  materializationCostClass: MaterializationCostClass;
  cowSupport: boolean;
  changeDetectionSupport: boolean;
  nestingDeclaration: NestingDeclaration | null;
  invocationDescriptor: InvocationDescriptorEntry[];
  stateReuse: StateReuse;
  additiveWarmUpdate: boolean;
}

// The capability shape a caller SUPPLIES (digest/functionName are the
// caller-provided keys a capability is stored/looked up under, not part
// of the capability data itself) - the canonical alias every input/
// composed-read shape in this module reuses, rather than each repeating
// `Omit<FunctionCapability, "digest" | "functionName">` independently
// (a real drift risk a local code review flagged - see
// docs/impl-plans/0008-shared-database-consolidation.md).
export type FunctionCapabilityInput = Omit<FunctionCapability, "digest" | "functionName">;
