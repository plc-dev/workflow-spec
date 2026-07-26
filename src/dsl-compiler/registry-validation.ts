// design.md D12/task 5.3: "reject unknown service/function references" at
// compile time. Applies to every Step node anywhere in the document
// (top-level, inside a branch case, inside a map body, arbitrarily nested
// per D8d) - see the plan doc's "Open questions" for why this isn't
// scoped to plain-only steps.

import { type RegistryEntry, getEntry } from "../registry/index.js";
import type { Queryable } from "../shared/index.js";
import type { Step, WorkflowSpec } from "../workflow-spec/index.js";
import { COMPILE_ERROR_CODES } from "./constants.js";
import type { CompileError } from "./domain/compile-result.js";
import { walkNodes } from "./node-walk.js";

/** `Step.service` is always `<repo>@<alg>:<hex>` (D8c hard rule, enforced
 * by the JSON Schema's `ociDigestRef` pattern already, upstream of this
 * function ever running) - `registry/` keys its own `service_images` rows
 * by the bare `<alg>:<hex>` digest alone (see
 * `test/registry/fixtures.ts`'s `DIGEST`), never the repo-qualified ref.
 * Local-review note: the `<repo>` portion of `step.service` is
 * DELIBERATELY not compared against the registry's own `ociRef` host/path
 * - see docs/impl-plans/0009-dsl-compiler-plain-steps.md's review notes
 * for why a repo/host-equality check was tried and reverted (it treats
 * digest as non-authoritative, which contradicts D8c/D12's own model, and
 * breaks legitimate short-name references to a registry that resolves
 * them by convention/default host). */
function digestFromServiceRef(service: string): string {
  const atIndex = service.indexOf("@");
  return service.slice(atIndex + 1);
}

/** Collects every plain Step node anywhere in the document - descending
 * into every branch case's `steps` and every map's `body`, to any depth
 * (D8d), via the shared `node-walk.ts` traversal. Branch/map nodes
 * themselves have no `service`/`function` to check, so only `Step`s are
 * collected (`onStep` is the only callback this needs). */
function collectAllSteps(spec: WorkflowSpec): Step[] {
  const steps: Step[] = [];
  walkNodes(spec.steps, [], { onStep: (step) => steps.push(step) });
  return steps;
}

/** For every step in the document, confirms `service`'s digest is a
 * registered `registry/` entry and `function` is one of that entry's
 * declared functions (D12: the registry is the sole source of truth for
 * what exists). Never throws for an unknown digest/function - reports it
 * as a `CompileError`, the same never-throws contract every stage of this
 * pipeline shares; a genuine registry I/O failure (e.g. the pool itself
 * erroring) is left to propagate uncaught, exactly as `getEntry` already
 * does on its own. */
export async function validateServiceReferences(
  spec: WorkflowSpec,
  registryPool: Queryable,
): Promise<CompileError[]> {
  const steps = collectAllSteps(spec);

  // Local-review fix: `getEntry` issues 2 sequential queries; without
  // caching, N steps sharing the same digest (a common pattern - many
  // steps calling the same service) would repeat those same 2 queries N
  // times over. Cached here, per digest, once per `compile()` call - not
  // a batched `WHERE digest = ANY($1)` repo method (that would touch
  // registry/'s own query surface, out of this package's scope; flagged
  // as a possible follow-up, not required for this fix).
  const entriesByDigest = new Map<string, RegistryEntry | null>();
  async function getEntryCached(digest: string): Promise<RegistryEntry | null> {
    if (!entriesByDigest.has(digest)) {
      entriesByDigest.set(digest, await getEntry(registryPool, digest));
    }
    // Safe: the `.set()` immediately above guarantees a `has()` hit.
    return entriesByDigest.get(digest) ?? null;
  }

  const errors: CompileError[] = [];

  for (const step of steps) {
    const digest = digestFromServiceRef(step.service);
    const entry = await getEntryCached(digest);

    if (!entry) {
      errors.push({
        code: COMPILE_ERROR_CODES.unknown_service_digest,
        path: step.id,
        message: `Step "${step.id}" references service digest "${digest}", which is not registered in the service registry.`,
      });
      continue;
    }

    // Local-review fix: `in` also matches inherited Object.prototype keys
    // (e.g. `function: "constructor"` would otherwise pass for ANY
    // registered digest) - `entry.functions` is a plain object literal
    // (registry/get-entry.ts), and the workflow-spec schema places no
    // restriction on `function` beyond non-empty-string, so this is
    // reachable from ordinary untrusted authoring input.
    if (!Object.hasOwn(entry.functions, step.function)) {
      errors.push({
        code: COMPILE_ERROR_CODES.unknown_service_function,
        path: step.id,
        message: `Step "${step.id}" references function "${step.function}" on digest "${digest}", which declares no such function.`,
      });
    }
  }

  return errors;
}
