// PLATFORM-DEVELOPER-ONLY write path (design.md D12, ADR-0006/0007).
//
// This module exports ONLY registerImage. The privilege split from D12 is
// modeled STRUCTURALLY, not by a runtime permission flag: registering a
// new image lives in its own module, deliberately NOT re-exported from
// registry/index.ts, so a hypothetical runtime-facing module (the
// workflow platform / scheduler) simply has nothing to import that would
// let it introduce a new image. The set of invocable images is entirely
// developer-curated; see conformance.ts for the runtime's ONLY authority
// over that set (annotating trust on top of an already-registered image).
//
// There is deliberately no generic `update()` here gated by a permission
// check - the boundary IS the module boundary (no data-plane module or
// app may import registry/admin.ts, per ADR-0007).

import type { Pool } from "pg";
import { ERROR_IDS, FatalError } from "../shared/index.js";
import type { TrustTier } from "./constants.js";
import { withRegistryTransaction } from "./database/transactions.js";
import type { FunctionCapability } from "./domain/index.js";
import { validateRegistration } from "./validate.js";

export interface RegisterImageInput {
  digest: string;
  ociRef: string;
  openapiSpec: Record<string, unknown>;
  capabilityMetadata?: Record<string, Omit<FunctionCapability, "digest" | "functionName">>;
  hardwareRequirements?: Record<string, unknown>;
}

// registerImage(...) - insert (or replace) a per-image registry entry
// plus its per-function capability rows, atomically. Defaults trust_tier
// to 'unverified' (D5a): the scheduler leans on no capability declaration
// until a build has earned 'production-proven' through conformance.
export async function registerImage(
  pool: Pool,
  input: RegisterImageInput,
): Promise<{ digest: string; trustTier: TrustTier }> {
  const capabilityMetadata = input.capabilityMetadata ?? {};
  const hardwareRequirements = input.hardwareRequirements ?? {};

  const { valid, errors } = validateRegistration({
    digest: input.digest,
    ociRef: input.ociRef,
    openapiSpec: input.openapiSpec,
    capabilityMetadata,
    hardwareRequirements,
  });
  if (!valid) {
    throw new FatalError(ERROR_IDS.REGISTRY_VALIDATION_FAILED, {
      context: { digest: input.digest, errors },
    });
  }

  return withRegistryTransaction(pool, async (repos) => {
    const image = await repos.serviceImages.upsert({
      digest: input.digest,
      ociRef: input.ociRef,
      openapiSpec: input.openapiSpec,
      hardwareRequirements,
    });
    await repos.functionCapabilities.replaceForDigest(input.digest, capabilityMetadata);
    return { digest: image.digest, trustTier: image.trustTier };
  });
}
