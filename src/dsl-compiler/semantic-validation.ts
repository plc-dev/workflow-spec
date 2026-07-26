// design.md D8c: "Step identifiers are human-chosen strings, validated
// unique within the whole workflow-spec... The global (not per-case)
// scoping matters because `{from: step, id: X, output: Y}` and
// `dependsOn` resolve against one flat id-namespace regardless of which
// branch case or map body a step happens to sit inside." This module
// enforces exactly that: document-wide id uniqueness, reference
// resolvability, and - the corollary D8c/5.7/5.8 both name explicitly -
// that a step INSIDE a branch case/map body's subgraph is never
// referenceable from OUTSIDE it, even though the namespace is flat.
//
// Structural only, no I/O - this is a pure tree walk over an
// already-schema-valid document (`compile.ts` only calls this after
// step 2 of its pipeline passes).

import { collectStepBindingIds, collectStepReferenceIds } from "../workflow-spec/index.js";
import type { Binding, WorkflowSpec } from "../workflow-spec/index.js";
import { COMPILE_ERROR_CODES } from "./constants.js";
import type { CompileError } from "./domain/compile-result.js";
import { type ScopePath, walkNodes } from "./node-walk.js";

interface ReferenceSite {
  /** The step id (or top-level document, path `[]`) issuing the reference -
   * used only for the resulting CompileError's `path`. */
  siteId: string;
  siteScope: ScopePath;
  targetId: string;
}

/** `targetScope` must be `siteScope`'s own scope or one of its ancestors -
 * i.e. every reference is allowed to reach "outward/upward" toward the
 * document root, or sideways within its own subgraph, but never "inward"
 * into a sibling or unrelated subgraph it isn't itself part of. */
function isVisible(targetScope: ScopePath, siteScope: ScopePath): boolean {
  if (targetScope.length > siteScope.length) return false;
  return targetScope.every((segment, i) => siteScope[i] === segment);
}

// `collectStepBindingIds` (workflow-spec/binding-refs.ts) is the single
// source of truth for "every {from:"step"} id reachable from a Binding,
// however deeply nested inside compute.using/itemResource.itemId" -
// promoted out of this file (it used to have its own independent copy of
// this exact walk) per this package's own local-review finding: two
// copies of the same walk (this file's and engine/dependency-graph.ts's)
// were a drift risk if a future Binding kind were added to only one.
function walkBindingForStepRefs(
  binding: Binding | undefined,
  siteId: string,
  siteScope: ScopePath,
  out: ReferenceSite[],
): void {
  if (!binding) return;
  for (const targetId of collectStepBindingIds(binding)) {
    out.push({ siteId, siteScope, targetId });
  }
}

function walkBindingMapForStepRefs(
  bindings: Record<string, Binding> | undefined,
  siteId: string,
  siteScope: ScopePath,
  out: ReferenceSite[],
): void {
  if (!bindings) return;
  for (const binding of Object.values(bindings)) {
    walkBindingForStepRefs(binding, siteId, siteScope, out);
  }
}

interface WalkResult {
  /** Every node id seen, mapped to the FIRST scope it was seen defined in -
   * `duplicateIds` separately records every id seen more than once. */
  idToScope: Map<string, ScopePath>;
  duplicateIds: Set<string>;
  references: ReferenceSite[];
}

function recordId(id: string, scope: ScopePath, result: WalkResult): void {
  if (result.idToScope.has(id)) {
    result.duplicateIds.add(id);
    return;
  }
  result.idToScope.set(id, scope);
}

/** Walks the whole document (steps, recursively through every branch
 * case/map body) collecting id definitions and every step-output
 * reference (`dependsOn` plus every `{from:"step",...}` binding, however
 * deeply nested inside `compute.using`/`itemResource.itemId`), then
 * reports: duplicate ids, references to a nonexistent id, and references
 * that reach into a subgraph the referencing site isn't part of. */
export function validateStepReferences(spec: WorkflowSpec): CompileError[] {
  const result: WalkResult = { idToScope: new Map(), duplicateIds: new Set(), references: [] };
  const rootScope: ScopePath = [];

  walkNodes(spec.steps, rootScope, {
    onStep(step, scope) {
      recordId(step.id, scope, result);
      // `collectStepReferenceIds` (workflow-spec/binding-refs.ts) is the
      // single source of truth for "which step ids does THIS step
      // reference" (dependsOn plus every nested {from:"step"} in reads) -
      // promoted out of this file per this package's own local-review
      // finding: this half of the walk was still independently
      // duplicated against engine/dependency-graph.ts's
      // computeStepDependencies even after the nested-Binding half
      // (collectStepBindingIds) was already consolidated.
      for (const targetId of collectStepReferenceIds(step)) {
        result.references.push({ siteId: step.id, siteScope: scope, targetId });
      }
    },
    onBranch(node, scope) {
      recordId(node.id, scope, result);
      walkBindingForStepRefs(node.selector, node.id, scope, result.references);
    },
    onCaseWalked(node, _caseKey, caseBody, caseScope) {
      walkBindingMapForStepRefs(caseBody.yields, node.id, caseScope, result.references);
    },
    onMap(node, scope) {
      recordId(node.id, scope, result);
      walkBindingForStepRefs(node.source, node.id, scope, result.references);
    },
    onBodyWalked(node, bodyScope) {
      walkBindingMapForStepRefs(node.yields, node.id, bodyScope, result.references);
    },
  });

  walkBindingMapForStepRefs(spec.outputs, "", rootScope, result.references);

  // Local-review fix: `sessionState`'s per-key `fallback` (D8a) is a full
  // Binding too - previously unwalked, silently letting a
  // `{from:"step",...}` fallback reference escape both the
  // unresolved-reference and internal-id-visibility checks below. Root
  // scope is correct here: a session-state seed is document-level, so it
  // must never be able to reach into a branch-case/map-body's internal
  // ids.
  for (const [key, decl] of Object.entries(spec.sessionState ?? {})) {
    walkBindingForStepRefs(decl.fallback, key, rootScope, result.references);
  }

  const errors: CompileError[] = [];

  for (const id of result.duplicateIds) {
    errors.push({
      code: COMPILE_ERROR_CODES.duplicate_step_id,
      path: id,
      message: `Step id "${id}" is used more than once in this document - step ids share one flat, document-wide namespace (D8c).`,
    });
  }

  for (const ref of result.references) {
    const targetScope = result.idToScope.get(ref.targetId);
    if (!targetScope) {
      errors.push({
        code: COMPILE_ERROR_CODES.unresolved_step_reference,
        path: ref.siteId,
        message: `References step id "${ref.targetId}", which does not exist anywhere in this document.`,
      });
      continue;
    }
    if (!isVisible(targetScope, ref.siteScope)) {
      errors.push({
        code: COMPILE_ERROR_CODES.internal_step_id_referenced_externally,
        path: ref.siteId,
        message: `References step id "${ref.targetId}", which is internal to a branch case/map body this reference site is not part of (D8c).`,
      });
    }
  }

  return errors;
}
