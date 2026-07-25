// Registry test suite. Runs against a REAL Postgres instance (see README /
// NOTES for how it is stood up - a docker container on port 55444, schema
// applied from schema.sql). Demonstrates the tasks implemented in this
// component:
//
//   2.1/2.1a/2.1b/2.1c  registerImage stores a full entry (openapi_spec,
//                       oci_ref, per-function capability metadata,
//                       per-image hardware requirements, per-function
//                       nesting declaration)
//   2.5                 trust_tier defaults to 'unverified'; recordTrustTier
//                       transitions it
//   2.8                 getPlacementFacts returns capability metadata, trust
//                       tier, and hardware requirements together, atomically
//   2.2                 validate.js rejects malformed entries
//   2.10                privilege split is structural (admin.js exports only
//                       registerImage; conformance.js only recordTrustTier)

import { makePool, resetRegistrySchema } from "./src/db.js";
import { registerImage } from "./src/admin.js";
import { recordTrustTier } from "./src/conformance.js";
import { getPlacementFacts, getEntry } from "./src/query.js";
import { validateRegistration } from "./src/validate.js";
import * as adminModule from "./src/admin.js";
import * as conformanceModule from "./src/conformance.js";

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

// A representative service image: the "sql-service" exposing two functions
// with different capability profiles (proving per-function granularity).
const DIGEST = "sha256:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888";
const OCI_REF = "oci://registry.example.com/sql-service@" + DIGEST;

const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: { title: "sql-service", version: "1.0.0" },
  paths: {
    "/query": { post: { operationId: "runQuery" } },
    "/load": { post: { operationId: "loadDump" } },
  },
};

const CAPABILITY_METADATA = {
  // read-only query: doesn't mutate, cheap, no COW, reports change-detection
  runQuery: {
    mutates: false,
    materializationCostClass: "negligible",
    cowSupport: false,
    changeDetectionSupport: true,
    nestingDeclaration: null,
  },
  // load a big dump: mutates, heavy, COW-capable, and can nest into other
  // services over http (open target set)
  loadDump: {
    mutates: true,
    materializationCostClass: "heavy",
    cowSupport: true,
    changeDetectionSupport: true,
    nestingDeclaration: { via: "http", targets: "open" },
  },
};

const HARDWARE_REQUIREMENTS = {
  cpu: "4",
  mem: "16Gi",
  gpu: 0,
  nodeClass: "memory-optimized",
};

async function main() {
  const pool = makePool();
  await resetRegistrySchema(pool);

  console.log("\n[2.10] privilege split is structural");
  check(
    "admin.js exports only registerImage",
    Object.keys(adminModule).sort().join(",") === "registerImage"
  );
  check(
    "conformance.js exports only recordTrustTier",
    Object.keys(conformanceModule).sort().join(",") === "recordTrustTier"
  );

  console.log("\n[2.1/2.1a/2.1b/2.1c/2.5] registerImage + default trust tier");
  const reg = await registerImage(pool, {
    digest: DIGEST,
    openapiSpec: OPENAPI_SPEC,
    capabilityMetadata: CAPABILITY_METADATA,
    hardwareRequirements: HARDWARE_REQUIREMENTS,
    ociRef: OCI_REF,
  });
  check("registerImage returns the digest", reg.digest === DIGEST);
  check("newly registered image defaults to 'unverified'", reg.trustTier === "unverified");

  const entry = await getEntry(pool, DIGEST);
  check("entry stores oci_ref pointer", entry.ociRef === OCI_REF);
  check("entry stores openapi_spec as sole contract", entry.openapiSpec.info.title === "sql-service");
  check("entry stores per-image hardware requirements", entry.hardwareRequirements.mem === "16Gi");
  check("entry has both functions", Object.keys(entry.functions).sort().join(",") === "loadDump,runQuery");
  check("per-function capability differs (runQuery non-mutating)", entry.functions.runQuery.mutates === false);
  check("per-function capability differs (loadDump mutating+heavy)",
    entry.functions.loadDump.mutates === true && entry.functions.loadDump.materializationCostClass === "heavy");
  check("per-function nesting declaration stored",
    entry.functions.loadDump.nestingDeclaration.via === "http" &&
      entry.functions.loadDump.nestingDeclaration.targets === "open");
  check("function without nesting stores null", entry.functions.runQuery.nestingDeclaration === null);
  check("DB CHECK default confirms unverified", entry.trustTier === "unverified");

  console.log("\n[2.8] getPlacementFacts returns all three fact categories atomically");
  const facts = await getPlacementFacts(pool, DIGEST, "loadDump");
  check("facts include capability metadata", facts.capability.cowSupport === true);
  check("facts include trust tier", facts.trustTier === "unverified");
  check("facts include hardware requirements", facts.hardwareRequirements.nodeClass === "memory-optimized");
  check("facts are for the requested function", facts.function === "loadDump");
  check("getPlacementFacts on unknown function returns null",
    (await getPlacementFacts(pool, DIGEST, "nope")) === null);

  console.log("\n[2.5] recordTrustTier transitions the tier");
  const t1 = await recordTrustTier(pool, DIGEST, "conformance-passed");
  check("transition to conformance-passed", t1.trustTier === "conformance-passed");
  const t2 = await recordTrustTier(pool, DIGEST, "production-proven");
  check("transition to production-proven", t2.trustTier === "production-proven");
  const factsAfter = await getPlacementFacts(pool, DIGEST, "runQuery");
  check("getPlacementFacts reflects new tier", factsAfter.trustTier === "production-proven");

  let threw = false;
  try {
    await recordTrustTier(pool, "sha256:unregistered", "production-proven");
  } catch {
    threw = true;
  }
  check("recordTrustTier rejects unregistered digest (runtime cannot register)", threw);

  let badTierThrew = false;
  try {
    await recordTrustTier(pool, DIGEST, "super-trusted");
  } catch {
    badTierThrew = true;
  }
  check("recordTrustTier rejects invalid tier", badTierThrew);

  console.log("\n[2.2] validate.js rejects malformed entries");

  // (a) capability metadata referencing a function not in the openapi spec
  const refCheck = validateRegistration({
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
  check("rejects capability metadata for function absent from openapi_spec",
    !refCheck.valid && refCheck.errors.some((e) => e.includes("ghostFn")));

  // (b) invalid materializationCostClass enum
  const enumCheck = validateRegistration({
    digest: DIGEST,
    ociRef: OCI_REF,
    openapiSpec: OPENAPI_SPEC,
    capabilityMetadata: {
      runQuery: {
        mutates: false,
        materializationCostClass: "medium", // invalid
        cowSupport: false,
        changeDetectionSupport: true,
        nestingDeclaration: null,
      },
      loadDump: CAPABILITY_METADATA.loadDump,
    },
    hardwareRequirements: HARDWARE_REQUIREMENTS,
  });
  check("rejects invalid materializationCostClass enum",
    !enumCheck.valid && enumCheck.errors.some((e) => e.includes("materializationCostClass")));

  // (c) malformed nesting declaration
  const nestCheck = validateRegistration({
    digest: DIGEST,
    ociRef: OCI_REF,
    openapiSpec: OPENAPI_SPEC,
    capabilityMetadata: {
      runQuery: CAPABILITY_METADATA.runQuery,
      loadDump: {
        ...CAPABILITY_METADATA.loadDump,
        nestingDeclaration: { via: "carrier-pigeon", targets: "open" }, // invalid via
      },
    },
    hardwareRequirements: HARDWARE_REQUIREMENTS,
  });
  check("rejects malformed nesting declaration (bad transport)",
    !nestCheck.valid && nestCheck.errors.some((e) => e.includes("via")));

  // (d) that registerImage itself refuses the bad payload (validation wired in)
  let regThrew = false;
  try {
    await registerImage(pool, {
      digest: "sha256:bad",
      openapiSpec: OPENAPI_SPEC,
      capabilityMetadata: {
        ghostFn: {
          mutates: false,
          materializationCostClass: "negligible",
          cowSupport: false,
          changeDetectionSupport: false,
          nestingDeclaration: null,
        },
      },
      hardwareRequirements: {},
      ociRef: OCI_REF,
    });
  } catch {
    regThrew = true;
  }
  check("registerImage throws on invalid payload", regThrew);

  await pool.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
