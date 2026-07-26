import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";

describe("PlacementAccessRepo", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await tp.pool.query("TRUNCATE placement_access");
  });

  it("countWithinWindow counts only accesses within the given window", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await repos.placementAccess.record("h1", new Date(Date.now() - 10 * 60_000)); // 10 min ago
      await repos.placementAccess.record("h1", new Date(Date.now() - 1 * 60_000)); // 1 min ago
      await repos.placementAccess.record("h1", new Date());
    });

    const count = await withTransaction(tp.pool, (repos) =>
      repos.placementAccess.countWithinWindow("h1", 7 * 60_000),
    );
    expect(count).toBe(2);
  });

  it("pruneOlderThan deletes only events older than the given window", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await repos.placementAccess.record("h2", new Date(Date.now() - 10 * 60_000));
      await repos.placementAccess.record("h2", new Date());
    });

    await withTransaction(tp.pool, (repos) =>
      repos.placementAccess.pruneOlderThan("h2", 7 * 60_000),
    );

    const count = await withTransaction(tp.pool, (repos) =>
      repos.placementAccess.countWithinWindow("h2", 24 * 60 * 60_000),
    );
    expect(count).toBe(1);
  });

  it("does not prune or count events for a different content hash", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await repos.placementAccess.record("h3", new Date(Date.now() - 10 * 60_000));
      await repos.placementAccess.record("h4", new Date(Date.now() - 10 * 60_000));
    });

    await withTransaction(tp.pool, (repos) => repos.placementAccess.pruneOlderThan("h3", 60_000));

    const h4Count = await withTransaction(tp.pool, (repos) =>
      repos.placementAccess.countWithinWindow("h4", 24 * 60 * 60_000),
    );
    expect(h4Count).toBe(1);
  });
});
