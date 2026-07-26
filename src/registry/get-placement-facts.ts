import type { Queryable } from "../shared/index.js";
import {
  type FunctionCapabilityRow,
  type PlacementFacts,
  type ServiceImageRow,
  mapFunctionCapabilityRow,
  mapServiceImageRow,
} from "./domain/index.js";
import { SQL_GET_PLACEMENT_FACTS } from "./repositories/queries/get-placement-facts.queries.js";

// `si.*, fc.*` (see the query's own comment) means a joined row satisfies
// BOTH row shapes at once - reusing rows.ts/mappers.ts's canonical
// mappers here (rather than a third, hand-rolled row shape/mapping) is
// what keeps this query's result shape mechanically pinned to
// getEntry's, so a field added to FunctionCapability/ServiceImage can't
// silently go missing from just this one read path.
type PlacementFactsRow = ServiceImageRow & FunctionCapabilityRow;

// getPlacementFacts(digest, functionName) - task 2.8.
//
// ONE SQL query (a JOIN across the per-image and per-function tables), NOT
// multiple round-trips composed in application code. A single statement is
// evaluated against a single MVCC snapshot, so the three fact categories
// (capability metadata, trust tier, hardware requirements) are inherently
// consistent with one another - a concurrent recordTrustTier either lands
// entirely before or entirely after this read, never in the middle.
export async function getPlacementFacts(
  pool: Queryable,
  digest: string,
  functionName: string,
): Promise<PlacementFacts | null> {
  const result = await pool.query<PlacementFactsRow>(SQL_GET_PLACEMENT_FACTS, [
    digest,
    functionName,
  ]);
  const row = result.rows[0];
  if (!row) return null;

  const image = mapServiceImageRow(row);
  const capability = mapFunctionCapabilityRow(row);

  return {
    digest: capability.digest,
    function: capability.functionName,
    capability: {
      mutates: capability.mutates,
      materializationCostClass: capability.materializationCostClass,
      cowSupport: capability.cowSupport,
      changeDetectionSupport: capability.changeDetectionSupport,
      nestingDeclaration: capability.nestingDeclaration,
    },
    trustTier: image.trustTier,
    hardwareRequirements: image.hardwareRequirements,
  };
}
