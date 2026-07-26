import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";

// SessionPointerRepo.lock/setSequence, exercised at the repo level -
// composed behavior (appendEntry/rewindSession) is covered in
// test/session/session-log.test.ts (docs/impl-plans/0003-session-log.md).
describe("SessionPointerRepo", () => {
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

  it("creates a pointer row with current_sequence = 0 on first lock", async () => {
    const pointer = await withTransaction(tp.pool, (repos) => repos.sessionPointer.lock("s1"));
    expect(pointer).toEqual({
      sessionId: "s1",
      currentSequence: 0,
      updatedAt: expect.any(Date),
    });
  });

  it("lock is idempotent - a second lock call returns the same row, not a new one", async () => {
    await withTransaction(tp.pool, (repos) => repos.sessionPointer.lock("s2"));
    await withTransaction(tp.pool, (repos) => repos.sessionPointer.lock("s2"));

    const { rows } = await tp.pool.query(
      "SELECT count(*)::int AS c FROM session_pointer WHERE session_id = $1",
      ["s2"],
    );
    expect(rows[0]?.c).toBe(1);
  });

  it("setSequence updates current_sequence and returns the updated row", async () => {
    await withTransaction(tp.pool, (repos) => repos.sessionPointer.lock("s3"));
    const updated = await withTransaction(tp.pool, (repos) =>
      repos.sessionPointer.setSequence("s3", 5),
    );
    expect(updated.currentSequence).toBe(5);

    const relocked = await withTransaction(tp.pool, (repos) => repos.sessionPointer.lock("s3"));
    expect(relocked.currentSequence).toBe(5);
  });
});
