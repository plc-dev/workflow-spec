import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/core/index.js";
import {
  claimExecution,
  completeStep,
  findRunStepNode,
  getRunResult,
  resolveStepReads,
  submitRun,
} from "../../src/engine/index.js";
import type { WorkflowSpec } from "../../src/ir/index.js";
import { ERROR_IDS, FatalError } from "../../src/shared/index.js";
import { type TestPostgres, startTestPostgres } from "../helpers/postgres.js";

// A -> B -> C dependency chain, exercising both the `dependsOn` escape
// hatch (D8a) and inferred `{from:"step"}` dependencies (D8) together on
// node C. Matches this package's plan doc's TC-2 fixture.
const THREE_NODE_SPEC: WorkflowSpec = {
  irVersion: 1,
  name: "three-node-chain",
  steps: [
    {
      id: "A",
      service: "svc@sha256:aaa",
      function: "f",
      reads: { x: { from: "request", param: "amount" } },
    },
    {
      id: "B",
      service: "svc@sha256:bbb",
      function: "f",
      reads: { x: { from: "step", id: "A", output: "value" } },
    },
    {
      id: "C",
      service: "svc@sha256:ccc",
      function: "f",
      dependsOn: ["A"],
      reads: { x: { from: "step", id: "B", output: "value" } },
    },
  ],
  outputs: { total: { from: "step", id: "C", output: "value" } },
};

describe("engine interpreter (plain-step dependency graph)", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await tp.pool.query(
      "TRUNCATE executions, checkpoints, run_node_outputs, workflow_runs RESTART IDENTITY CASCADE",
    );
  });

  async function executionStatuses(runId: number): Promise<Record<string, string>> {
    const { rows } = await tp.pool.query<{ step: string; status: string }>(
      "SELECT step, status FROM executions WHERE run_id = $1",
      [runId],
    );
    return Object.fromEntries(rows.map((r) => [r.step, r.status]));
  }

  // TC-2: dependency ordering is enforced from DB state alone, before any
  // worker has run (design.md D8/D8a; spike 1.5's own verified property).
  it("creates blocked/queued execution rows purely from static dependency analysis", async () => {
    const run = await withTransaction(tp.pool, (repos) =>
      submitRun(repos, THREE_NODE_SPEC, { amount: 10 }),
    );

    const statuses = await executionStatuses(run.id);
    expect(statuses).toEqual({ A: "queued", B: "blocked", C: "blocked" });
  });

  // TC-3: promotion happens in the SAME transaction as the write that
  // satisfies the dependency (spike 1.5's own verified property).
  it("promotes B to queued in the same transaction that completes A, while C stays blocked", async () => {
    const run = await withTransaction(tp.pool, (repos) =>
      submitRun(repos, THREE_NODE_SPEC, { amount: 10 }),
    );

    await withTransaction(tp.pool, async (repos) => {
      const execution = await claimExecution(repos, "worker-1");
      if (!execution) throw new Error("expected an execution to claim");
      await completeStep(repos, {
        run,
        executionId: execution.id,
        nodeId: "A",
        output: { value: 20 },
      });

      // Checked from WITHIN the still-open transaction, not after commit.
      const bByQuery = await repos.client.query<{ status: string }>(
        "SELECT status FROM executions WHERE run_id = $1 AND step = 'B'",
        [run.id],
      );
      const cByQuery = await repos.client.query<{ status: string }>(
        "SELECT status FROM executions WHERE run_id = $1 AND step = 'C'",
        [run.id],
      );
      expect(bByQuery.rows[0]?.status).toBe("queued");
      expect(cByQuery.rows[0]?.status).toBe("blocked");
    });
  });

  // TC-4: full run to completion under genuine concurrency, exercising
  // request/step/literal binding resolution together, ending in a
  // resolved top-level `outputs` result (design.md D8 end to end).
  it("runs a three-node chain to completion under concurrent workers and resolves outputs", async () => {
    const run = await withTransaction(tp.pool, (repos) =>
      submitRun(repos, THREE_NODE_SPEC, { amount: 10 }),
    );

    async function dispatch(nodeId: string, resolvedInput: Record<string, unknown>) {
      const x = Number(resolvedInput.x ?? 0);
      switch (nodeId) {
        case "A":
          return { value: x * 2 }; // 20
        case "B":
          return { value: x + 1 }; // 21
        case "C":
          return { value: x + 1 }; // 22
        default:
          throw new Error(`unexpected node ${nodeId}`);
      }
    }

    async function workerLoop() {
      for (;;) {
        const didWork = await withTransaction(tp.pool, async (repos) => {
          const execution = await claimExecution(repos, "worker");
          if (!execution || execution.runId == null) return false;
          const node = findRunStepNode(run, execution.step);
          const resolvedInput = await resolveStepReads(repos, run, node);
          const output = await dispatch(node.id, resolvedInput);
          await completeStep(repos, { run, executionId: execution.id, nodeId: node.id, output });
          return true;
        });
        if (!didWork) return;
      }
    }

    await Promise.all([workerLoop(), workerLoop(), workerLoop()]);

    const result = await withTransaction(tp.pool, (repos) => getRunResult(repos, run));
    expect(result.status).toBe("done");
    expect(result.outputs).toEqual({ total: 22 });
  });

  // TC-6: submitRun fails closed for any node kind 6.2a doesn't support -
  // an explicit scope boundary for 6.2b, not silent misbehavior.
  it("rejects a spec containing a branch node, inserting no rows", async () => {
    const specWithBranch: WorkflowSpec = {
      irVersion: 1,
      name: "has-branch",
      steps: [
        {
          id: "br",
          kind: "branch",
          selector: { literal: "x" },
          cases: { x: { steps: [] } },
        },
      ],
    };

    await expect(
      withTransaction(tp.pool, (repos) => submitRun(repos, specWithBranch, {})),
    ).rejects.toThrow(expect.objectContaining({ errorId: ERROR_IDS.ENGINE_UNSUPPORTED_NODE_KIND }));

    const runs = await tp.pool.query("SELECT count(*)::int AS c FROM workflow_runs");
    expect(runs.rows[0]?.c).toBe(0);
    const executions = await tp.pool.query("SELECT count(*)::int AS c FROM executions");
    expect(executions.rows[0]?.c).toBe(0);
  });

  // TC-7: a mid-transaction crash inside completeStep rolls back the
  // checkpoint write, the run_node_outputs write, AND the sibling
  // promotion together - design.md D6's DEEP-consolidation guarantee,
  // now covering this package's new workflow-run bookkeeping.
  it("rolls back checkpoint + run_node_outputs + promotion together on a mid-transaction crash", async () => {
    const twoNodeSpec: WorkflowSpec = {
      irVersion: 1,
      name: "two-node",
      steps: [
        { id: "A", service: "svc@sha256:aaa", function: "f" },
        {
          id: "B",
          service: "svc@sha256:bbb",
          function: "f",
          reads: { x: { from: "step", id: "A", output: "value" } },
        },
      ],
    };
    const run = await withTransaction(tp.pool, (repos) => submitRun(repos, twoNodeSpec, {}));

    let executionIdA: number | undefined;
    await expect(
      withTransaction(tp.pool, async (repos) => {
        const execution = await claimExecution(repos, "worker-doomed");
        if (!execution) throw new Error("expected an execution to claim");
        executionIdA = execution.id;

        await completeStep(repos, {
          run,
          executionId: execution.id,
          nodeId: "A",
          output: { value: 1 },
        });

        const pidResult = await repos.client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = pidResult.rows[0]?.pid;
        await tp.adminPool.query("SELECT pg_terminate_backend($1)", [pid]);
        await repos.client.query("SELECT 1");
      }),
    ).rejects.toThrow();

    const outputCount = await tp.pool.query(
      "SELECT count(*)::int AS c FROM run_node_outputs WHERE run_id = $1",
      [run.id],
    );
    expect(outputCount.rows[0]?.c).toBe(0);

    const checkpointCount = await tp.pool.query(
      "SELECT count(*)::int AS c FROM checkpoints WHERE execution_id = $1",
      [executionIdA],
    );
    expect(checkpointCount.rows[0]?.c).toBe(0);

    // The whole transaction rolled back, including the claim itself
    // (queued -> running) - not just completeStep's own writes, matching
    // test/engine/claim-complete.test.ts's own crash-test precedent.
    const statuses = await executionStatuses(run.id);
    expect(statuses).toEqual({ A: "queued", B: "blocked" }); // not promoted

    const runRow = await tp.pool.query<{ status: string }>(
      "SELECT status FROM workflow_runs WHERE id = $1",
      [run.id],
    );
    expect(runRow.rows[0]?.status).toBe("running"); // not marked done

    // Immediate recovery, no lease wait needed.
    const reclaimed = await withTransaction(tp.pool, (repos) => claimExecution(repos, "worker-2"));
    expect(reclaimed?.id).toBe(executionIdA);
  });

  // Local-review fix (docs/impl-plans/0006-interpreter-plain-steps.md's
  // review pass): a diamond dependency (D depends on BOTH X and Y, which
  // have no dependency on each other) completed by two GENUINELY
  // overlapping transactions previously left D permanently `blocked` -
  // neither transaction's read of run_node_outputs ever observed both
  // sibling outputs. completeStep's per-run `FOR UPDATE` lock now
  // serializes the two completions instead.
  it("promotes a diamond-dependency node when its two sibling deps complete under genuinely overlapping transactions", async () => {
    const diamondSpec: WorkflowSpec = {
      irVersion: 1,
      name: "diamond",
      steps: [
        { id: "X", service: "svc@sha256:xxx", function: "f" },
        { id: "Y", service: "svc@sha256:yyy", function: "f" },
        { id: "D", service: "svc@sha256:ddd", function: "f", dependsOn: ["X", "Y"] },
      ],
    };
    const run = await withTransaction(tp.pool, (repos) => submitRun(repos, diamondSpec, {}));

    const statusesBefore = await executionStatuses(run.id);
    expect(statusesBefore).toEqual({ X: "queued", Y: "queued", D: "blocked" });

    const xExecution = await withTransaction(tp.pool, (repos) => claimExecution(repos, "worker-x"));
    const yExecution = await withTransaction(tp.pool, (repos) => claimExecution(repos, "worker-y"));
    if (!xExecution || !yExecution) throw new Error("expected both X and Y to be claimable");

    // Txn1 (completing X) finishes its own writes, then deliberately
    // holds its transaction open (via the delay) before committing -
    // simulating slow work - while Txn2 (completing Y) starts
    // concurrently and must block on completeStep's per-run lock until
    // Txn1 commits and releases it.
    const txn1 = withTransaction(tp.pool, async (repos) => {
      await completeStep(repos, { run, executionId: xExecution.id, nodeId: "X", output: {} });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const txn2 = withTransaction(tp.pool, (repos) =>
      completeStep(repos, { run, executionId: yExecution.id, nodeId: "Y", output: {} }),
    );

    await Promise.all([txn1, txn2]);

    const statusesAfter = await executionStatuses(run.id);
    expect(statusesAfter).toEqual({ X: "done", Y: "done", D: "queued" });
  });

  // Local-review fix: a spec with a repeated top-level node id is
  // rejected rather than silently letting one of the two same-id
  // executions "complete" the run while the other keeps running.
  it("rejects a spec containing duplicate top-level node ids, inserting no rows", async () => {
    const duplicateIdSpec: WorkflowSpec = {
      irVersion: 1,
      name: "duplicate-id",
      steps: [
        { id: "A", service: "svc@sha256:aaa", function: "f" },
        { id: "A", service: "svc@sha256:bbb", function: "f" },
      ],
    };

    await expect(
      withTransaction(tp.pool, (repos) => submitRun(repos, duplicateIdSpec, {})),
    ).rejects.toThrow(expect.objectContaining({ errorId: ERROR_IDS.ENGINE_DUPLICATE_NODE_ID }));

    const runs = await tp.pool.query("SELECT count(*)::int AS c FROM workflow_runs");
    expect(runs.rows[0]?.c).toBe(0);
  });

  // Local-review fix: a schema-valid zero-step spec is marked `done`
  // immediately rather than left permanently `running`.
  it("marks a zero-step spec's run done immediately", async () => {
    const emptySpec: WorkflowSpec = { irVersion: 1, name: "empty", steps: [] };

    const run = await withTransaction(tp.pool, (repos) => submitRun(repos, emptySpec, {}));
    expect(run.status).toBe("done");

    const result = await withTransaction(tp.pool, (repos) => getRunResult(repos, run));
    expect(result.status).toBe("done");
  });
});
