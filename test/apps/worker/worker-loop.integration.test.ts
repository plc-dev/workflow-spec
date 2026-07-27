import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type WorkerDeps, runOnce } from "../../../src/apps/worker/worker-loop.js";
import { withTransaction } from "../../../src/core/index.js";
import { compile } from "../../../src/dsl-compiler/index.js";
import { getRunResult, submitRun } from "../../../src/engine/index.js";
import type { ExecutionPlan } from "../../../src/workflow-spec/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";
import {
  resetRegistryTables,
  seedFixtureImage,
  startRegistryPostgres,
} from "../../helpers/registry-postgres.js";
import { resetExecutionAndWorkflowRunTables } from "../../helpers/reset.js";
import { type TestAgent, startTestAgent } from "./support/agent-process.js";

// docs/impl-plans/0011-worker-cli-dispatch.md's Test design, T7-T11 - the
// package's own central claim: a compiled workflow actually dispatches
// via CLI (ADR-0005) to a REAL exec-agent process (ADR-0008), not a mock.

const DIGEST_A = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_B = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

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

// stepB reads stepA's own `stdin` output (fake-cli.sh echoes back
// whatever it received on stdin - always "" in this package's scope,
// since dispatch.ts never populates InvokeRequest.stdin) rather than
// `args` (an array of strings): fake-cli.sh's own JSON construction
// naively wraps each argv value in double quotes with NO escaping, so
// round-tripping an `args`-shaped value (which itself contains embedded
// double quotes once JSON.stringify'd) back through a SECOND fake-cli.sh
// invocation would produce invalid JSON on the fixture's own account -
// a fixture limitation, not a bug in this package's own args
// translation (already covered directly, and without this landmine, by
// dispatch.test.ts's unit tests). `stdin` (always "") is a plain string
// with no embedded quotes, so it round-trips through a SECOND dispatch
// safely while still proving the dependency edge/output flow is real.
function twoStepYaml(): string {
  return [
    "workflowSpecVersion: 1",
    "name: worker-two-step",
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
    "      fromA:",
    "        from: step",
    "        id: stepA",
    "        output: stdin",
    "outputs:",
    "  total:",
    "    from: step",
    "    id: stepB",
    "    output: args",
    "",
  ].join("\n");
}

// Two INDEPENDENT steps (no dependsOn/step-output edge between them) -
// both become 'queued' immediately on submitRun, so both are claimable
// before either dispatches. stepA is the one driven to fail (via its own
// literal "exit-code" binding); stepB has no dependency on stepA at all,
// so it stays claimable unless failRemainingForRun explicitly stops it.
function twoIndependentStepsYamlWithExitCode(exitCode: number): string {
  return [
    "workflowSpecVersion: 1",
    "name: worker-two-independent-steps",
    "steps:",
    "  - id: stepA",
    `    service: svc@${DIGEST_A}`,
    "    function: f",
    "    reads:",
    "      exit-code:",
    `        literal: ${exitCode}`,
    "  - id: stepB",
    `    service: svc@${DIGEST_B}`,
    "    function: f",
    "",
  ].join("\n");
}

// A single step reading a `session` binding - schema-valid (workflow-
// spec's JSON Schema recognizes every Binding kind) but NOT one of the
// light binding kinds 6.2a's resolveBinding actually supports - it
// throws a deterministic FatalError (ENGINE_BINDING_KIND_NOT_SUPPORTED)
// during resolveStepReads, BEFORE any dispatch call is ever made.
function oneStepYamlWithUnsupportedBinding(): string {
  return [
    "workflowSpecVersion: 1",
    "name: worker-one-step-unsupported-binding",
    "steps:",
    "  - id: stepA",
    `    service: svc@${DIGEST_A}`,
    "    function: f",
    "    reads:",
    "      x:",
    "        from: session",
    "        key: some-key",
    "",
  ].join("\n");
}

// A single step whose `reads` includes a literal "exit-code" binding -
// fake-cli.sh's OWN `--exit-code N` control flag (consumed by the
// fixture script itself, never echoed back) is exactly what
// translateArgsToInvokeArgs turns this binding into, so this drives a
// REAL, agent-reported (non-transient) failure without needing a second
// fixture script.
function oneStepYamlWithExitCode(exitCode: number): string {
  return [
    "workflowSpecVersion: 1",
    "name: worker-one-step-exit-code",
    "steps:",
    "  - id: stepA",
    `    service: svc@${DIGEST_A}`,
    "    function: f",
    "    reads:",
    "      exit-code:",
    `        literal: ${exitCode}`,
    "",
  ].join("\n");
}

describe("apps/worker - real CLI dispatch via the exec-agent", () => {
  let registryTp: TestPostgres;
  let coreTp: TestPostgres;
  let agent: TestAgent;
  let deps: WorkerDeps;

  beforeAll(async () => {
    [registryTp, coreTp] = await Promise.all([startRegistryPostgres(), startTestPostgres()]);
  }, 90_000);

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

    // A FRESH agent process per test, not shared across the whole file -
    // `resetExecutionAndWorkflowRunTables`'s RESTART IDENTITY means
    // executionId values are reused across tests within this file; the
    // agent's own local dedup cache (ADR-0008), keyed on exactly
    // (executionId, stepId), would otherwise serve a STALE cached result
    // from an earlier test that happened to reuse the same tuple - a
    // test-isolation hazard, not a real production concern (executionId
    // is a genuinely global, never-reset sequence in production).
    agent = await startTestAgent();
    deps = {
      agentBaseUrl: agent.baseUrl,
      workerId: "test-worker",
      leaseSeconds: 30,
      invokeTimeoutMs: 5000,
    };
  });

  afterEach(async () => {
    await agent.stop();
  });

  async function compilePlan(yaml: string): Promise<ExecutionPlan> {
    const compiled = await compile(yaml, { registryPool: registryTp.pool });
    if (!compiled.ok)
      throw new Error(`expected compile success, got: ${JSON.stringify(compiled.errors)}`);
    return compiled.executionPlan;
  }

  // T7
  it("runs a compiled two-step workflow to completion via real CLI dispatch to the exec-agent", async () => {
    const executionPlan = await compilePlan(twoStepYaml());
    const run = await withTransaction(coreTp.pool, (repos) =>
      submitRun(repos, executionPlan, { amount: 10 }),
    );

    for (;;) {
      const didWork = await runOnce(coreTp.pool, deps);
      if (!didWork) break;
    }

    const result = await withTransaction(coreTp.pool, (repos) => getRunResult(repos, run));
    expect(result.status).toBe("done");
    // stepA dispatched with --x 10 (translateArgsToInvokeArgs); fake-cli.sh
    // echoes its own (always-empty) stdin back; stepB then dispatched
    // with --fromA '' (stepA's stdin output, a plain string, passed
    // through unchanged - the string-passthrough rule).
    expect(result.outputs).toEqual({
      total: ["--fromA", ""],
    });
  });

  // T8
  it("marks the run and the failing execution as failed when the agent reports a real (nonzero-exit) failure", async () => {
    const executionPlan = await compilePlan(oneStepYamlWithExitCode(1));
    const run = await withTransaction(coreTp.pool, (repos) => submitRun(repos, executionPlan, {}));

    const executionsBefore = await withTransaction(coreTp.pool, (repos) =>
      repos.client.query("SELECT id FROM executions WHERE run_id = $1", [run.id]),
    );
    const executionId = executionsBefore.rows[0].id as number;

    for (;;) {
      const didWork = await runOnce(coreTp.pool, deps);
      if (!didWork) break;
    }

    const result = await withTransaction(coreTp.pool, (repos) => getRunResult(repos, run));
    expect(result.status).toBe("failed");

    const execution = await withTransaction(coreTp.pool, (repos) =>
      repos.executions.findById(executionId),
    );
    expect(execution?.status).toBe("failed");
  });

  // T9
  it("rolls back the whole claim transaction on a transient (agent-unreachable) failure, and successfully retries with no backoff", async () => {
    const executionPlan = await compilePlan(oneStepYamlWithExitCode(0));
    const run = await withTransaction(coreTp.pool, (repos) => submitRun(repos, executionPlan, {}));

    const unreachableDeps: WorkerDeps = { ...deps, agentBaseUrl: "http://127.0.0.1:1" };
    const firstAttempt = await runOnce(coreTp.pool, unreachableDeps);
    expect(firstAttempt).toBe(false);

    // The claim (and its lease) must have rolled back entirely - the
    // execution is immediately reclaimable, not stuck `running`.
    const secondAttempt = await runOnce(coreTp.pool, deps);
    expect(secondAttempt).toBe(true);

    const result = await withTransaction(coreTp.pool, (repos) => getRunResult(repos, run));
    expect(result.status).toBe("done");
  });

  // T10
  it("dispatches to the real agent exactly once per step on the successful path (no accidental double-dispatch)", async () => {
    const invocationsFile = path.join(
      mkdtempSync(path.join(tmpdir(), "wfx-fake-cli-invocations-")),
      "count",
    );
    const countingAgent = await startTestAgent({
      env: { FAKE_CLI_INVOCATIONS_FILE: invocationsFile },
    });
    const countingDeps: WorkerDeps = { ...deps, agentBaseUrl: countingAgent.baseUrl };

    try {
      const executionPlan = await compilePlan(twoStepYaml());
      await withTransaction(coreTp.pool, (repos) =>
        submitRun(repos, executionPlan, { amount: 10 }),
      );

      for (;;) {
        const didWork = await runOnce(coreTp.pool, countingDeps);
        if (!didWork) break;
      }

      const invocationCount = readFileSync(invocationsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean).length;
      expect(invocationCount).toBe(2); // exactly one real subprocess spawn per step
    } finally {
      await countingAgent.stop();
    }
  });

  // T11
  it("dispatches every step exactly once in total when two callers drain the same run concurrently", async () => {
    const executionPlan = await compilePlan(twoStepYaml());
    await withTransaction(coreTp.pool, (repos) => submitRun(repos, executionPlan, { amount: 10 }));

    let totalDispatches = 0;
    async function drain(): Promise<void> {
      for (;;) {
        const didWork = await runOnce(coreTp.pool, deps);
        if (!didWork) break;
        totalDispatches++;
      }
    }

    // Two concurrent "workers" racing to claim from the SAME two-step
    // run - SKIP LOCKED (0001) prevents double-claim at the SQL level;
    // this checks this package's own new dispatch code doesn't
    // reintroduce a race on top of it.
    await Promise.all([drain(), drain()]);
    expect(totalDispatches).toBe(2);
  });

  // Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md):
  // failing a run must stop its OTHER not-yet-claimed executions from
  // staying claimable - without ExecutionsRepo.failRemainingForRun,
  // stepB here would still get dispatched (real CLI side effects)
  // against a run already marked failed.
  it("stops a run's other not-yet-claimed executions from being dispatched once the run is marked failed", async () => {
    const invocationsFile = path.join(
      mkdtempSync(path.join(tmpdir(), "wfx-fake-cli-invocations-")),
      "count",
    );
    const countingAgent = await startTestAgent({
      env: { FAKE_CLI_INVOCATIONS_FILE: invocationsFile },
    });
    const countingDeps: WorkerDeps = { ...deps, agentBaseUrl: countingAgent.baseUrl };

    try {
      const executionPlan = await compilePlan(twoIndependentStepsYamlWithExitCode(1));
      const run = await withTransaction(coreTp.pool, (repos) =>
        submitRun(repos, executionPlan, {}),
      );

      const rows = await withTransaction(coreTp.pool, (repos) =>
        repos.client.query("SELECT id, step FROM executions WHERE run_id = $1", [run.id]),
      );
      const stepBExecutionId = rows.rows.find((r) => r.step === "stepB").id as number;

      // Only ONE claim cycle - stepA is claimed and fails first (it's
      // inserted first and claim_execution orders by insertion), which
      // must fail the run and stepB before stepB is ever claimed.
      let cycles = 0;
      for (;;) {
        const didWork = await runOnce(coreTp.pool, countingDeps);
        if (!didWork) break;
        cycles++;
        if (cycles > 5) throw new Error("runaway loop - test guard tripped");
      }

      const result = await withTransaction(coreTp.pool, (repos) => getRunResult(repos, run));
      expect(result.status).toBe("failed");

      const stepBExecution = await withTransaction(coreTp.pool, (repos) =>
        repos.executions.findById(stepBExecutionId),
      );
      expect(stepBExecution?.status).toBe("failed");

      // stepB's function was never actually invoked - only stepA's
      // failing call reached the real agent.
      const invocationCount = readFileSync(invocationsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean).length;
      expect(invocationCount).toBe(1);
    } finally {
      await countingAgent.stop();
    }
  });

  // Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md): a
  // deterministic FatalError raised BEFORE any dispatch call (here, an
  // unsupported binding kind) must fail the run, not become an infinite
  // retry poison-pill (roll back forever, reclaim, hit the identical
  // error again).
  it("fails the run (not an infinite retry) when resolving a step's bindings throws a deterministic FatalError", async () => {
    const executionPlan = await compilePlan(oneStepYamlWithUnsupportedBinding());
    const run = await withTransaction(coreTp.pool, (repos) => submitRun(repos, executionPlan, {}));

    // A SINGLE runOnce call must resolve this terminally (return true,
    // having failed the run) - not roll back and leave it reclaimable.
    const didWork = await runOnce(coreTp.pool, deps);
    expect(didWork).toBe(true);

    const result = await withTransaction(coreTp.pool, (repos) => getRunResult(repos, run));
    expect(result.status).toBe("failed");

    // A subsequent poll finds nothing left to claim - proving the
    // execution did NOT revert to a reclaimable status.
    const nextCycle = await runOnce(coreTp.pool, deps);
    expect(nextCycle).toBe(false);
  });

  // Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md): a
  // claimed execution with no run_id must have its claim ROLLED BACK,
  // not committed-and-abandoned (which would otherwise leave it stuck
  // `running` until lease expiry, reclaimed, and abandoned again,
  // forever).
  it("rolls back (not commits) the claim of a non-workflow-run execution, reverting it to queued", async () => {
    await withTransaction(coreTp.pool, (repos) =>
      repos.executions.enqueue({ sessionId: "s", step: "some-step", input: {} }),
    );

    const didWork = await runOnce(coreTp.pool, deps);
    expect(didWork).toBe(false);

    const rows = await coreTp.pool.query("SELECT status, attempts FROM executions");
    expect(rows.rows).toEqual([{ status: "queued", attempts: 0 }]);
  });
});
