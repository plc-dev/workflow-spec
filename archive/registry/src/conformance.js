// WORKFLOW-PLATFORM write path (design.md D12 / D5a).
//
// This module exports ONLY recordTrustTier. It models the workflow
// platform's own conformance/CI pipeline (tasks 2.4-2.7): the runtime may
// promote or demote the trust tier of an ALREADY-REGISTERED image, but has
// no way to register a new image (registerImage lives in admin.js and is
// not imported here). This is the structural half of D12's
// "writes are split by privilege, not merely by operation" invariant.
//
// NOTE: this task does NOT build the actual conformance-probing logic
// (task 2.4 - it needs real running service images to probe). It builds
// only the tier STORAGE and TRANSITION path, so a pipeline can record a
// verdict once probing exists.

import { validateTrustTier } from "./validate.js";

// recordTrustTier(digest, tier) - transition an already-registered image's
// trust tier. Fails if the digest is not registered (the runtime cannot
// conjure an entry - only annotate an existing one).
export async function recordTrustTier(pool, digest, tier) {
  const { valid, errors } = validateTrustTier(tier);
  if (!valid) {
    const err = new Error(
      `recordTrustTier validation failed:\n  - ${errors.join("\n  - ")}`
    );
    err.validationErrors = errors;
    throw err;
  }

  const { rowCount, rows } = await pool.query(
    `UPDATE registry.service_images
        SET trust_tier = $2,
            updated_at = now()
      WHERE digest = $1
      RETURNING digest, trust_tier`,
    [digest, tier]
  );

  if (rowCount === 0) {
    throw new Error(
      `recordTrustTier: no registered image with digest ${digest} (the runtime can only annotate trust on an image a developer already registered)`
    );
  }

  return { digest: rows[0].digest, trustTier: rows[0].trust_tier };
}
