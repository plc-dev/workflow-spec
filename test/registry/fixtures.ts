import type { FunctionCapabilityInput } from "../../src/registry/index.js";

// Shared fixtures across registry/ test files - a representative service
// image exposing two functions with different capability profiles
// (proving per-function granularity), ported from
// archive/registry/test.js.
export const DIGEST = "sha256:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888";
export const OCI_REF = `oci://registry.example.com/sql-service@${DIGEST}`;

export const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: { title: "sql-service", version: "1.0.0" },
  paths: {
    "/query": { post: { operationId: "runQuery" } },
    "/load": { post: { operationId: "loadDump" } },
  },
};

export const CAPABILITY_METADATA: {
  runQuery: FunctionCapabilityInput;
  loadDump: FunctionCapabilityInput;
} = {
  // read-only query: doesn't mutate, cheap, no COW, reports change-detection.
  // Light-only (design.md D17b): no heavy bindings, no state reuse.
  runQuery: {
    mutates: false,
    materializationCostClass: "negligible",
    cowSupport: false,
    changeDetectionSupport: true,
    nestingDeclaration: null,
    invocationDescriptor: [],
    stateReuse: "none",
    additiveWarmUpdate: false,
  },
  // load a big dump: mutates, heavy, COW-capable, and can nest into other
  // services over http (open target set). design.md D17b: this function's
  // OWN native CLI accepts the materialized dump path via "--dump-file"
  // (not a platform-mandated "--data-file") and may reuse local state
  // across execs, including additive/incremental warm updates (matching
  // its declared cowSupport).
  loadDump: {
    mutates: true,
    materializationCostClass: "heavy",
    cowSupport: true,
    changeDetectionSupport: true,
    nestingDeclaration: { via: "http", targets: "open" },
    invocationDescriptor: [{ param: "dumpFile", style: "flag", flagName: "--dump-file" }],
    stateReuse: "stateIdKeyed",
    additiveWarmUpdate: true,
  },
};

export const HARDWARE_REQUIREMENTS = {
  cpu: "4",
  mem: "16Gi",
  gpu: 0,
  nodeClass: "memory-optimized",
};
