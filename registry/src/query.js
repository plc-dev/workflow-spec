// Read paths for the service registry.
//
// D12 splits reads by consistency need:
//   - Authoring-time reads (getEntry) are interactive/cacheable: existence
//     and signature lookups for DSL validation and discovery.
//   - Dispatch-time reads (getPlacementFacts) are hot-path and
//     correctness-critical: capability metadata, trust tier, and hardware
//     requirements must come back as ONE atomic read so the scheduler never
//     sees them skewed relative to one another (e.g. a trust demotion
//     landing between two separate reads).

// getPlacementFacts(digest, functionName) - task 2.8.
//
// ONE SQL query (a JOIN across the per-image and per-function tables), NOT
// multiple round-trips composed in application code. A single statement is
// evaluated against a single MVCC snapshot, so the three fact categories
// (capability metadata, trust tier, hardware requirements) are inherently
// consistent with one another - a concurrent recordTrustTier either lands
// entirely before or entirely after this read, never in the middle.
export async function getPlacementFacts(pool, digest, functionName) {
  const { rows } = await pool.query(
    `SELECT
        si.digest,
        si.trust_tier,
        si.hardware_requirements,
        fc.function_name,
        fc.mutates,
        fc.materialization_cost_class,
        fc.cow_support,
        fc.change_detection_support,
        fc.nesting_declaration
     FROM registry.service_images si
     JOIN registry.function_capabilities fc
       ON fc.digest = si.digest
     WHERE si.digest = $1
       AND fc.function_name = $2`,
    [digest, functionName]
  );

  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    digest: r.digest,
    function: r.function_name,
    // capability metadata (per-function, D5)
    capability: {
      mutates: r.mutates,
      materializationCostClass: r.materialization_cost_class,
      cowSupport: r.cow_support,
      changeDetectionSupport: r.change_detection_support,
      nestingDeclaration: r.nesting_declaration,
    },
    // trust tier (per-digest, D5a)
    trustTier: r.trust_tier,
    // hardware requirements (per-image, OUTSIDE the trust model, D12)
    hardwareRequirements: r.hardware_requirements,
  };
}

// getEntry(digest) - authoring-time read: the full per-image entry plus all
// of its per-function capability rows. Not consistency-critical (D12), used
// for discovery / DSL validation.
export async function getEntry(pool, digest) {
  const { rows: imageRows } = await pool.query(
    `SELECT digest, oci_ref, openapi_spec, hardware_requirements,
            trust_tier, registered_at, updated_at
       FROM registry.service_images
      WHERE digest = $1`,
    [digest]
  );
  if (imageRows.length === 0) return null;

  const { rows: fnRows } = await pool.query(
    `SELECT function_name, mutates, materialization_cost_class,
            cow_support, change_detection_support, nesting_declaration
       FROM registry.function_capabilities
      WHERE digest = $1
      ORDER BY function_name`,
    [digest]
  );

  const image = imageRows[0];
  const functions = {};
  for (const fn of fnRows) {
    functions[fn.function_name] = {
      mutates: fn.mutates,
      materializationCostClass: fn.materialization_cost_class,
      cowSupport: fn.cow_support,
      changeDetectionSupport: fn.change_detection_support,
      nestingDeclaration: fn.nesting_declaration,
    };
  }

  return {
    digest: image.digest,
    ociRef: image.oci_ref,
    openapiSpec: image.openapi_spec,
    hardwareRequirements: image.hardware_requirements,
    trustTier: image.trust_tier,
    registeredAt: image.registered_at,
    updatedAt: image.updated_at,
    functions,
  };
}
