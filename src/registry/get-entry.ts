import type { Queryable } from "./database/connection-pool.js";
import type { FunctionCapability, RegistryEntry } from "./domain/index.js";
import { createFunctionCapabilitiesRepo } from "./repositories/function-capabilities.repository.js";
import { createServiceImagesRepo } from "./repositories/service-images.repository.js";

// getEntry(digest) - authoring-time read: the full per-image entry plus
// all of its per-function capability rows. Not consistency-critical
// (D12) - used for discovery / DSL validation, so composing two separate
// reads (unlike getPlacementFacts) is an accepted trade.
export async function getEntry(pool: Queryable, digest: string): Promise<RegistryEntry | null> {
  const image = await createServiceImagesRepo(pool).findByDigest(digest);
  if (!image) return null;

  const capabilities = await createFunctionCapabilitiesRepo(pool).listByDigest(digest);
  const functions: Record<string, Omit<FunctionCapability, "digest" | "functionName">> = {};
  for (const cap of capabilities) {
    functions[cap.functionName] = {
      mutates: cap.mutates,
      materializationCostClass: cap.materializationCostClass,
      cowSupport: cap.cowSupport,
      changeDetectionSupport: cap.changeDetectionSupport,
      nestingDeclaration: cap.nestingDeclaration,
    };
  }

  return { ...image, functions };
}
