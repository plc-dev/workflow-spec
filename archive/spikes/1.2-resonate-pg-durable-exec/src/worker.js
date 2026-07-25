import crypto from "node:crypto";

// Simulates the "SQL-execution service" materializing one user mutation
// against a session's dump and reporting a new content-hash.
function simulateMutate(prevHash, mutationIndex) {
  return crypto.createHash("sha256").update(`${prevHash}:${mutationIndex}`).digest("hex").slice(0, 16);
}

/**
 * Claims one queued execution and, in a SINGLE Postgres transaction, performs
 * all three of:
 *   1. the step-completion checkpoint (durability core, D6)
 *   2. the session-log append (D3)
 *   3. the placement-resolver upsert (D4)
 * then commits. This is the DEEP-consolidation claim under test: these three
 * concerns share one transaction boundary, not merely one Postgres instance.
 *
 * `hook` (optional) is called after the partial writes but BEFORE commit,
 * so crash tests can kill the connection mid-transaction.
 */
export async function processOneExecution(pool, workerId, { hook } = {}) {
  const client = await pool.connect();
  // A forcibly terminated backend (crash-test simulation) emits an 'error'
  // event on the client; without a listener, Node treats it as unhandled.
  // The pool reuses underlying Client objects across connect() calls, so
  // this listener is removed in `finally` to avoid accumulating one per call.
  const swallowError = () => {};
  client.on("error", swallowError);
  try {
    await client.query("BEGIN");

    const claimRes = await client.query(
      `SELECT * FROM spike.claim_execution($1, 30)`,
      [workerId]
    );
    const execRow = claimRes.rows[0];
    if (!execRow || execRow.id === null) {
      await client.query("ROLLBACK");
      return null;
    }

    const sessionId = execRow.session_id;
    const mutationIndex = execRow.input.mutationIndex;

    // D3's "ordinary SELECT...FOR UPDATE discipline": lock this session's
    // pointer row so concurrent workers touching the SAME session serialize.
    // Because the lock predicate is `WHERE session_id = $1`, Postgres only
    // locks that one row - workers on a DIFFERENT session_id lock a
    // different row and are not blocked by this one. test-contention.js
    // exercises this with two interleaved sessions to check the resulting
    // chains for cross-session contamination (see its header comment and
    // FINDINGS.md for what is/isn't measured).
    const ptrRes = await client.query(
      `SELECT * FROM spike.session_pointer WHERE session_id = $1 FOR UPDATE`,
      [sessionId]
    );
    const ptr = ptrRes.rows[0];
    const nextSeq = Number(ptr.head_seq) + 1;
    const nextHash = simulateMutate(ptr.head_hash, mutationIndex);

    // 1. session_log append (D3)
    await client.query(
      `INSERT INTO spike.session_log (session_id, seq, mutation) VALUES ($1, $2, $3)`,
      [sessionId, nextSeq, JSON.stringify({ mutationIndex, resultHash: nextHash })]
    );

    // 2. advance the session pointer
    await client.query(
      `UPDATE spike.session_pointer SET head_seq = $2, head_hash = $3 WHERE session_id = $1`,
      [sessionId, nextSeq, nextHash]
    );

    // 3. placement-resolver upsert (D4): this content-hash is now warm on `workerId`
    await client.query(
      `INSERT INTO spike.placement (content_hash, replica_id, session_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (content_hash) DO UPDATE SET replica_id = $2, updated_at = now()`,
      [nextHash, workerId, sessionId]
    );

    // 4. step-completion checkpoint (durability core)
    await client.query(
      `INSERT INTO spike.checkpoints (execution_id, step_id, output) VALUES ($1, $2, $3)`,
      [execRow.id, "sql_mutate", JSON.stringify({ resultHash: nextHash })]
    );
    await client.query(
      `UPDATE spike.executions SET status = 'done', updated_at = now() WHERE id = $1`,
      [execRow.id]
    );

    if (hook) {
      await hook({ client, execRow, sessionId, nextSeq, nextHash });
    }

    await client.query("COMMIT");
    return { execRow, sessionId, nextSeq, nextHash };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may already be dead (crash test) */
    }
    throw err;
  } finally {
    client.off("error", swallowError);
    client.release();
  }
}
