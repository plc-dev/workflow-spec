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

// design.md D17b - Layer 2 (invocationDescriptor) / Layer 3
// (stateReuse/additiveWarmUpdate) validation.
describe("validateRegistration - invocationDescriptor/stateReuse (design.md D17b)", () => {
  function capability(overrides: Record<string, unknown> = {}) {
    return {
      mutates: false,
      materializationCostClass: "negligible" as const,
      cowSupport: false,
      changeDetectionSupport: false,
      nestingDeclaration: null,
      invocationDescriptor: [],
      stateReuse: "none" as const,
      additiveWarmUpdate: false,
      ...overrides,
    };
  }

  it("accepts a light-only function (empty invocationDescriptor, stateReuse none)", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: { runQuery: capability() },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("accepts a heavy function with a flag-style entry and stateReuse stateIdKeyed", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: {
        runQuery: capability({
          invocationDescriptor: [{ param: "dumpFile", style: "flag", flagName: "--dump-file" }],
          stateReuse: "stateIdKeyed",
          additiveWarmUpdate: true,
        }),
      },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects invocationDescriptor that is not an array", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: { runQuery: capability({ invocationDescriptor: "nope" }) },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("invocationDescriptor must be an array"))).toBe(
      true,
    );
  });

  it.each(["dump-file", "-d", "--dump file", "--dump=file", ""])(
    "rejects a flag-style entry whose flagName %s does not match the required --flag-name shape",
    (flagName) => {
      const result = validateRegistration({
        digest: DIGEST,
        ociRef: OCI_REF,
        openapiSpec: OPENAPI_SPEC,
        capabilityMetadata: {
          runQuery: capability({
            invocationDescriptor: [{ param: "dumpFile", style: "flag", flagName }],
          }),
        },
        hardwareRequirements: HARDWARE_REQUIREMENTS,
      });
      expect(result.valid).toBe(false);
    },
  );

  it("rejects two positional entries declaring the same positionIndex", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: {
        runQuery: capability({
          invocationDescriptor: [
            { param: "a", style: "positional", positionIndex: 0 },
            { param: "b", style: "positional", positionIndex: 0 },
          ],
        }),
      },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("more than one"))).toBe(true);
  });

  it("rejects more than one stdin-style entry", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: {
        runQuery: capability({
          invocationDescriptor: [
            { param: "a", style: "stdin" },
            { param: "b", style: "stdin" },
          ],
        }),
      },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"stdin"-style entries'))).toBe(true);
  });

  it("rejects a flag-style entry with no flagName", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: {
        runQuery: capability({ invocationDescriptor: [{ param: "dumpFile", style: "flag" }] }),
      },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("requires a non-empty flagName"))).toBe(true);
  });

  it("rejects a positional-style entry with no positionIndex", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: {
        runQuery: capability({
          invocationDescriptor: [{ param: "dumpFile", style: "positional" }],
        }),
      },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("requires a non-negative integer positionIndex")),
    ).toBe(true);
  });

  it("rejects a duplicate param across invocationDescriptor entries", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: {
        runQuery: capability({
          invocationDescriptor: [
            { param: "dumpFile", style: "flag", flagName: "--a" },
            { param: "dumpFile", style: "flag", flagName: "--b" },
          ],
        }),
      },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate entry"))).toBe(true);
  });

  it("rejects an invalid stateReuse value", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: { runQuery: capability({ stateReuse: "always" }) },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("stateReuse must be one of"))).toBe(true);
  });

  it("rejects additiveWarmUpdate: true when stateReuse is not stateIdKeyed", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: { runQuery: capability({ additiveWarmUpdate: true }) },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("additiveWarmUpdate is only meaningful"))).toBe(
      true,
    );
  });

  it("rejects stateReuse: stateIdKeyed with an empty invocationDescriptor", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: { runQuery: capability({ stateReuse: "stateIdKeyed" }) },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("requires at least one invocationDescriptor entry")),
    ).toBe(true);
  });

  it("rejects stateReuse: stateIdKeyed combined with a positional-style entry (no wire channel for state-id)", () => {
    const result = validateRegistration({
      digest: DIGEST,
      ociRef: OCI_REF,
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: {
        runQuery: capability({
          invocationDescriptor: [{ param: "dumpFile", style: "positional", positionIndex: 0 }],
          stateReuse: "stateIdKeyed",
        }),
      },
      hardwareRequirements: HARDWARE_REQUIREMENTS,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('not supported for "positional"'))).toBe(true);
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
