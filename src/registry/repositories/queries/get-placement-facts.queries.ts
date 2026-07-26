// Named SQL query constant (`SQL_` prefix, ADR-0012/best-practices §2).
//
// Deliberately lives outside service-images.queries.ts/function-
// capabilities.queries.ts and is never composed from the two per-table
// repositories: task 2.8/D12 requires capability metadata, trust tier, and
// hardware requirements to come back as ONE atomic read (one MVCC
// snapshot), so a concurrent recordTrustTier either lands entirely before
// or entirely after this read, never in the middle. Decomposing this into
// two repository calls would silently reintroduce the two-round-trip skew
// risk this query exists to prevent.
// `si.*, fc.*` (not an explicit column list) so this query's shape stays
// mechanically in sync with rows.ts/mappers.ts - the same
// `ServiceImageRow`/`FunctionCapabilityRow` shapes and
// `mapServiceImageRow`/`mapFunctionCapabilityRow` mappers every other read
// path uses, rather than a third, hand-maintained column list that could
// silently drift (e.g. a new FunctionCapability field landing in `rows.ts`/
// `mappers.ts` but never added to an explicit SELECT here, so
// getPlacementFacts would return it as undefined). Both tables' `digest`
// column comes back as one column since they're always equal for a joined
// row (enforced by the ON clause) - see get-placement-facts.ts.
export const SQL_GET_PLACEMENT_FACTS = `
  SELECT si.*, fc.*
    FROM service_images si
    JOIN function_capabilities fc
      ON fc.digest = si.digest
   WHERE si.digest = $1
     AND fc.function_name = $2
`;
