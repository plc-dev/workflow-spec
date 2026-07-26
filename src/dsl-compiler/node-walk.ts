// Shared tree-traversal skeleton for a WorkflowSpec's `Node` union
// (design.md D8c/D8d: `branch`/`map` nest to any depth, so both this
// module's semantic checks and its registry checks need to descend into
// every case's `steps` and every map's `body` the same way). Extracted
// per implementation-best-practices.md #6 - `semantic-validation.ts` and
// `registry-validation.ts` each independently wrote a ~10-line recursive
// descent over this exact same union before this extraction (flagged in
// docs/impl-plans/0009-dsl-compiler-plain-steps.md's Implementation
// notes; consolidated on the repo owner's explicit direction).
//
// This module owns ONLY the traversal shape - which node comes next, and
// what scope it's in. It has no opinion on what a caller does with a
// visited node (collect it, validate it, ...); that's each caller's own
// `NodeVisitor` callbacks.

import type { BranchNode, CaseBody, MapNode, Node, Step } from "../workflow-spec/index.js";

/** A node's defining scope, as the path of enclosing branch-case/map-body
 * scopes from the document root (`[]`) - e.g. `["branch:b1", "case:true",
 * "map:m1"]`. Exported so callers can compare paths for visibility
 * (D8c's "internal steps aren't referenceable from outside their own
 * subgraph" rule - see `semantic-validation.ts`). */
export type ScopePath = readonly string[];

export interface NodeVisitor {
  /** Called for a plain Step, in the scope it's directly defined in. */
  onStep?(step: Step, scope: ScopePath): void;
  /** Called for a BranchNode itself, BEFORE its cases are descended
   * into - `scope` is the branch node's OWN scope (same as its siblings),
   * not any one case's. */
  onBranch?(node: BranchNode, scope: ScopePath): void;
  /** Called once per case, AFTER that case's own `steps` have been fully
   * walked - `caseScope` is that case's own scope (what its internal
   * steps were walked under). */
  onCaseWalked?(node: BranchNode, caseKey: string, caseBody: CaseBody, caseScope: ScopePath): void;
  /** Called for a MapNode itself, BEFORE its body is descended into -
   * `scope` is the map node's OWN scope. */
  onMap?(node: MapNode, scope: ScopePath): void;
  /** Called AFTER a map's `body` has been fully walked - `bodyScope` is
   * the body's own scope. */
  onBodyWalked?(node: MapNode, bodyScope: ScopePath): void;
}

/** Walks `nodes` (and, recursively, every branch case's `steps`/every
 * map's `body`, to any depth per D8d), invoking whichever `visitor`
 * callbacks are supplied. A caller only needing a flat step list supplies
 * `onStep` alone; a caller needing dependency-edge/scope information
 * supplies all five. */
export function walkNodes(nodes: readonly Node[], scope: ScopePath, visitor: NodeVisitor): void {
  for (const node of nodes) {
    if (!("kind" in node)) {
      visitor.onStep?.(node, scope);
      continue;
    }

    if (node.kind === "branch") {
      visitor.onBranch?.(node, scope);
      for (const [caseKey, caseBody] of Object.entries(node.cases)) {
        const caseScope = [...scope, `branch:${node.id}`, `case:${caseKey}`];
        walkNodes(caseBody.steps, caseScope, visitor);
        visitor.onCaseWalked?.(node, caseKey, caseBody, caseScope);
      }
      continue;
    }

    visitor.onMap?.(node, scope);
    const bodyScope = [...scope, `map:${node.id}`];
    walkNodes(node.body, bodyScope, visitor);
    visitor.onBodyWalked?.(node, bodyScope);
  }
}
