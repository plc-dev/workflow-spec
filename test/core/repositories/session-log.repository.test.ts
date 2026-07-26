import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";

// SessionLogRepo.append/deleteAfter/listBySession, exercised at the repo
// level - composed behavior (appendEntry/rewindSession) is covered in
// test/session/session-log.test.ts (docs/impl-plans/0003-session-log.md).
describe("SessionLogRepo", () => {
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

  it("appends an entry at the given sequence", async () => {
    const entry = await withTransaction(tp.pool, (repos) =>
      repos.sessionLog.append({ sessionId: "s1", sequence: 1, input: { action: "run" } }),
    );
    expect(entry).toEqual({
      id: expect.any(Number),
      sessionId: "s1",
      sequence: 1,
      input: { action: "run" },
      createdAt: expect.any(Date),
    });
  });

  it("listBySession returns entries ordered by sequence ascending", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await repos.sessionLog.append({ sessionId: "s2", sequence: 2, input: "b" });
      await repos.sessionLog.append({ sessionId: "s2", sequence: 1, input: "a" });
      await repos.sessionLog.append({ sessionId: "s2", sequence: 3, input: "c" });
    });

    const entries = await withTransaction(tp.pool, (repos) => repos.sessionLog.listBySession("s2"));
    expect(entries.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.input)).toEqual(["a", "b", "c"]);
  });

  it("deleteAfter removes only rows past the given sequence, for that session only", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await repos.sessionLog.append({ sessionId: "s3", sequence: 1, input: "a" });
      await repos.sessionLog.append({ sessionId: "s3", sequence: 2, input: "b" });
      await repos.sessionLog.append({ sessionId: "s3", sequence: 3, input: "c" });
      await repos.sessionLog.append({ sessionId: "other", sequence: 1, input: "unrelated" });
    });

    await withTransaction(tp.pool, (repos) => repos.sessionLog.deleteAfter("s3", 1));

    const s3Entries = await withTransaction(tp.pool, (repos) =>
      repos.sessionLog.listBySession("s3"),
    );
    expect(s3Entries.map((e) => e.sequence)).toEqual([1]);

    const otherEntries = await withTransaction(tp.pool, (repos) =>
      repos.sessionLog.listBySession("other"),
    );
    expect(otherEntries).toHaveLength(1);
  });

  it("deleteAfter is a no-op when nothing is past the given sequence", async () => {
    await withTransaction(tp.pool, (repos) =>
      repos.sessionLog.append({ sessionId: "s4", sequence: 1, input: "a" }),
    );

    await expect(
      withTransaction(tp.pool, (repos) => repos.sessionLog.deleteAfter("s4", 1)),
    ).resolves.not.toThrow();

    const entries = await withTransaction(tp.pool, (repos) => repos.sessionLog.listBySession("s4"));
    expect(entries).toHaveLength(1);
  });
});
