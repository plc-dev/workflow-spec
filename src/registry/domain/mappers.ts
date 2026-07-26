import type { FunctionCapability } from "./function-capability.js";
import type { FunctionCapabilityRow, ServiceImageRow } from "./rows.js";
import type { ServiceImage } from "./service-image.js";

export function mapServiceImageRow(row: ServiceImageRow): ServiceImage {
  return {
    digest: row.digest,
    ociRef: row.oci_ref,
    openapiSpec: row.openapi_spec,
    hardwareRequirements: row.hardware_requirements,
    trustTier: row.trust_tier,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

export function mapFunctionCapabilityRow(row: FunctionCapabilityRow): FunctionCapability {
  return {
    digest: row.digest,
    functionName: row.function_name,
    mutates: row.mutates,
    materializationCostClass: row.materialization_cost_class,
    cowSupport: row.cow_support,
    changeDetectionSupport: row.change_detection_support,
    nestingDeclaration: row.nesting_declaration,
  };
}
