import { collectStepBindingIds, collectStepReferenceIds } from "../workflow-spec/index.js";
import type { Step } from "../workflow-spec/index.js";

// Task 6.2a (docs/impl-plans/0006-interpreter-plain-steps.md), design.md
// D8/D8a. `collectStepBindingIds`/`collectStepReferenceIds` themselves now
// live in `workflow-spec/` (docs/impl-plans/0009-dsl-compiler-plain-
// steps.md's review - promoted out of here once `dsl-compiler/semantic-
// validation.ts` independently grew its own copies of these exact walks)
// - re-exported from here so `engine/index.ts`'s existing surface doesn't
// change.
export { collectStepBindingIds };

/** The union of a step's explicit `dependsOn` (D8a's escape hatch for
 * steps with no data dependency) and every `{from:"step"}` id found
 * (possibly nested) across its `reads` bindings - deduplicated. */
export function computeStepDependencies(step: Step): string[] {
  return Array.from(new Set(collectStepReferenceIds(step)));
}
