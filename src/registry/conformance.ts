// WORKFLOW-PLATFORM write path (design.md D12/D5a, ADR-0006/0007).
//
// This module exports ONLY recordTrustTier. It models the workflow
// platform's own conformance/CI pipeline (tasks 2.4-2.7): the runtime may
// promote or demote the trust tier of an ALREADY-REGISTERED image, but has
// no way to register a new image (registerImage lives in admin.ts and is
// not imported here). This is the structural half of D12's "writes are
// split by privilege, not merely by operation" invariant.
//
// NOTE: this package does NOT build the actual conformance-probing logic
// (task 2.4 - it needs real running service images to probe). It builds
// only the tier STORAGE and TRANSITION path, so a pipeline can record a
// verdict once probing exists.

import type { Pool } from "pg";
import { ERROR_IDS, FatalError, logger } from "../shared/index.js";
import { LOG_EVENT_RECORD_TRUST_TIER, type TrustTier } from "./constants.js";
import { createServiceImagesRepo } from "./repositories/service-images.repository.js";
import { validateTrustTier } from "./validate.js";

// recordTrustTier(digest, tier) - transition an already-registered image's
// trust tier. Fails if the digest is not registered (the runtime cannot
// conjure an entry - only annotate an existing one).
export async function recordTrustTier(
  pool: Pool,
  digest: string,
  tier: TrustTier,
): Promise<{ digest: string; trustTier: TrustTier }> {
  const { valid, errors } = validateTrustTier(tier);
  if (!valid) {
    throw new FatalError(ERROR_IDS.REGISTRY_TRUST_TIER_INVALID, {
      context: { digest, tier, errors },
    });
  }

  const repo = createServiceImagesRepo(pool);
  const image = await repo.updateTrustTier(digest, tier);
  if (!image) {
    throw new FatalError(ERROR_IDS.REGISTRY_TRUST_TIER_UNKNOWN_DIGEST, {
      context: { digest },
    });
  }
  logger.debug({ digest: image.digest, trustTier: image.trustTier }, LOG_EVENT_RECORD_TRUST_TIER);
  return { digest: image.digest, trustTier: image.trustTier };
}
