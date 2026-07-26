// The mapped domain shape of a `placement_config` row's `config` JSONB
// blob (design.md D4a - starting-default thresholds exposed as tunable,
// named scheduler parameters, not hardcoded constants). The TypeScript
// fallback used when no named profile row exists
// (`DEFAULT_PLACEMENT_CONFIG`) lives in `scheduler/constants.ts`, not
// here - this file only types the shape a row maps to.
export interface PlacementConfig {
  promotion: {
    frequencyThreshold: number;
    frequencyWindowMs: number;
    rehydrationCostThresholdMs: number;
  };
  demotion: {
    idleThresholdMs: number;
  };
  capacity: {
    pinnedBudgetBytes: number;
  };
  cost: {
    observedMinSamples: number;
    classPriorsMs: Record<"trivial" | "cheap" | "moderate" | "expensive", number>;
  };
}
