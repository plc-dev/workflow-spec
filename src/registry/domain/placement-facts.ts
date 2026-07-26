import type { TrustTier } from "../constants.js";
import type { FunctionCapability } from "./function-capability.js";

// getPlacementFacts' return shape (task 2.8, design.md D12) - capability
// metadata, trust tier, and hardware requirements, all read together as
// ONE atomic query so callers never observe them skewed relative to one
// another (e.g. a trust demotion landing between two separate reads).
export interface PlacementFacts {
  digest: string;
  function: string;
  capability: Omit<FunctionCapability, "digest" | "functionName">;
  trustTier: TrustTier;
  hardwareRequirements: Record<string, unknown>;
}
