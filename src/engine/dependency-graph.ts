import type { Binding, Step } from "../workflow-spec/index.js";

// Task 6.2a (docs/impl-plans/0006-interpreter-plain-steps.md), design.md
// D8/D8a. Pure, no I/O - mirrors spike 1.5's own `externalDepsOf`: a
// generic walk for `{from:"step", id}` references, independent of
// whether that binding kind is resolvable yet by engine/bindings.ts (see
// the plan doc's "Open questions" - dependency inference and binding
// resolution are deliberately decoupled).

/** Recursively collects every `{from:"step", id}` reference reachable
 * from `binding` - including one nested inside a `compute` binding's
 * `using` map or an `itemResource` binding's `itemId`, even though
 * neither `compute` nor `itemResource` is resolvable yet (task 6.2b).
 * Local-review fix: `itemResource.itemId` is itself a `Binding` (it can
 * be `{from:"step", ...}`) and was previously not walked, silently
 * dropping that dependency from the graph despite this function's own
 * "every... reference reachable from binding" contract. */
export function collectStepBindingIds(binding: Binding): string[] {
  if ("from" in binding && binding.from === "step") {
    return [binding.id];
  }
  if ("compute" in binding) {
    return Object.values(binding.using ?? {}).flatMap(collectStepBindingIds);
  }
  if ("from" in binding && binding.from === "itemResource") {
    return collectStepBindingIds(binding.itemId);
  }
  return [];
}

/** The union of a step's explicit `dependsOn` (D8a's escape hatch for
 * steps with no data dependency) and every `{from:"step"}` id found
 * (possibly nested) across its `reads` bindings - deduplicated. */
export function computeStepDependencies(step: Step): string[] {
  const fromReads = Object.values(step.reads ?? {}).flatMap(collectStepBindingIds);
  const explicit = step.dependsOn ?? [];
  return Array.from(new Set([...explicit, ...fromReads]));
}
