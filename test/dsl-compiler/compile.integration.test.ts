import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/core/index.js";
import { compile } from "../../src/dsl-compiler/index.js";
import {
  claimExecution,
  completeStep,
  findRunStepNode,
  getRunResult,
  resolveStepReads,
  submitRun,
} from "../../src/engine/index.js";
import type { ExecutionPlan } from "../../src/workflow-spec/index.js";
import { type TestPostgres, startTestPostgres } from "../helpers/postgres.js";
import {
  resetRegistryTables,
  seedFixtureImage,
  startRegistryPostgres,
} from "../helpers/registry-postgres.js";
import { resetExecutionAndWorkflowRunTables } from "../helpers/reset.js";

// docs/impl-plans/0009-dsl-compiler-plain-steps.md, TC-12..TC-16. Needs
// TWO separate testcontainers-managed Postgres instances - core/'s
// (ADR-0002) and registry/'s (ADR-0006) are genuinely separate databases,
// exactly the way runtime code would see them.

const DIGEST_A = "sha256:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888";
const DIGEST_B = "sha256:bbbb1111cccc2222dddd3333eeee4444ffff5555aaaa6666bbbb7777cccc8888";

const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: { title: "svc", version: "1.0.0" },
  paths: { "/f": { post: { operationId: "f" } } },
};

const CAPABILITY_METADATA_F = {
  f: {
    mutates: false,
    materializationCostClass: "negligible" as const,
    cowSupport: false,
    changeDetectionSupport: false,
    nestingDeclaration: null,
    // design.md D17b - light-only: no heavy bindings, no state reuse.
    invocationDescriptor: [],
    stateReuse: "none" as const,
    additiveWarmUpdate: false,
  },
};

function twoStepYaml(): string {
  return [
    "workflowSpecVersion: 1",
    "name: two-step-chain",
    "steps:",
    "  - id: stepA",
    `    service: svc@${DIGEST_A}`,
    "    function: f",
    "    reads:",
    "      x:",
    "        from: request",
    "        param: amount",
    "  - id: stepB",
    `    service: svc@${DIGEST_B}`,
    "    function: f",
    "    reads:",
    "      x:",
    "        from: step",
    "        id: stepA",
    "        output: value",
    "outputs:",
    "  total:",
    "    from: step",
    "    id: stepB",
    "    output: value",
    "",
  ].join("\n");
}

describe("compile() - registry-checked (task 5.3)", () => {
  let registryTp: TestPostgres;

  beforeAll(async () => {
    registryTp = await startRegistryPostgres();
  }, 60_000);

  afterAll(async () => {
    await registryTp.stop();
  });

  beforeEach(async () => {
    await resetRegistryTables(registryTp.pool);
  });

  // TC-12
  it("rejects a service reference whose digest is never registered (unknown_service_digest)", async () => {
    const result = await compile(twoStepYaml(), { registryPool: registryTp.pool });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    // Both steps' digests are unregistered here - both are reported (this
    // stage collects every violation, it doesn't stop at the first).
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "unknown_service_digest", path: "stepA" }),
      expect.objectContaining({ code: "unknown_service_digest", path: "stepB" }),
    ]);
  });

  // TC-13
  it("rejects a registered digest whose function is not declared (unknown_service_function)", async () => {
    await seedFixtureImage(registryTp.pool, {
      digest: DIGEST_A,
      ociRef: `oci://registry.example.com/svc@${DIGEST_A}`,
      openapiSpec: OPENAPI_SPEC,
      hardwareRequirements: {},
      capabilityMetadata: {}, // registered, but declares no functions
    });
    await seedFixtureImage(registryTp.pool, {
      digest: DIGEST_B,
      ociRef: `oci://registry.example.com/svc@${DIGEST_B}`,
      openapiSpec: OPENAPI_SPEC,
      hardwareRequirements: {},
      capabilityMetadata: CAPABILITY_METADATA_F,
    });

    const result = await compile(twoStepYaml(), { registryPool: registryTp.pool });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "unknown_service_function", path: "stepA" }),
    ]);
  });

  // TC-14
  it("compiles successfully when every service/function reference resolves", async () => {
    for (const digest of [DIGEST_A, DIGEST_B]) {
      await seedFixtureImage(registryTp.pool, {
        digest,
        ociRef: `oci://registry.example.com/svc@${digest}`,
        openapiSpec: OPENAPI_SPEC,
        hardwareRequirements: {},
        capabilityMetadata: CAPABILITY_METADATA_F,
      });
    }

    const result = await compile(twoStepYaml(), { registryPool: registryTp.pool });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected success, got: ${JSON.stringify(result.errors)}`);
    expect(result.executionPlan.name).toBe("two-step-chain");
  });

  // Local-review regression: `entry.functions` is a plain object literal,
  // so a step naming an Object.prototype key (e.g. "constructor") must
  // NOT be treated as a declared function just because `in` would match
  // it - the registry, not JS's prototype chain, is the source of truth.
  it("rejects a step naming an Object.prototype key as its function (unknown_service_function)", async () => {
    await seedFixtureImage(registryTp.pool, {
      digest: DIGEST_A,
      ociRef: `oci://registry.example.com/svc@${DIGEST_A}`,
      openapiSpec: OPENAPI_SPEC,
      hardwareRequirements: {},
      capabilityMetadata: {}, // registered, but declares no functions
    });

    const yamlSource = [
      "workflowSpecVersion: 1",
      "name: prototype-key-probe",
      "steps:",
      "  - id: stepA",
      `    service: svc@${DIGEST_A}`,
      "    function: constructor",
      "",
    ].join("\n");

    const result = await compile(yamlSource, { registryPool: registryTp.pool });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "unknown_service_function", path: "stepA" }),
    ]);
  });
});

describe("compile() -> engine/submitRun end-to-end (task 5.2/5.3 integration)", () => {
  let registryTp: TestPostgres;
  let coreTp: TestPostgres;

  beforeAll(async () => {
    [registryTp, coreTp] = await Promise.all([startRegistryPostgres(), startTestPostgres()]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([registryTp.stop(), coreTp.stop()]);
  });

  beforeEach(async () => {
    await Promise.all([
      resetRegistryTables(registryTp.pool),
      resetExecutionAndWorkflowRunTables(coreTp.pool),
    ]);
    for (const digest of [DIGEST_A, DIGEST_B]) {
      await seedFixtureImage(registryTp.pool, {
        digest,
        ociRef: `oci://registry.example.com/svc@${digest}`,
        openapiSpec: OPENAPI_SPEC,
        hardwareRequirements: {},
        capabilityMetadata: CAPABILITY_METADATA_F,
      });
    }
  });

  // TC-16: a restricted-YAML document, compiled against a real registry,
  // is byte-for-byte what engine/submitRun already knows how to run -
  // proves 0004's `ExecutionPlan = WorkflowSpec` alias holds in practice.
  it("compiles a two-step YAML workflow and runs it to completion via engine/submitRun", async () => {
    const compiled = await compile(twoStepYaml(), { registryPool: registryTp.pool });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(`expected success, got: ${JSON.stringify(compiled.errors)}`);

    const executionPlan: ExecutionPlan = compiled.executionPlan;

    const run = await withTransaction(coreTp.pool, (repos) =>
      submitRun(repos, executionPlan, { amount: 10 }),
    );

    async function dispatch(nodeId: string, resolvedInput: Record<string, unknown>) {
      const x = Number(resolvedInput.x ?? 0);
      return nodeId === "stepA" ? { value: x * 2 } : { value: x + 1 };
    }

    for (;;) {
      const didWork = await withTransaction(coreTp.pool, async (repos) => {
        const execution = await claimExecution(repos, "worker");
        if (!execution || execution.runId == null) return false;
        const node = findRunStepNode(run, execution.step);
        const resolvedInput = await resolveStepReads(repos, run, node);
        const output = await dispatch(node.id, resolvedInput);
        await completeStep(repos, { run, executionId: execution.id, nodeId: node.id, output });
        return true;
      });
      if (!didWork) break;
    }

    const result = await withTransaction(coreTp.pool, (repos) => getRunResult(repos, run));
    expect(result.status).toBe("done");
    expect(result.outputs).toEqual({ total: 21 });
  });
});
