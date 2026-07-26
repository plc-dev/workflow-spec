// ADR-0012: this module's public surface - re-exports only, no logic.

export { CURRENT_WORKFLOW_SPEC_VERSION, JSON_SCHEMA_ID } from "./constants.js";

export type {
  Binding,
  StaticBinding,
  SessionBinding,
  RequestBinding,
  StepBinding,
  ItemBinding,
  LiteralBinding,
  ComputeBinding,
  ItemResourceBinding,
} from "./domain/binding.js";
export type { Node, Step, BranchNode, MapNode, CaseBody } from "./domain/node.js";
export type { SessionStateDeclaration } from "./domain/session-state.js";
export type { SessionWriteTarget } from "./domain/write-target.js";
export type { SecretRef } from "./domain/secret-ref.js";
export type { WorkflowSpec, ExecutionPlan } from "./domain/workflow-spec.js";
export type {
  LogicExpression,
  Urn,
  JsonPointer,
  OciDigestRef,
} from "./domain/placeholder-types.js";

export { validate } from "./validate.js";
export type { ValidationError, ValidationResult } from "./validate.js";
