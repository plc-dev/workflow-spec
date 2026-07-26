import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";

// TC-11 (docs/impl-plans/0005-placement.md): the seeded 'default' profile
// is the data-as-config mechanism D4a asks for - this repo makes no
// fallback judgment call itself (that's scheduler/'s job). The expected
// values below are deliberately inlined (not imported from
// scheduler/constants.ts's DEFAULT_PLACEMENT_CONFIG) so this core/-level
// test does not depend on the scheduler/ module existing/matching -
// scheduler/placement.test.ts is where the two being kept in sync is
// actually exercised (TC-11's own cross-check).
const EXPECTED_SEEDED_DEFAULT_CONFIG = {
  promotion: {
    frequencyThreshold: 3,
    frequencyWindowMs: 420_000,
    rehydrationCostThresholdMs: 250,
  },
  demotion: { idleThresholdMs: 1_200_000 },
  capacity: { pinnedBudgetBytes: 1_073_741_824 },
  cost: {
    observedMinSamples: 5,
    classPriorsMs: { trivial: 10, cheap: 50, moderate: 300, expensive: 2000 },
  },
};

describe("PlacementConfigRepo", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  it("load('default') returns the seeded row, matching the documented D4a starting defaults field-for-field", async () => {
    const config = await withTransaction(tp.pool, (repos) => repos.placementConfig.load("default"));
    expect(config).toEqual(EXPECTED_SEEDED_DEFAULT_CONFIG);
  });

  it("load returns null for a profile name with no row", async () => {
    const config = await withTransaction(tp.pool, (repos) =>
      repos.placementConfig.load("does-not-exist"),
    );
    expect(config).toBeNull();
  });
});
