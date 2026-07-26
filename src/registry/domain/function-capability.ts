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
