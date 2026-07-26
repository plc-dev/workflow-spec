import type { Binding } from "./domain/binding.js";
import type { Step } from "./domain/node.js";

// design.md D8/D8a. Pure, no I/O - a generic walk for `{from:"step", id}`
// references, independent of whether that binding kind is resolvable yet
// by any particular consumer (`engine/bindings.ts`'s own resolver, or
// `dsl-compiler/`'s compile-time reference checks). Promoted here (out of
// `engine/dependency-graph.ts`, where it originated as task 6.2a's
// `computeStepDependencies` helper) because a second, independent copy of
// this exact walk was later written in `dsl-compiler/semantic-
// validation.ts` for task 5.2's own reference-resolution checks - a local
// code review flagged the drift risk (if a future `Binding` kind that
// nests another `Binding` is added and only one copy is updated,
// compile-time validation and runtime dependency inference would
// silently disagree). `workflow-spec/` is the one pure module both
// `engine/` and `dsl-compiler/` already depend on (ADR-0007), so it is
// this walk's single source of truth now.

/** Recursively collects every `{from:"step", id}` reference reachable
 * from `binding` - including one nested inside a `compute` binding's
 * `using` map or an `itemResource` binding's `itemId`, even though
 * neither `compute` nor `itemResource` is resolvable yet by
 * `engine/bindings.ts` (task 6.2b). Every other `Binding` kind
 * (`static`/`session`/`request`/`item`/`literal`) contributes nothing -
 * none of them can nest another `Binding`. */
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

/** D8/D8a: every step id a `Step` itself references - its explicit
 * `dependsOn` (the escape hatch for steps with no data dependency) plus
 * every `{from:"step"}` id found (possibly nested) across its `reads`
 * bindings, in that order, WITHOUT deduplication (a caller that wants a
 * deduplicated dependency set, like `engine/dependency-graph.ts`'s
 * `computeStepDependencies`, applies its own `Set`; a caller that wants
 * one `CompileError`-able reference site per occurrence, like
 * `dsl-compiler/semantic-validation.ts`, wants every occurrence kept).
 * Local-review promotion: this was independently re-implemented in both
 * of those two callers (the same "which Step fields can reference a
 * step" definition, computed twice) - the exact drift risk this
 * module's own `collectStepBindingIds` was already promoted to close for
 * the nested-Binding case; this closes the Step-level half of the same
 * rule. `Step.writes` (`SessionWriteTarget`) and `Step.secrets`
 * (`SecretRef`) hold no `Binding` by construction, so neither
 * contributes here. */
export function collectStepReferenceIds(step: Step): string[] {
  const explicit = step.dependsOn ?? [];
  const fromReads = Object.values(step.reads ?? {}).flatMap(collectStepBindingIds);
  return [...explicit, ...fromReads];
}
