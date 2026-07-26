import { describe, expect, it } from "vitest";
import { validateRegistration, validateTrustTier } from "../../src/registry/validate.js";
import {
  CAPABILITY_METADATA,
  DIGEST,
  HARDWARE_REQUIREMENTS,
  OCI_REF,
  OPENAPI_SPEC,
} from "./fixtures.js";

// TC-9 (docs/impl-plans/0007-registry.md) - no Postgres needed, pure functions.
describe("validateRegistration", () => {
  it("accepts a well-formed registration payload", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: CAPABILITY_METADATA,
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects capability metadata for a function absent from openapiSpec", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: {
        ...CAPABILITY_METADATA,
        ghostFn: {
          mutates: false,
          materializationCostClass: "negligible",
          cowSupport: false,
          changeDetectionSupport: false,
          nestingDeclaration: null,
        },
      },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ghostFn"))).toBe(true);
  });

  it("rejects an invalid materializationCostClass enum value", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: {
        runQuery: {
          mutates: false,
          materializationCostClass: "medium",
          cowSupport: false,
          changeDetectionSupport: true,
          nestingDeclaration: null,
        },
        loadDump: CAPABILITY_METADATA.loadDump,
      },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("materializationCostClass"))).toBe(true);
  });

  it("rejects a malformed nesting declaration (bad transport)", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: {
        runQuery: CAPABILITY_METADATA.runQuery,
        loadDump: {
          ...CAPABILITY_METADATA.loadDump,
          nestingDeclaration: { via: "carrier-pigeon", targets: "open" },
        },
      },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("via"))).toBe(true);
  });
});

describe("validateTrustTier", () => {
  it("accepts every recognized tier", () => {
    expect(validateTrustTier("unverified").valid).toBe(true);
    expect(validateTrustTier("conformance-passed").valid).toBe(true);
    expect(validateTrustTier("production-proven").valid).toBe(true);
  });

  it("rejects an unrecognized tier", () => {
    const result = validateTrustTier("super-trusted");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("super-trusted");
  });
});
