import type { TrustTier } from "../constants.js";

// Per-image entry (design.md D12), keyed by digest.
export interface ServiceImage {
  digest: string;
  ociRef: string;
  openapiSpec: Record<string, unknown>;
  hardwareRequirements: Record<string, unknown>;
  trustTier: TrustTier;
  registeredAt: Date;
  updatedAt: Date;
}
