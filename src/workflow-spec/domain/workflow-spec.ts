// design.md D8/D8a: the top-level workflow-spec document - the authored
// artifact a workflow-writer produces. Also the document the engine runs
// today, since no dsl-compiler/ exists yet to compile it into a distinct
// execution plan - see the ExecutionPlan alias below.

import type { Binding } from "./binding.js";
import type { Node } from "./node.js";
import type { SessionStateDeclaration } from "./session-state.js";

export interface WorkflowSpec {
  /** D8d/D11: the locked version field name (author-facing; renamed from
   * irVersion) - a whole-document tag, bumped only on breaking changes.
   * Execution-plan versioning is tracked separately once a future
   * dsl-compiler/ splits the execution plan out into its own module. */
  workflowSpecVersion: number;
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

/**
 * TODO(dsl-compiler/): `ExecutionPlan` is a temporary alias for
 * `WorkflowSpec`, kept here (rather than in its own module) only because
 * no compile step exists yet - the authored document and the document the
 * engine runs are byte-identical today. Once a `dsl-compiler/` package
 * compiles a workflow-spec into a distinct, engine-facing execution plan
 * (design.md D8, task 5.2/5.10):
 *
 * 1. Create a new `execution-plan/` module owning `ExecutionPlan` as its
 *    own type, with its own version tag (NOT `workflowSpecVersion` - see
 *    design.md D11's terminology-amendment note), and repoint `engine/`
 *    at it. Nothing in THIS module moves: the grammar types, the schema,
 *    `validate()`, and `workflowSpecVersion` are all authoring-side and
 *    stay here, because they are what the compiler reads.
 * 2. Have `execution-plan/` import the shared grammar types
 *    (`Binding`/`Step`/`Node`/...) from this module's barrel rather than
 *    duplicating them - ADR-0003's "one type universe, one validator".
 * 3. Delete this alias.
 *
 * See docs/glossary.md for the workflow-spec vs. execution-plan
 * distinction this alias is temporarily papering over.
 */
export type ExecutionPlan = WorkflowSpec;
