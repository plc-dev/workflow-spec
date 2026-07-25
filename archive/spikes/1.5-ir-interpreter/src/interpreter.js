import { resolveBinding, resolveReads } from "./bindings.js";
import { callFunction } from "./functions.js";

// A GENERIC interpreter for the IR shape in ir/example-workflow.json,
// against the Postgres-native durability core (D6/D6a). "Generic" here
// means: nothing in this file is specific to THIS workflow's node ids,
// function names, or shape - it walks whatever `nodes`/`reads`/`selector`/
// `source`/`yields` structure the IR document contains. The one thing that
// IS necessarily engine-specific is the dispatch loop itself (claim/
// checkpoint/commit against Postgres) - see FINDINGS.md for exactly what
// "engine-agnostic" does and doesn't mean here.
//
// SCOPE LIMITATION (stated up front, not discovered later): branch cases
// and map bodies with more than one internal step are not supported by
// this spike - each case/body is assumed to have exactly one step. Nested
// intra-case/intra-body dependency resolution would need this same
// promotion logic applied one level down; that's a real generalization,
// deliberately left out to keep this spike's scope to what 1.5 actually
// asks (prove the INTERPRETER pattern works on the chosen engine), not a
// full DSL-compiler implementation (tasks 5.x).

// ---------------------------------------------------------------------------
// Dependency analysis: walk a node's OWN definition (not its case/body
// internals - see below) for {from: "step", id: ...} references, so we know
// which OTHER top-level nodes must be `done` before this node is claimable.
// ---------------------------------------------------------------------------

function collectStepRefs(obj, refs) {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const v of obj) collectStepRefs(v, refs);
    return;
  }
  if (obj.from === "step" && typeof obj.id === "string") {
    refs.add(obj.id);
  }
  for (const v of Object.values(obj)) collectStepRefs(v, refs);
}

// External dependencies = every {from:"step", id} found anywhere in the
// node definition, MINUS the node's own internal step ids (a branch's case
// steps, or a map's body steps) - those are resolved by this node's own
// fan-out/join, not by the top-level promotion scheduler. This also means
// an internal step referencing an OUTER node's output would correctly
// still count as an external dependency of the whole branch/map node.
export function externalDepsOf(nodeDef) {
  const all = new Set();
  collectStepRefs(nodeDef, all);
  const internal = internalStepIdsOf(nodeDef);
  for (const id of internal) all.delete(id);
  all.delete(nodeDef.id);
  return all;
}

function internalStepIdsOf(nodeDef) {
  const ids = new Set();
  if (nodeDef.kind === "branch") {
    for (const c of Object.values(nodeDef.cases)) {
      for (const s of c.steps) ids.add(s.id);
    }
  } else if (nodeDef.kind === "map") {
    for (const s of nodeDef.body) ids.add(s.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Submission: create a run + one executions row per top-level node, queued
// only if it has zero external dependencies.
// ---------------------------------------------------------------------------

export async function submitRun(pool, workflowSpec, requestParams) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO ir.workflow_runs (workflow_name, request_params) VALUES ($1, $2) RETURNING id`,
      [workflowSpec.name, JSON.stringify(requestParams)]
    );
    const runId = rows[0].id;

    for (const node of workflowSpec.nodes) {
      const deps = externalDepsOf(node);
      const status = deps.size === 0 ? "queued" : "blocked";
      await client.query(
        `INSERT INTO ir.executions (run_id, node_id, kind, node_def, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [runId, node.id, node.kind || "step", JSON.stringify(node), status]
      );
    }

    await client.query("COMMIT");
    return runId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Shared context loading: every {from:"step"} / {from:"request"} binding a
// TOP-LEVEL node's own definition can reference is loaded up front, so
// resolveBinding never needs its own DB round-trip.
// ---------------------------------------------------------------------------

async function loadRunContext(client, runId) {
  const { rows: runRows } = await client.query(`SELECT request_params FROM ir.workflow_runs WHERE id = $1`, [runId]);
  const requestParams = runRows[0].request_params;

  const { rows: outputRows } = await client.query(
    `SELECT node_id, output FROM ir.run_node_outputs WHERE run_id = $1 AND done = true`,
    [runId]
  );
  const nodeOutputs = new Map(outputRows.map((r) => [r.node_id, r.output]));

  return { requestParams, nodeOutputs };
}

// After a node's output is written, promote any 'blocked' sibling node in
// this run whose external deps are now all satisfied. Runs in the SAME
// transaction as the write that unblocked them, so there is no window
// where a satisfied dependency isn't reflected yet.
async function promoteReadyNodes(client, runId) {
  const { rows: blocked } = await client.query(
    `SELECT id, node_def FROM ir.executions WHERE run_id = $1 AND status = 'blocked' FOR UPDATE`,
    [runId]
  );
  if (blocked.length === 0) return;

  const { rows: doneRows } = await client.query(
    `SELECT node_id FROM ir.run_node_outputs WHERE run_id = $1 AND done = true`,
    [runId]
  );
  const doneSet = new Set(doneRows.map((r) => r.node_id));

  for (const row of blocked) {
    const deps = externalDepsOf(row.node_def);
    const satisfied = [...deps].every((d) => doneSet.has(d));
    if (satisfied) {
      await client.query(`UPDATE ir.executions SET status = 'queued', updated_at = now() WHERE id = $1`, [row.id]);
    }
  }
}

// If every one of the workflow-spec's declared `outputs` bindings is now
// resolvable, the run is done - compute and store the final outputs.
async function maybeCompleteRun(client, runId, workflowSpec) {
  const { rows: doneRows } = await client.query(
    `SELECT node_id, output FROM ir.run_node_outputs WHERE run_id = $1 AND done = true`,
    [runId]
  );
  const nodeOutputs = new Map(doneRows.map((r) => [r.node_id, r.output]));
  const requiredNodeIds = new Set();
  collectStepRefs(workflowSpec.outputs, requiredNodeIds);
  const ready = [...requiredNodeIds].every((id) => nodeOutputs.has(id));
  if (!ready) return false;

  const { rows: runRows } = await client.query(`SELECT request_params FROM ir.workflow_runs WHERE id = $1`, [runId]);
  const ctx = { requestParams: runRows[0].request_params, nodeOutputs };
  const outputs = resolveReads(workflowSpec.outputs, ctx);

  await client.query(
    `UPDATE ir.workflow_runs SET status = 'done', outputs = $2, completed_at = now() WHERE id = $1`,
    [runId, JSON.stringify(outputs)]
  );
  return true;
}

// ---------------------------------------------------------------------------
// Per-node-kind dispatch
// ---------------------------------------------------------------------------

async function finishTopLevelNode(client, runId, nodeId, output, workflowSpec) {
  await client.query(
    `INSERT INTO ir.run_node_outputs (run_id, node_id, output, done) VALUES ($1, $2, $3, true)
     ON CONFLICT (run_id, node_id) DO UPDATE SET output = EXCLUDED.output, done = true`,
    [runId, nodeId, JSON.stringify(output)]
  );
  await promoteReadyNodes(client, runId);
  await maybeCompleteRun(client, runId, workflowSpec);
}

async function runPlainStep(client, row, workflowSpec) {
  const ctx = await loadRunContext(client, row.run_id);
  const inputs = resolveReads(row.node_def.reads, ctx);
  const output = callFunction(row.node_def.function, inputs);

  await client.query(`INSERT INTO ir.checkpoints (execution_id, step_id, output) VALUES ($1, $2, $3)`, [
    row.id,
    row.node_id,
    JSON.stringify(output),
  ]);
  await client.query(`UPDATE ir.executions SET status = 'done', updated_at = now() WHERE id = $1`, [row.id]);
  await finishTopLevelNode(client, row.run_id, row.node_id, output, workflowSpec);
}

async function runMapChildStep(client, row) {
  // Internal child: item comes from the parent map's source array at
  // map_index, resolved once at fan-out time and stashed on the child's own
  // node_def.reads via {from:"item"} - resolveBinding needs `ctx.item`.
  const ctx = { requestParams: {}, nodeOutputs: new Map(), item: row.node_def.__item };
  const inputs = resolveReads(row.node_def.reads, ctx);
  const output = callFunction(row.node_def.function, inputs);

  await client.query(`INSERT INTO ir.checkpoints (execution_id, step_id, output) VALUES ($1, $2, $3)`, [
    row.id,
    row.node_id,
    JSON.stringify(output),
  ]);
  await client.query(`UPDATE ir.executions SET status = 'done', updated_at = now() WHERE id = $1`, [row.id]);

  const { rows: mnRows } = await client.query(
    `SELECT * FROM ir.map_nodes WHERE execution_id = $1 FOR UPDATE`,
    [row.parent_execution_id]
  );
  const mn = mnRows[0];
  const completed = mn.completed_children + 1;
  await client.query(`UPDATE ir.map_nodes SET completed_children = $2 WHERE execution_id = $1`, [
    row.parent_execution_id,
    completed,
  ]);
  if (completed === mn.total_children) {
    await client.query(`UPDATE ir.executions SET status = 'queued', updated_at = now() WHERE id = $1`, [
      row.parent_execution_id,
    ]);
  }
}

async function runBranchCaseStep(client, row) {
  // Internal case step: same binding surface as a plain top-level step
  // (request/item aren't typically both relevant here; our example's case
  // steps only read {from:"request"}), resolved with the run's own context.
  const ctx = await loadRunContext(client, row.run_id);
  const inputs = resolveReads(row.node_def.reads, ctx);
  const output = callFunction(row.node_def.function, inputs);

  await client.query(`INSERT INTO ir.checkpoints (execution_id, step_id, output) VALUES ($1, $2, $3)`, [
    row.id,
    row.node_id,
    JSON.stringify(output),
  ]);
  await client.query(`UPDATE ir.executions SET status = 'done', updated_at = now() WHERE id = $1`, [row.id]);

  const { rows: bnRows } = await client.query(
    `SELECT * FROM ir.branch_nodes WHERE execution_id = $1 FOR UPDATE`,
    [row.parent_execution_id]
  );
  const bn = bnRows[0];
  const completed = bn.completed_children + 1;
  await client.query(`UPDATE ir.branch_nodes SET completed_children = $2 WHERE execution_id = $1`, [
    row.parent_execution_id,
    completed,
  ]);
  if (completed === bn.total_children) {
    await client.query(`UPDATE ir.executions SET status = 'queued', updated_at = now() WHERE id = $1`, [
      row.parent_execution_id,
    ]);
  }
}

async function runBranchNode(client, row, workflowSpec) {
  const { rows: existing } = await client.query(`SELECT 1 FROM ir.branch_nodes WHERE execution_id = $1`, [row.id]);

  if (existing.length === 0) {
    // FIRST claim: resolve the selector, pick a case, fan out its (single)
    // step as a child execution - exactly analogous to map's fan-out.
    const ctx = await loadRunContext(client, row.run_id);
    const selectorValue = resolveBinding(row.node_def.selector, ctx);
    const caseKey = String(selectorValue) in row.node_def.cases ? String(selectorValue) : "default";
    const chosenCase = row.node_def.cases[caseKey];
    if (!chosenCase) throw new Error(`branch ${row.node_id}: no case matches '${caseKey}' and no default`);
    if (chosenCase.steps.length !== 1) {
      throw new Error(`branch ${row.node_id}: this spike only supports exactly one step per case (got ${chosenCase.steps.length})`);
    }
    const step = chosenCase.steps[0];

    await client.query(
      `INSERT INTO ir.executions (run_id, node_id, kind, parent_execution_id, node_def, status)
       VALUES ($1, $2, 'step', $3, $4, 'queued')`,
      [row.run_id, step.id, row.id, JSON.stringify(step)]
    );
    await client.query(
      `INSERT INTO ir.branch_nodes (execution_id, selected_case, total_children) VALUES ($1, $2, 1)`,
      [row.id, caseKey]
    );
    await client.query(`UPDATE ir.executions SET status = 'awaiting_children', worker_id = NULL, lease_until = NULL, updated_at = now() WHERE id = $1`, [
      row.id,
    ]);
    return { kind: "branch-fanout", caseKey };
  }

  // REJOIN claim: the case's one step is done - compute this branch's own
  // `yields` by reading that step's checkpoint DIRECTLY (never through the
  // run-wide run_node_outputs map - a case's internal step id is not, and
  // must not be, addressable from outside the branch; this mirrors D8c's
  // "rejection of direct references to a case's internal step ids" as a
  // structural property of the implementation, not just a validation rule).
  const bn = (await client.query(`SELECT * FROM ir.branch_nodes WHERE execution_id = $1`, [row.id])).rows[0];
  const chosenCase = row.node_def.cases[bn.selected_case];
  const stepId = chosenCase.steps[0].id;
  const { rows: ckRows } = await client.query(
    `SELECT ck.output FROM ir.checkpoints ck
     JOIN ir.executions e ON e.id = ck.execution_id
     WHERE e.parent_execution_id = $1 AND e.node_id = $2`,
    [row.id, stepId]
  );
  const stepOutput = ckRows[0].output;

  // NOTE: `yields` is declared PER-CASE in this IR (matching design.md
  // D8c's actual branch shape: each case has its own `yields`, since
  // different cases may produce different output shapes) - NOT as a single
  // shared field on the branch node itself. Using `chosenCase.yields` here
  // (not `row.node_def.yields`, which doesn't exist) was a real bug caught
  // by actually running this against Postgres, not just reading the code.
  const yieldsCtx = { requestParams: {}, nodeOutputs: new Map([[stepId, stepOutput]]) };
  const yields = resolveReads(chosenCase.yields, yieldsCtx);

  await client.query(`UPDATE ir.executions SET status = 'done', updated_at = now() WHERE id = $1`, [row.id]);
  await finishTopLevelNode(client, row.run_id, row.node_id, yields, workflowSpec);
  return { kind: "branch-join", caseKey: bn.selected_case, yields };
}

async function runMapNode(client, row, workflowSpec) {
  const { rows: existing } = await client.query(`SELECT * FROM ir.map_nodes WHERE execution_id = $1`, [row.id]);

  if (existing.length === 0) {
    const ctx = await loadRunContext(client, row.run_id);
    const source = resolveBinding(row.node_def.source, ctx);
    if (!Array.isArray(source)) throw new Error(`map ${row.node_id}: source did not resolve to an array`);
    if (row.node_def.body.length !== 1) {
      throw new Error(`map ${row.node_id}: this spike only supports exactly one step per map body (got ${row.node_def.body.length})`);
    }
    const bodyStep = row.node_def.body[0];

    for (let i = 0; i < source.length; i++) {
      const childDef = { ...bodyStep, __item: source[i] };
      await client.query(
        `INSERT INTO ir.executions (run_id, node_id, kind, parent_execution_id, map_index, node_def, status)
         VALUES ($1, $2, 'step', $3, $4, $5, 'queued')`,
        [row.run_id, bodyStep.id, row.id, i, JSON.stringify(childDef)]
      );
    }
    await client.query(`INSERT INTO ir.map_nodes (execution_id, total_children, source) VALUES ($1, $2, $3)`, [
      row.id,
      source.length,
      JSON.stringify(source),
    ]);
    await client.query(`UPDATE ir.executions SET status = 'awaiting_children', worker_id = NULL, lease_until = NULL, updated_at = now() WHERE id = $1`, [
      row.id,
    ]);
    return { kind: "map-fanout", n: source.length };
  }

  // REJOIN: collect each child's checkpoint, ordered by map_index, into
  // parallel arrays per yield key - identical join semantics to spike 1.8.
  const bodyStepId = row.node_def.body[0].id;
  const { rows: childRows } = await client.query(
    `SELECT e.map_index, ck.output FROM ir.executions e
     JOIN ir.checkpoints ck ON ck.execution_id = e.id AND ck.step_id = $2
     WHERE e.parent_execution_id = $1
     ORDER BY e.map_index ASC`,
    [row.id, bodyStepId]
  );

  const yields = {};
  for (const [yieldName, binding] of Object.entries(row.node_def.yields)) {
    yields[yieldName] = childRows.map((c) => c.output[binding.output]);
  }

  await client.query(`UPDATE ir.executions SET status = 'done', updated_at = now() WHERE id = $1`, [row.id]);
  await finishTopLevelNode(client, row.run_id, row.node_id, yields, workflowSpec);
  return { kind: "map-join", n: childRows.length };
}

// ---------------------------------------------------------------------------
// The one generic claim-and-dispatch loop, shared by every node kind.
// ---------------------------------------------------------------------------

export async function processOne(pool, workerId, workflowSpec) {
  const client = await pool.connect();
  const swallowError = () => {};
  client.on("error", swallowError);
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM ir.claim_execution($1, 30)`, [workerId]);
    const row = rows[0];
    if (!row || row.id === null) {
      await client.query("ROLLBACK");
      return null;
    }

    let result;
    if (row.parent_execution_id !== null) {
      // Internal child - either a map child or a branch-case step. Tell
      // them apart by checking which bookkeeping table has a row for the
      // parent (cheap, and the parent's `kind` column would also work).
      const { rows: parentRows } = await client.query(`SELECT kind FROM ir.executions WHERE id = $1`, [
        row.parent_execution_id,
      ]);
      if (parentRows[0].kind === "map") {
        await runMapChildStep(client, row);
      } else {
        await runBranchCaseStep(client, row);
      }
      result = { kind: "child-step" };
    } else if (row.kind === "step") {
      await runPlainStep(client, row, workflowSpec);
      result = { kind: "step" };
    } else if (row.kind === "branch") {
      result = await runBranchNode(client, row, workflowSpec);
    } else if (row.kind === "map") {
      result = await runMapNode(client, row, workflowSpec);
    } else {
      throw new Error(`unknown execution kind '${row.kind}'`);
    }

    await client.query("COMMIT");
    return { row, result };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may be dead */
    }
    throw err;
  } finally {
    client.off("error", swallowError);
    client.release();
  }
}

export async function workerLoop(pool, workerId, workflowSpec, { maxIdlePolls = 5, pollDelayMs = 20 } = {}) {
  let idle = 0;
  let processed = 0;
  while (idle < maxIdlePolls) {
    const result = await processOne(pool, workerId, workflowSpec);
    if (result) {
      processed++;
      idle = 0;
    } else {
      idle++;
      await new Promise((r) => setTimeout(r, pollDelayMs));
    }
  }
  return processed;
}

export async function getRun(pool, runId) {
  const { rows } = await pool.query(`SELECT * FROM ir.workflow_runs WHERE id = $1`, [runId]);
  return rows[0];
}
