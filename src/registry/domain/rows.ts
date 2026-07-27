import type { MaterializationCostClass, StateReuse, TrustTier } from "../constants.js";
import type { InvocationDescriptorEntry } from "./invocation-descriptor.js";
import type { NestingDeclaration } from "./nesting-declaration.js";

// Raw `pg` row shapes (snake_case, as Postgres returns them) - kept
// separate from the camelCase domain types so the mapping between them
// lives in exactly one place (mappers.ts). Mirrors core/domain/rows.ts.
export interface ServiceImageRow {
  digest: string;
  oci_ref: string;
  openapi_spec: Record<string, unknown>;
  hardware_requirements: Record<string, unknown>;
  trust_tier: TrustTier;
  registered_at: Date;
  updated_at: Date;
}

export interface FunctionCapabilityRow {
  digest: string;
  function_name: string;
  mutates: boolean;
  materialization_cost_class: MaterializationCostClass;
  cow_support: boolean;
  change_detection_support: boolean;
  nesting_declaration: NestingDeclaration | null;
  invocation_descriptor: InvocationDescriptorEntry[];
  state_reuse: StateReuse;
  additive_warm_update: boolean;
}
