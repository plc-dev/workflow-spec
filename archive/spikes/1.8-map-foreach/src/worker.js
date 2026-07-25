// Spike 1.8 worker: the durable-execution loop of spike 1.2, taught to handle
// D8's `map`/`forEach` fan-out and D8c's ordered join, on top of D9's
// child/step-execution primitive.
//
// One generic entry point, `processOne`, claims ONE queued execution (map
// node, map child, or standalone step - all from the same queue, via the same
// SKIP LOCKED claim) and dispatches on `kind`/state. This is deliberate: a map
// child is "just another execution row" (see schema.sql), so the same worker
// pool interleaves map children with unrelated standalone work - no worker
// babysits a whole map synchronously (design.md D9 "without the parent
// terminating"). A map node's lifecycle across MULTIPLE independent claims:
//
//   1. FAN-OUT   (kind='map', no map_nodes row yet): in ONE transaction,
//                 insert N child rows + the map_nodes row, then park the map
//                 node in 'awaiting_children' (NOT 'running' - it releases its
//                 worker immediately and is not re-claimable until re-queued).
//   2. (children processed independently, concurrently, by any workers)
//   3. JOIN      (kind='map', map_nodes row exists, re-queued to 'queued' by
//                 its last child): collect children's outputs into parallel
//                 arrays in original source order and mark the map node 'done'.

// The single-iteration STEP body. Statically shaped (known at compile time);
// here a trivial deterministic transform standing in for a real service call
// (design.md D8c's `enrichOne`). Kept intentionally dumb - this spike tests
// the fan-out/retry/join mechanics, not step semantics.
function enrichOne(item) {
  return { enriched: item * 2 };
}

const STEP_ID = "enrichOne";
const JOIN_STEP_ID = "join";

// Optional small random delay so that, under a multi-worker pool, children
// genuinely complete OUT OF SOURCE ORDER - making the ordered-join test a real
// test rather than a trivially-ordered one.
function jitter(maxMs) {
  if (!maxMs) return Promise.resolve();
  return new Promise((r) => setTimeout(r, Math.floor(Math.random() * maxMs)));
}

/**
 * Claim and fully handle one execution. Returns a small descriptor of what was
 * done (or null if the queue was empty), so tests can assert on it.
 *
 * opts.jitterMs   - max random delay injected inside child processing.
 * opts.onClaim    - test hook invoked with the claimed row (before work).
 */
export async function processOne(pool, workerId, opts = {}) {
  // Peek/claim first in its own short transaction is NOT what we do; following
  // spike 1.2, the claim lives inside the same transaction as the work so a
  // crash rolls the claim back too. We branch on the claimed row's kind.
  const client = await pool.connect();
  const swallow = () => {};
  client.on("error", swallow);
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM spike.claim_execution($1, 30)`, [workerId]);
    const row = rows[0];
    if (!row || row.id === null) {
      await client.query("ROLLBACK");
      return null;
    }

    if (opts.onClaim) await opts.onClaim(row);

    if (row.kind === "map") {
      // Is this the FAN-OUT claim or the JOIN claim? Decided by whether the
      // map_nodes row already exists (created atomically during fan-out).
      const { rows: mn } = await client.query(
        `SELECT * FROM spike.map_nodes WHERE execution_id = $1`,
        [row.id]
      );
      if (mn.length === 0) {
        return await fanOut(client, row);
      }
      return await join(client, row, mn[0]);
    }

    // kind === 'step': an ordinary unit of work (map child OR standalone).
    return await processStep(pool, client, row, opts);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may be dead */
    }
    throw err;
  } finally {
    client.off("error", swallow);
    client.release();
  }
}

// FAN-OUT: turn a map node into N durable child executions + a map_nodes row,
// atomically, then park the parent in 'awaiting_children'. The cardinality N
// comes from the runtime-sized `input.source` array (design.md D8: "only the
// iteration count is resolved at run time").
async function fanOut(client, row) {
  const source = row.input.source;
  if (!Array.isArray(source)) throw new Error(`map ${row.id} has no source array`);
  const n = source.length;

  // Per-item transient-failure injection for the independent-retry test:
  // input.failIndices maps "source index" -> "how many times that child
  // should fail before succeeding".
  const failMap = row.input.failIndices || {};

  for (let i = 0; i < n; i++) {
    await client.query(
      `INSERT INTO spike.executions
         (kind, parent_execution_id, map_index, step, input, fail_remaining)
       VALUES ('step', $1, $2, $3, $4, $5)`,
      [row.id, i, STEP_ID, JSON.stringify({ item: source[i] }), Number(failMap[i] || 0)]
    );
  }

  await client.query(
    `INSERT INTO spike.map_nodes (execution_id, total_children, source)
     VALUES ($1, $2, $3)`,
    [row.id, n, JSON.stringify(source)]
  );

  // Park the parent WITHOUT holding a worker: 'awaiting_children' is not
  // claimable (claim_execution only picks 'queued' or lease-expired 'running').
  await client.query(
    `UPDATE spike.executions SET status = 'awaiting_children', worker_id = NULL,
            lease_until = NULL, updated_at = now() WHERE id = $1`,
    [row.id]
  );

  await client.query("COMMIT");
  return { kind: "fanout", mapId: row.id, children: n };
}

// PROCESS a step (map child or standalone). Runs the static body, checkpoints
// its output exactly-once, marks itself done, and - if it is a map child - it
// bumps its parent's completion counter under FOR UPDATE and re-queues the
// parent for its join iff it was the last child to finish.
async function processStep(pool, client, row, opts) {
  // Independent-retry injection: if this execution still owes a transient
  // failure, model it as a COMMITTED FAILED ATTEMPT rather than a rollback.
  // We consume one owed failure (decrement), write NO checkpoint (the work did
  // not complete), and requeue the row for another attempt - all in this one
  // transaction. Committing this is what makes the injection race-free (SKIP
  // LOCKED already guarantees a single claimant, and the decrement is durable
  // so a re-claim sees fail_remaining lower) AND makes `attempts` persist
  // across the retry (a plain rollback would revert the attempt counter, as in
  // spike 1.2's crash Scenario 1). The failure is isolated to THIS row: no
  // other child's row, checkpoint, or the parent counter is touched.
  if (row.fail_remaining > 0) {
    await client.query(
      `UPDATE spike.executions
          SET fail_remaining = fail_remaining - 1,
              status = 'queued', worker_id = NULL, lease_until = NULL,
              updated_at = now()
        WHERE id = $1`,
      [row.id]
    );
    await client.query("COMMIT");
    return { kind: "retry", id: row.id, mapIndex: row.map_index, parentId: row.parent_execution_id };
  }

  await jitter(opts.jitterMs);

  const output = enrichOne(row.input.item);

  // Exactly-once step completion (UNIQUE(execution_id, step_id)).
  await client.query(
    `INSERT INTO spike.checkpoints (execution_id, step_id, output) VALUES ($1, $2, $3)
     ON CONFLICT (execution_id, step_id) DO NOTHING`,
    [row.id, STEP_ID, JSON.stringify(output)]
  );
  await client.query(
    `UPDATE spike.executions SET status = 'done', updated_at = now() WHERE id = $1`,
    [row.id]
  );

  let requeuedParentForJoin = false;
  if (row.parent_execution_id !== null) {
    // Serialize only the "am I the last child?" check per-parent by locking
    // the map_nodes row. Children still PROCESS concurrently; only this final
    // counter bump serializes briefly - and it makes last-child detection
    // exactly-once, so precisely one child re-queues the parent for its join.
    const { rows: mnRows } = await client.query(
      `UPDATE spike.map_nodes
         SET completed_children = completed_children + 1
       WHERE execution_id = $1
       RETURNING completed_children, total_children`,
      [row.parent_execution_id]
    );
    const mn = mnRows[0];
    if (mn && mn.completed_children === mn.total_children) {
      await client.query(
        `UPDATE spike.executions SET status = 'queued', updated_at = now() WHERE id = $1`,
        [row.parent_execution_id]
      );
      requeuedParentForJoin = true;
    }
  }

  await client.query("COMMIT");

  // Record TRUE wall-clock completion order across the whole pool (used by the
  // ordered-join test to prove children finish out of source order). Pushed
  // only after COMMIT, so it reflects genuine commit order, not claim order.
  if (opts.completionLog && row.parent_execution_id !== null) {
    opts.completionLog.push(row.map_index);
  }

  return {
    kind: "step",
    id: row.id,
    mapIndex: row.map_index,
    parentId: row.parent_execution_id,
    output,
    requeuedParentForJoin,
  };
}

// JOIN: all children done. Read their outputs ORDERED BY map_index (original
// source order, NOT completion order) and assemble parallel arrays. Exactly
// once via a checkpoint on the map node itself.
async function join(client, row, mapNode) {
  const { rows: children } = await client.query(
    `SELECT c.map_index, cp.output
       FROM spike.executions c
       JOIN spike.checkpoints cp ON cp.execution_id = c.id AND cp.step_id = $2
      WHERE c.parent_execution_id = $1
      ORDER BY c.map_index`,
    [row.id, STEP_ID]
  );

  if (children.length !== mapNode.total_children) {
    // Defensive: should not happen, since the parent is only re-queued after
    // the last child commits. Roll back and let a later claim retry.
    throw new Error(
      `join ${row.id}: ${children.length}/${mapNode.total_children} children ready`
    );
  }

  // Parallel arrays keyed by yielded name, indexed by original position.
  // design.md D8c: `{ from: step, id: enrichEach, output: enriched }` resolves
  // to the array of per-iteration `enriched` values.
  const enriched = new Array(mapNode.total_children);
  for (const child of children) {
    enriched[child.map_index] = child.output.enriched;
  }
  const yields = { enriched };

  await client.query(
    `INSERT INTO spike.map_results (execution_id, yields) VALUES ($1, $2)
     ON CONFLICT (execution_id) DO NOTHING`,
    [row.id, JSON.stringify(yields)]
  );
  await client.query(
    `INSERT INTO spike.checkpoints (execution_id, step_id, output) VALUES ($1, $2, $3)
     ON CONFLICT (execution_id, step_id) DO NOTHING`,
    [row.id, JOIN_STEP_ID, JSON.stringify({ count: mapNode.total_children })]
  );
  await client.query(
    `UPDATE spike.executions SET status = 'done', updated_at = now() WHERE id = $1`,
    [row.id]
  );

  await client.query("COMMIT");
  return { kind: "join", mapId: row.id, yields };
}

// A worker loop: keep claiming until the queue is empty. Because a map node
// parks itself in 'awaiting_children' during fan-out and is only re-queued by
// its last child, a loop can legitimately observe an empty queue while
// children are mid-flight on OTHER workers; callers running a fixed pool of
// these in parallel converge once every child (and the resulting join) drains.
export async function workerLoop(pool, workerId, opts = {}) {
  const done = [];
  let idleStreak = 0;
  // Tolerate transient empties: another worker may be about to re-queue a
  // parent for its join. Give up only after several consecutive empty claims.
  const maxIdle = opts.maxIdle ?? 5;
  while (idleStreak < maxIdle) {
    let result = null;
    try {
      result = await processOne(pool, workerId, opts);
    } catch (err) {
      done.push({ kind: "error", message: err.message });
      idleStreak = 0;
      continue;
    }
    if (!result) {
      idleStreak++;
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    idleStreak = 0;
    done.push(result);
  }
  return done;
}
