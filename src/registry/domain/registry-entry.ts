import type { FunctionCapabilityInput } from "./function-capability.js";
import type { ServiceImage } from "./service-image.js";

// getEntry's composed return shape - an authoring-time read (D12: this is
// "interactive and cacheable", not consistency-critical the way
// getPlacementFacts is).
export interface RegistryEntry extends ServiceImage {
  functions: Record<string, FunctionCapabilityInput>;
}
