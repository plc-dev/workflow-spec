// ADR-0012: this module's public surface - re-exports only, no logic.
// dsl-compiler/ is offline/authoring-plane only (ADR-0007) - nothing here
// opens a connection of its own; `compile()`'s `registryPool` is always
// supplied by the caller.

// `node-walk.ts` (`walkNodes`/`NodeVisitor`/`ScopePath`) and
// `registry-validation.ts` (`validateServiceReferences`) are internal to
// this module - `compile.ts`/`semantic-validation.ts` import them via
// relative paths, no barrel needed for intra-module use (ADR-0012's
// barrel rule governs CROSS-module imports). Not re-exported here:
// neither has a real external consumer yet (local-review finding) - add
// them back if/when one appears.
export { compile } from "./compile.js";
export type { CompileError, CompileErrorCode, CompileResult } from "./domain/compile-result.js";
export { parseRestrictedYaml } from "./restricted-yaml.js";
export type { ParsedYamlResult } from "./restricted-yaml.js";
export { validateStepReferences } from "./semantic-validation.js";
