// Built-in "step function" registry.
//
// SCOPING NOTE: real steps invoke registered SERVICE functions (digest-
// pinned OCI images, per D8c/D12), resolved through the service registry
// (task 2.x) and dispatched over HTTP/SDK (tasks 6.3/6.4). That whole layer
// is deliberately out of scope for 1.5, which tests the INTERPRETER's own
// dependency-resolution/binding-resolution/branch-and-map mechanics, not
// service dispatch. This registry stands in for "calling a step's function"
// with plain, synchronous, in-process JS - the interpreter's dispatch call
// site (see interpreter.js's `runStepBody`) is the one place that would
// change to route through the registry+HTTP instead.
//
// Every function receives a plain object of already-RESOLVED inputs (the
// interpreter has already turned each `reads` binding into a concrete
// value before calling here) and returns a plain object of named outputs.

export const FUNCTIONS = {
  discount({ amount }) {
    return { result: Math.round(amount * 0.9 * 100) / 100 };
  },
  identity({ value }) {
    return { result: value };
  },
  lineTotal({ item }) {
    return { result: item.price * item.qty };
  },
  sumWithDiscount({ lineTotals, discountedAmount }) {
    const sum = lineTotals.reduce((acc, v) => acc + v, 0);
    return { result: Math.round((sum + discountedAmount) * 100) / 100 };
  },
};

export function callFunction(name, inputs) {
  const fn = FUNCTIONS[name];
  if (!fn) throw new Error(`unknown function '${name}'`);
  return fn(inputs);
}
