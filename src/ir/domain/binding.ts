// design.md D8/D8a/D8c/D16: the Binding discriminated union. Secrets are
// deliberately NOT a member of this union (see secret-ref.ts) - that
// omission is what structurally excludes a secret reference from a
// `compute` binding's `using` map (D10), by construction rather than a
// runtime check.

import type { JsonPointer, LogicExpression, Urn } from "./placeholder-types.js";

export type Binding =
  | StaticBinding
  | SessionBinding
  | RequestBinding
  | StepBinding
  | ItemBinding
  | LiteralBinding
  | ComputeBinding
  | ItemResourceBinding;

/** D8a: a reference into the static dataset catalog. */
export interface StaticBinding {
  from: "static";
  ref: Urn;
}

/** D8: a read from session-scoped state (D8a: interactivity/fallback are
 * declared once per key in `sessionState`, not repeated here). */
export interface SessionBinding {
  from: "session";
  key: string;
}

/** D8a: a flat, named workflow input parameter - never a dotted/nested
 * path (see validate.ts's flatName rule). */
export interface RequestBinding {
  from: "request";
  param: string;
}

/** D8: another step's (or branch/map node's) output - this IS the
 * dependency edge the scheduler infers the graph from. */
export interface StepBinding {
  from: "step";
  id: string;
  output: string;
}

/** D8a: the current `map`/`forEach` iteration item. Deliberately minimal -
 * exposes the raw item value only; field extraction reuses `compute` +
 * JSON-Logic's `var` operator rather than a second path syntax. */
export interface ItemBinding {
  from: "item";
}

/** D8c: an arbitrary JSON value/structure, passed through opaquely. Also
 * the shape used for a nesting target's `allowedTools` (D9c). */
export interface LiteralBinding {
  literal: unknown;
}

/** D8/D10: a pure, bounded JSON-Logic expression evaluated in-interpreter,
 * against a context built from `using`'s already-resolved bindings.
 * `using`'s values are always `Binding`s, never a `SecretRef` - which is
 * what structurally excludes secrets from `compute` (D10). */
export interface ComputeBinding {
  compute: LogicExpression;
  using?: Record<string, Binding>;
}

/** D16: resolves at run time against the per-item-instance flattened
 * manifest cache (12.4, not built here) into either a static-equivalent
 * dataset reference or a plain passed-through value. `itemId` is itself a
 * Binding (typically request-scoped, per D15); `path` is a locator into
 * the manifest (provisional RFC 6901 grammar - see placeholder-types.ts). */
export interface ItemResourceBinding {
  from: "itemResource";
  itemId: Binding;
  path: JsonPointer;
}
