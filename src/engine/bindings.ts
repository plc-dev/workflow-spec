import { ERROR_IDS, FatalError } from "../shared/index.js";
import type { Binding } from "../workflow-spec/index.js";

// Task 6.2a (docs/impl-plans/0006-interpreter-plain-steps.md). Resolves
// `request`/`step`/`literal` bindings only - every other kind
// (`session`/`static`/`item`/`compute`/`itemResource`) throws a clear,
// explicit error rather than silently resolving to `undefined`, mirroring
// spike 1.5's own finding ("the unbound binding path throws loudly
// instead of resolving to undefined") - each needs infrastructure this
// package doesn't have yet (session materialization, the dataset
// catalog, item-pool, or 5.11's still-open JSON-Logic-vs-CEL decision),
// tracked as task 6.2b.

export interface BindingContext {
  input: Record<string, unknown>;
  /** Already-resolved outputs of the referencing step's OWN dependencies
   * only, keyed by node id - the caller (interpreter.ts) is responsible
   * for having fetched exactly the ids `computeStepDependencies` named. */
  nodeOutputs: Record<string, Record<string, unknown>>;
}

export function resolveBinding(binding: Binding, ctx: BindingContext): unknown {
  if ("literal" in binding) {
    return binding.literal;
  }

  if ("compute" in binding) {
    throw new FatalError(ERROR_IDS.ENGINE_BINDING_KIND_NOT_SUPPORTED, {
      context: { kind: "compute" },
    });
  }

  switch (binding.from) {
    case "request":
      return ctx.input[binding.param];

    case "step": {
      const output = ctx.nodeOutputs[binding.id];
      if (!output) {
        throw new FatalError(ERROR_IDS.ENGINE_NODE_OUTPUT_MISSING, {
          context: { id: binding.id, output: binding.output },
        });
      }
      return output[binding.output];
    }

    case "session":
    case "static":
    case "item":
    case "itemResource":
      throw new FatalError(ERROR_IDS.ENGINE_BINDING_KIND_NOT_SUPPORTED, {
        context: { kind: binding.from },
      });

    default:
      // Defensive, forward-compatible fallback - not reachable against
      // ir/'s current Binding union, kept in case a future binding kind
      // is added to ir/ before this interpreter is extended to resolve it.
      throw new FatalError(ERROR_IDS.ENGINE_BINDING_KIND_NOT_SUPPORTED, {
        context: { binding },
      });
  }
}
