import { evaluateCompute } from "./compute.js";

// Resolves ONE binding to a concrete value. Deliberately pure/synchronous:
// the interpreter loads everything a binding could reference (request
// params, already-completed sibling node outputs, and - for map body steps
// only - the current item) into `ctx` BEFORE calling this, so binding
// resolution itself never needs its own DB round-trip. This is what makes
// dependency ordering matter: a node must not even be claimed until every
// `{from:"step"}` binding it could resolve is already present in
// `ctx.nodeOutputs` - see interpreter.js's promotion logic.
//
// ctx shape: { requestParams: object, nodeOutputs: Map<nodeId, outputObj>, item?: any }
export function resolveBinding(binding, ctx) {
  if (binding == null || typeof binding !== "object") {
    throw new Error(`resolveBinding: not a binding object: ${JSON.stringify(binding)}`);
  }

  if ("literal" in binding) {
    return binding.literal;
  }

  if (binding.from === "request") {
    if (!(binding.param in ctx.requestParams)) {
      throw new Error(`resolveBinding: request param '${binding.param}' not supplied`);
    }
    return ctx.requestParams[binding.param];
  }

  if (binding.from === "step") {
    const out = ctx.nodeOutputs.get(binding.id);
    if (!out) {
      // Should be unreachable: the interpreter only ever claims/dispatches
      // a node once every `{from:"step"}` dependency it declares is already
      // present in nodeOutputs (see interpreter.js: collectStepDeps +
      // promoteReadyNodes). Surfacing this loudly rather than resolving to
      // undefined makes a dependency-ordering bug fail fast instead of
      // silently producing wrong output.
      throw new Error(
        `resolveBinding: node '${binding.id}' has not produced output yet - a dependency-ordering bug, not a data error`
      );
    }
    if (!(binding.output in out)) {
      throw new Error(`resolveBinding: node '${binding.id}' has no output named '${binding.output}' (has: ${Object.keys(out).join(", ")})`);
    }
    return out[binding.output];
  }

  if (binding.from === "item") {
    if (!("item" in ctx)) {
      throw new Error(`resolveBinding: {from: "item"} used outside a map body`);
    }
    return ctx.item;
  }

  if ("compute" in binding) {
    const using = {};
    for (const [name, inner] of Object.entries(binding.using || {})) {
      using[name] = resolveBinding(inner, ctx);
    }
    return evaluateCompute(binding.compute, using);
  }

  if (binding.from === "session") {
    // The session layer (design.md D3, tasks.md section 3) is not built
    // yet - out of scope for this spike. Fail loudly rather than pretend.
    throw new Error(`resolveBinding: {from: "session"} is not supported by spike 1.5 (session layer not yet built - tasks.md section 3)`);
  }

  if (binding.from === "static") {
    // Likewise: dataset URN resolution (design.md D8b, task 5.6d) is not
    // built yet - out of scope for this spike.
    throw new Error(`resolveBinding: {from: "static"} is not supported by spike 1.5 (dataset catalog not yet built - task 5.6d)`);
  }

  throw new Error(`resolveBinding: unrecognized binding shape: ${JSON.stringify(binding)}`);
}

// Resolves every entry of a `reads` (or `using`) map into a plain object of
// concrete values, ready to hand to a step function.
export function resolveReads(reads, ctx) {
  const resolved = {};
  for (const [name, binding] of Object.entries(reads || {})) {
    resolved[name] = resolveBinding(binding, ctx);
  }
  return resolved;
}
