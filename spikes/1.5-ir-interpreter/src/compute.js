// Minimal expression evaluator for `compute` bindings.
//
// IMPORTANT SCOPING NOTE: design.md task 5.11 ("Choose JSON-Logic vs. CEL
// against real branch/map cases") is explicitly an OPEN QUESTION, not
// decided. This evaluator is a deliberately tiny JSON-Logic-*shaped* stand-
// in - just enough operators to drive this spike's branch selector - and
// is NOT an attempt to resolve 5.11. Whichever of JSON-Logic/CEL is chosen
// there, this interpreter's `compute` binding-resolution call site (see
// bindings.js) is the one place that would need to change; nothing else in
// the interpreter depends on which expression language is used.

const OPS = {
  ">": ([a, b]) => a > b,
  ">=": ([a, b]) => a >= b,
  "<": ([a, b]) => a < b,
  "<=": ([a, b]) => a <= b,
  "==": ([a, b]) => a === b,
  "!=": ([a, b]) => a !== b,
  and: (args) => args.every(Boolean),
  or: (args) => args.some(Boolean),
  not: ([a]) => !a,
};

export function evaluateCompute(expr, context) {
  if (expr === null || typeof expr !== "object") return expr; // literal
  if (Array.isArray(expr)) return expr.map((e) => evaluateCompute(e, context));

  if ("var" in expr) {
    if (!(expr.var in context)) {
      throw new Error(`compute: unbound variable '${expr.var}' (available: ${Object.keys(context).join(", ")})`);
    }
    return context[expr.var];
  }

  const keys = Object.keys(expr);
  if (keys.length !== 1) {
    throw new Error(`compute: expected exactly one operator key, got [${keys.join(", ")}]`);
  }
  const op = keys[0];
  if (!(op in OPS)) throw new Error(`compute: unsupported operator '${op}'`);
  const rawArgs = expr[op];
  const args = (Array.isArray(rawArgs) ? rawArgs : [rawArgs]).map((a) => evaluateCompute(a, context));
  return OPS[op](args);
}
