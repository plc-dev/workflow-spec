// design.md D8c/D8d: a node in a steps/body list is a plain Step, a
// branch, or a map - discriminated by the presence/value of `kind`.
// Nesting depth is unrestricted (D8d): a branch case's steps or a map
// body may themselves contain another branch/map, to any depth - this
// falls directly out of `Node` being a recursive union, no extra grammar
// needed.

import type { Binding } from "./binding.js";
import type { OciDigestRef } from "./placeholder-types.js";
import type { SecretRef } from "./secret-ref.js";
import type { SessionWriteTarget } from "./write-target.js";

export type Node = Step | BranchNode | MapNode;

/** D8c: a plain step invocation. Step ids are human-chosen strings, valid
 * document-scoped (not per-branch-case/per-map-body), per D8c's
 * collision-resistance argument. */
export interface Step {
  id: string;
  /** Always digest-pinned (D8c hard rule) - never a bare mutable tag. */
  service: OciDigestRef;
  function: string;
  /** D8a: explicit ordering escape hatch for steps with no data dependency. */
  dependsOn?: string[];
  reads?: Record<string, Binding>;
  writes?: Record<string, SessionWriteTarget>;
  secrets?: Record<string, SecretRef>;
}

/** D8c: a branch case's sub-graph. `yields` is required whenever `steps`
 * has more than one entry (D8c) - not enforced structurally here; see
 * this package's impl-plan doc's "Open questions". With exactly one step,
 * an omitted `yields` defaults to that step's whole output object. */
export interface CaseBody {
  steps: Node[];
  yields?: Record<string, Binding>;
}

/** D8c: statically enumerates every possible case; only one case executes
 * per run. `cases` is a map keyed by the stringified selector value -
 * `default` is an inline key of that same map, not a separate field. */
export interface BranchNode {
  id: string;
  kind: "branch";
  selector: Binding;
  cases: Record<string, CaseBody>;
}

/** D8/D8c: statically declares the shape of a single iteration; only the
 * iteration count is resolved at run time from `source`. */
export interface MapNode {
  id: string;
  kind: "map";
  source: Binding;
  body: Node[];
  yields?: Record<string, Binding>;
}
