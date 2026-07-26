// design.md D8/D8a: the top-level IR document.

import type { Binding } from "./binding.js";
import type { Node } from "./node.js";
import type { SessionStateDeclaration } from "./session-state.js";

export interface WorkflowSpec {
  /** D8d/D11: the locked version field name - a whole-document tag,
   * bumped only on breaking changes. */
  irVersion: number;
  name: string;
  description?: string;
  /** D8a: the workflow's derived signature stays flat, named, typed -
   * this is an optional explicit declaration of that flat parameter set. */
  inputParameters?: string[];
  /** D8a: declared once per logical session key, never repeated per binding. */
  sessionState?: Record<string, SessionStateDeclaration>;
  steps: Node[];
  /** D8c: top-level workflow yields - the same flat/named/typed mechanism
   * `yields` uses inside a branch case or map body. */
  outputs?: Record<string, Binding>;
}
