import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/core/index.js";
import { appendEntry, replaySession, rewindSession } from "../../src/session/index.js";
import { type TestPostgres, startTestPostgres } from "../helpers/postgres.js";

describe("session.appendEntry / rewindSession / replaySession", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await tp.pool.query("TRUNCATE session_log, session_pointer");
  });

  // TC-2: appendEntry on a session with no prior session_pointer row
  // creates one and assigns sequence 1.
  it("creates a pointer and assigns sequence 1 on a session's first entry", async () => {
    const entry = await withTransaction(tp.pool, (repos) =>
      appendEntry(repos, "s1", { action: "run" }),
    );
    expect(entry.sequence).toBe(1);

    const { rows } = await tp.pool.query<{ current_sequence: string }>(
      "SELECT current_sequence FROM session_pointer WHERE session_id = $1",
      ["s1"],
    );
    expect(Number(rows[0]?.current_sequence)).toBe(1);
  });

  // TC-3: sequential appends get sequences 1..N with no gaps, replayable
  // in order.
  it("assigns sequential sequence numbers and replays them in order", async () => {
    for (let i = 0; i < 5; i++) {
      await withTransaction(tp.pool, (repos) => appendEntry(repos, "s2", { i }));
    }

    const history = await withTransaction(tp.pool, (repos) => replaySession(repos, "s2"));
    expect(history.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(history.map((e) => (e.input as { i: number }).i)).toEqual([0, 1, 2, 3, 4]);
  });

  // TC-4: concurrent appendEntry calls for the SAME session serialize via
  // session_pointer's row lock (design.md D3 linear-per-session-mutation)
  // - no lost writes, no duplicate/gapped sequences.
  it("serializes concurrent appends to the same session with no lost writes", async () => {
    const concurrency = 10;
    await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        withTransaction(tp.pool, (repos) => appendEntry(repos, "s3", { i })),
      ),
    );

    const history = await withTransaction(tp.pool, (repos) => replaySession(repos, "s3"));
    expect(history.map((e) => e.sequence)).toEqual(
      Array.from({ length: concurrency }, (_, i) => i + 1),
    );

    const { rows } = await tp.pool.query<{ current_sequence: string }>(
      "SELECT current_sequence FROM session_pointer WHERE session_id = $1",
      ["s3"],
    );
    expect(Number(rows[0]?.current_sequence)).toBe(concurrency);
  });

  // TC-5: concurrent appends for DIFFERENT sessions don't contend with
  // each other - each session's own sequence is still exactly 1..N.
  it("keeps each session's own sequence correct when appending to different sessions concurrently", async () => {
    const perSessionCount = 5;
    const sessions = ["sA", "sB"];
    const calls = sessions.flatMap((sessionId) =>
      Array.from({ length: perSessionCount }, (_, i) =>
        withTransaction(tp.pool, (repos) => appendEntry(repos, sessionId, { sessionId, i })),
      ),
    );
    await Promise.all(calls);

    for (const sessionId of sessions) {
      const history = await withTransaction(tp.pool, (repos) => replaySession(repos, sessionId));
      expect(history.map((e) => e.sequence)).toEqual(
        Array.from({ length: perSessionCount }, (_, i) => i + 1),
      );
      expect(history.every((e) => (e.input as { sessionId: string }).sessionId === sessionId)).toBe(
        true,
      );
    }
  });

  // TC-5 (local-review fix, docs/impl-plans/0003-session-log.md
  // "Post-review fixes"): the ABOVE test only proves per-session
  // correctness under interleaving - it would still pass if every session
  // serialized behind one global lock. This test proves the actual
  // non-contention property design.md D3's diagram requires: a held
  // pointer lock for one session must never block an append to a
  // DIFFERENT session. Session A's transaction is deliberately kept open
  // (lock held, not yet committed) while session B's full appendEntry is
  // awaited with a short timeout - if B's append were queued behind A's
  // lock, this would resolve "timed-out", not "completed".
  it("does not block an append to a different session while another session's pointer lock is held open", async () => {
    let releaseSessionA: () => void = () => {};
    const holdUntilReleased = new Promise<void>((resolve) => {
      releaseSessionA = resolve;
    });

    const sessionATransaction = withTransaction(tp.pool, async (repos) => {
      await repos.sessionPointer.lock("sA-held");
      await holdUntilReleased;
    });

    const sessionBAppend = withTransaction(tp.pool, (repos) =>
      appendEntry(repos, "sB-unblocked", { ok: true }),
    );

    const outcome = await Promise.race([
      sessionBAppend.then(() => "completed" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 2_000)),
    ]);
    expect(outcome).toBe("completed");

    releaseSessionA();
    await sessionATransaction;
  });

  // TC-6: rewindSession only moves the pointer - the abandoned rows still
  // physically exist immediately afterward (design.md D3a, taken
  // literally: deletion is deferred to the next mutation).
  it("rewind moves the pointer without deleting any session_log rows", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await appendEntry(repos, "s4", { i: 0 });
      await appendEntry(repos, "s4", { i: 1 });
      await appendEntry(repos, "s4", { i: 2 });
    });

    const pointer = await withTransaction(tp.pool, (repos) => rewindSession(repos, "s4", 1));
    expect(pointer.currentSequence).toBe(1);

    const { rows } = await tp.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM session_log WHERE session_id = $1",
      ["s4"],
    );
    expect(rows[0]?.count).toBe("3");
  });

  // Regression test (local-review fix, docs/impl-plans/0003-session-log
  // .md "Post-review fixes"): replaySession must exclude the abandoned
  // tail a rewind leaves behind, even though those rows still physically
  // exist (proven by the test above) - it must reflect the POINTER's
  // view of the session, not the raw table. This is exactly the gap
  // between rewinding and the next append that the original
  // implementation got wrong (replaySession delegated to a query with no
  // pointer bound at all).
  it("replaySession excludes the abandoned tail immediately after a rewind, before any new append", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await appendEntry(repos, "s4b", { i: 0 });
      await appendEntry(repos, "s4b", { i: 1 });
      await appendEntry(repos, "s4b", { i: 2 });
    });

    const pointer = await withTransaction(tp.pool, (repos) => rewindSession(repos, "s4b", 1));

    const history = await withTransaction(tp.pool, (repos) => replaySession(repos, "s4b"));
    expect(history).toHaveLength(pointer.currentSequence);
    expect(history.map((e) => e.sequence)).toEqual([1]);
  });

  // TC-7: a new appendEntry after a rewind truncates the abandoned
  // forward tail and reuses its sequence number - the full D3a decision.
  it("truncates the abandoned tail and reuses its sequence on the next append after rewind", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await appendEntry(repos, "s5", { i: 0 }); // sequence 1
      await appendEntry(repos, "s5", { i: 1 }); // sequence 2
      await appendEntry(repos, "s5", { i: 2 }); // sequence 3
    });

    await withTransaction(tp.pool, (repos) => rewindSession(repos, "s5", 1));

    const newEntry = await withTransaction(tp.pool, (repos) =>
      appendEntry(repos, "s5", { i: "new" }),
    );
    expect(newEntry.sequence).toBe(2);

    const history = await withTransaction(tp.pool, (repos) => replaySession(repos, "s5"));
    expect(history.map((e) => e.sequence)).toEqual([1, 2]);
    expect(history[1]?.input).toEqual({ i: "new" });
  });

  // TC-8: rewind out of range (negative, or ahead of current) throws and
  // leaves the pointer untouched.
  it("rejects a rewind target outside [0, currentSequence] and leaves the pointer unchanged", async () => {
    await withTransaction(tp.pool, (repos) => appendEntry(repos, "s6", { i: 0 }));

    await expect(
      withTransaction(tp.pool, (repos) => rewindSession(repos, "s6", -1)),
    ).rejects.toThrow(/target sequence is negative or ahead/);
    await expect(
      withTransaction(tp.pool, (repos) => rewindSession(repos, "s6", 2)),
    ).rejects.toThrow(/target sequence is negative or ahead/);

    const { rows } = await tp.pool.query<{ current_sequence: string }>(
      "SELECT current_sequence FROM session_pointer WHERE session_id = $1",
      ["s6"],
    );
    expect(Number(rows[0]?.current_sequence)).toBe(1);
  });

  // TC-9: rewinding to the current sequence is a safe no-op.
  it("rewinding to the current sequence is a no-op", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await appendEntry(repos, "s7", { i: 0 });
      await appendEntry(repos, "s7", { i: 1 });
    });

    const before = await tp.pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM session_pointer WHERE session_id = $1",
      ["s7"],
    );

    const pointer = await withTransaction(tp.pool, (repos) => rewindSession(repos, "s7", 2));
    expect(pointer.currentSequence).toBe(2);

    const after = await tp.pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM session_pointer WHERE session_id = $1",
      ["s7"],
    );
    expect(after.rows[0]?.updated_at).toEqual(before.rows[0]?.updated_at);

    const { rows: logRows } = await tp.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM session_log WHERE session_id = $1",
      ["s7"],
    );
    expect(logRows[0]?.count).toBe("2");
  });

  // TC-10: a mid-transaction crash during a plain appendEntry rolls back
  // both the session_log insert and the session_pointer creation/advance
  // together (design.md D6/R6 DEEP atomicity, applied to this new
  // primitive).
  it("rolls back appendEntry entirely on a mid-transaction crash", async () => {
    await expect(
      withTransaction(tp.pool, async (repos) => {
        await appendEntry(repos, "s8", { i: 0 });

        const pidResult = await repos.client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = pidResult.rows[0]?.pid;
        await tp.adminPool.query("SELECT pg_terminate_backend($1)", [pid]);
        await repos.client.query("SELECT 1");
      }),
    ).rejects.toThrow();

    const { rows: logRows } = await tp.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM session_log WHERE session_id = $1",
      ["s8"],
    );
    expect(logRows[0]?.count).toBe("0");

    const { rows: pointerRows } = await tp.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM session_pointer WHERE session_id = $1",
      ["s8"],
    );
    expect(pointerRows[0]?.count).toBe("0");
  });

  // TC-11: a mid-transaction crash during a truncate-then-append (after a
  // rewind) rolls back the DELETE too - no half-truncated state survives.
  it("rolls back a post-rewind append's truncation entirely on a mid-transaction crash", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await appendEntry(repos, "s9", { i: 0 }); // sequence 1
      await appendEntry(repos, "s9", { i: 1 }); // sequence 2
    });
    await withTransaction(tp.pool, (repos) => rewindSession(repos, "s9", 1));

    await expect(
      withTransaction(tp.pool, async (repos) => {
        await appendEntry(repos, "s9", { i: "new" });

        const pidResult = await repos.client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = pidResult.rows[0]?.pid;
        await tp.adminPool.query("SELECT pg_terminate_backend($1)", [pid]);
        await repos.client.query("SELECT 1");
      }),
    ).rejects.toThrow();

    // The old sequence-2 row (the "abandoned tail") must still exist - the
    // DELETE that would have removed it rolled back along with everything
    // else in that crashed transaction.
    const { rows } = await tp.pool.query<{ sequence: string; input: unknown }>(
      "SELECT sequence, input FROM session_log WHERE session_id = $1 ORDER BY sequence",
      ["s9"],
    );
    expect(rows.map((r) => Number(r.sequence))).toEqual([1, 2]);
    expect(rows[1]?.input).toEqual({ i: 1 });

    const { rows: pointerRows } = await tp.pool.query<{ current_sequence: string }>(
      "SELECT current_sequence FROM session_pointer WHERE session_id = $1",
      ["s9"],
    );
    expect(Number(pointerRows[0]?.current_sequence)).toBe(1);
  });
});
