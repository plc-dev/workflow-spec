// PLATFORM-DEVELOPER-ONLY write path (design.md D12).
//
// This module exports ONLY registerImage. The privilege split from D12 is
// modeled STRUCTURALLY, not by a runtime permission flag: registering a new
// image lives in its own module, so a hypothetical runtime-facing module
// (the workflow platform / scheduler) simply has nothing to import that
// would let it introduce a new image. The set of invocable images is
// entirely developer-curated; see conformance.js for the runtime's ONLY
// authority over that set (annotating trust on top of an already-registered
// image).
//
// There is deliberately no generic `update()` here gated by a permission
// check - the boundary IS the module boundary.

import { validateRegistration } from "./validate.js";

// registerImage(...) - insert (or replace) a per-image registry entry plus
// its per-function capability rows, atomically. Defaults trust_tier to
// 'unverified' (D5a): the scheduler leans on no capability declaration until
// a build has earned 'production-proven' through conformance.
//
// capabilityMetadata: object keyed by function name, each value:
//   { mutates: bool,
//     materializationCostClass: "negligible"|"heavy",
//     cowSupport: bool,
//     changeDetectionSupport: bool,
//     nestingDeclaration: { via, targets } | null }
//
// hardwareRequirements: free-form per-IMAGE object, e.g.
//   { cpu: "2", mem: "4Gi", gpu: 0, nodeClass: "standard" }
// stored as JSONB, deliberately OUTSIDE the trust-tier model (D12).
export async function registerImage(
  pool,
  {
    digest,
    openapiSpec,
    capabilityMetadata = {},
    hardwareRequirements = {},
    nestingDeclaration, // optional convenience; per-function nesting lives in capabilityMetadata
    ociRef,
  } = {}
) {
  const { valid, errors } = validateRegistration({
    digest,
    ociRef,
    openapiSpec,
    capabilityMetadata,
    hardwareRequirements,
  });
  if (!valid) {
    const err = new Error(
      `registerImage validation failed:\n  - ${errors.join("\n  - ")}`
    );
    err.validationErrors = errors;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // The per-image entry. On conflict we replace it wholesale (a redeploy
    // to the SAME digest is degenerate since digests are content-addressed,
    // but making register idempotent keeps tests and re-registration clean).
    // Trust tier is intentionally NOT set here on conflict beyond the
    // default: register never touches trust (that is conformance.js's job).
    await client.query(
      `INSERT INTO registry.service_images
         (digest, oci_ref, openapi_spec, hardware_requirements)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (digest) DO UPDATE
         SET oci_ref = EXCLUDED.oci_ref,
             openapi_spec = EXCLUDED.openapi_spec,
             hardware_requirements = EXCLUDED.hardware_requirements,
             updated_at = now()`,
      [digest, ociRef, openapiSpec, hardwareRequirements]
    );

    // Replace the function rows for this digest.
    await client.query(
      `DELETE FROM registry.function_capabilities WHERE digest = $1`,
      [digest]
    );

    for (const [functionName, cap] of Object.entries(capabilityMetadata)) {
      await client.query(
        `INSERT INTO registry.function_capabilities
           (digest, function_name, mutates, materialization_cost_class,
            cow_support, change_detection_support, nesting_declaration)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          digest,
          functionName,
          cap.mutates,
          cap.materializationCostClass,
          cap.cowSupport,
          cap.changeDetectionSupport,
          cap.nestingDeclaration ?? null,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return { digest, trustTier: "unverified" };
}
