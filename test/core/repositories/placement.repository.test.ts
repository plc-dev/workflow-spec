import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";
import { resetPlacementTables } from "../../helpers/reset.js";

// TC-2/TC-3 (docs/impl-plans/0005-placement.md): PlacementRepo's read
// path never errors on a miss, and upsertAccess folds partial updates via
// COALESCE without clobbering fields the caller didn't supply.
describe("PlacementRepo", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  beforeEach(async () => {
    await resetPlacementTables(tp.pool);
  });

  // TC-2: a never-seen content hash resolves to null, not an error.
  it("findByContentHash returns null for a never-seen content hash", async () => {
    const result = await withTransaction(tp.pool, (repos) =>
      repos.placement.findByContentHash("no-such-hash"),
    );
    expect(result).toBeNull();
  });

  // TC-3: a first-seen upsertAccess creates a row with access_count = 1.
  it("upsertAccess creates a first-seen row with accessCount 1", async () => {
    const placement = await withTransaction(tp.pool, (repos) =>
      repos.placement.upsertAccess({ contentHash: "h1", interactivity: "interactive" }),
    );
    expect(placement.accessCount).toBe(1);
    expect(placement.interactivity).toBe("interactive");
    expect(placement.pinned).toBe(false);
  });

  // TC-3: a second call with different fields updates those fields via
  // COALESCE while leaving previously-set fields the second call didn't
  // supply intact.
  it("upsertAccess folds a second access without clobbering unspecified fields", async () => {
    await withTransaction(tp.pool, (repos) =>
      repos.placement.upsertAccess({
        contentHash: "h2",
        interactivity: "interactive",
        declaredCostClass: "expensive",
      }),
    );

    const second = await withTransaction(tp.pool, (repos) =>
      repos.placement.upsertAccess({ contentHash: "h2", sizeBytes: 1024 }),
    );

    expect(second.accessCount).toBe(2);
    // interactivity/declaredCostClass from the first call survive because
    // the second call's COALESCE arguments for them were null.
    expect(second.interactivity).toBe("interactive");
    expect(second.declaredCostClass).toBe("expensive");
    expect(second.sizeBytes).toBe(1024);
  });

  it("setPinned pins and unpins, clearing pinnedAt on unpin", async () => {
    await withTransaction(tp.pool, (repos) => repos.placement.upsertAccess({ contentHash: "h3" }));

    const pinned = await withTransaction(tp.pool, (repos) => repos.placement.setPinned("h3", true));
    expect(pinned.pinned).toBe(true);
    expect(pinned.pinnedAt).not.toBeNull();

    const unpinned = await withTransaction(tp.pool, (repos) =>
      repos.placement.setPinned("h3", false),
    );
    expect(unpinned.pinned).toBe(false);
    expect(unpinned.pinnedAt).toBeNull();
  });

  it("setPinned throws a structured error for a content hash with no row", async () => {
    await expect(
      withTransaction(tp.pool, (repos) => repos.placement.setPinned("no-such-hash", true)),
    ).rejects.toThrow(/found no existing row/);
  });

  it("listPinnedOrderedByLru returns only pinned rows, LRU-first", async () => {
    await withTransaction(tp.pool, async (repos) => {
      await repos.placement.upsertAccess({
        contentHash: "old",
        at: new Date(Date.now() - 10_000),
      });
      await repos.placement.upsertAccess({ contentHash: "new", at: new Date() });
      await repos.placement.upsertAccess({ contentHash: "unpinned-only" });
      await repos.placement.setPinned("old", true);
      await repos.placement.setPinned("new", true);
    });

    const pinned = await withTransaction(tp.pool, (repos) =>
      repos.placement.listPinnedOrderedByLru(),
    );
    expect(pinned.map((p) => p.contentHash)).toEqual(["old", "new"]);
  });
});
