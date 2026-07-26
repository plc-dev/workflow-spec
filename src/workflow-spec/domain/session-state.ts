// design.md D8a: sessionState is declared once per logical key, not
// repeated per binding - individual reads/writes reference only
// `{ from: session, key }` / `{ to: session, key }`.

import type { Binding } from "./binding.js";

export interface SessionStateDeclaration {
  interactivity: "interactive" | "batch";
  /** Optional seed/fallback binding, used when the session has no value
   * for this key yet. Static-scope interactivity is not a DSL concept
   * (D8a) - only session-scoped state declares this. */
  fallback?: Binding;
}
