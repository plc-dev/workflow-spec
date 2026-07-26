# 0009: DSL compiler - `dsl-compiler/` module (restricted-YAML parse, schema validate, registry-checked compile)

## Status

`plan-agreed` (test-design gate collapsed into this same approval - see
"Test design"'s own rationale)

## Scope

This package covers task **5.2**, **5.3**, and **5.6a**:

- **5.2:** Implement an authoring-surface-to-execution-plan compiler for
  the syntax chosen in 1.7.
- **5.3:** Implement validation against the registry (reject unknown
  service/function references) at execution-plan-compile time.
- **5.6a:** Implement the restricted-YAML/JSON parser + JSON Schema
  validation (no anchors/aliases/merge keys/custom tags; camelCase
  fields) per design.md D8a.

**Explicitly NOT in scope** (each needs infrastructure that doesn't exist
yet, or is a separate future package per the same "one buildable slice"
discipline packages 0001-0008 already established):

- **5.4/5.4a/5.5** (data-binding syntax for session/static/user sources,
  `sessionState` resolution, `writes`/change-detection gating) - the
  *grammar* for these already exists (0004's schema); this package's
  compiler passes these binding kinds through structurally (schema
  validation already covers their shape) but does not add any new
  authoring-surface syntax for them. No new scope beyond what 0004
  already validates.
- **5.6** (dependency-graph inference for execution) - this is `engine/`'s
  job, already done for the plain-step case in 6.2a
  (`docs/impl-plans/0006-interpreter-plain-steps.md`). This package's
  own semantic checks (duplicate-id / unresolved-reference detection,
  below) are compile-time *validation*, not graph construction - a
  document that already passes them is handed to 6.2a's
  `computeStepDependencies` unchanged.
- **5.6b/5.6c/5.6d/5.6d-i/5.6e** - `{from:"item"}` map-body binding (5.6b)
  and flat-request-param rejection (5.6c) are already schema-enforced
  (0004); the dataset URN parser/resolver, its object-storage backing
  product, and OCI-reference-vs-dataset-URN cross-rejection (5.6d/
  5.6d-i/5.6e) need `dataset-catalog/`/`urn/`, neither of which exists.
  Left `[ ]`.
- **5.7/5.8** (the `branch`/`map` constructs themselves) - these are
  *execution* constructs (6.2b, deferred - needs session materialization,
  the dataset catalog, and D10's evaluator, none of which exist).
  This package's semantic-validation pass (below) DOES apply the
  document-wide-id-uniqueness and internal-id-scoping rules to `branch`/
  `map` nodes structurally (a workflow-spec containing them can be
  compiled and schema/reference-checked), but 5.7/5.8 themselves stay
  `[ ]` - compiling a document is not executing it, and this package adds
  no `branch`/`map` execution semantics.
- **5.9-5.16** - signature derivation/publishing (needs `workflow-store/`),
  execution-plan-to-engine compilation as its own distinct step (moot
  today - `ExecutionPlan = WorkflowSpec`, per 0004's alias note; this
  package's `compile()` returns that same alias, it does not introduce a
  second document shape), JSON-Logic-vs-CEL validation against real
  cases, `compute` evaluation, version migration, generic binding-
  satisfies-parameter validation beyond what 0004's schema already
  states, and `itemResource`/JSON-Pointer resolution. None of this
  package's prerequisites.

## Sources

- **ADR-0007** (module inventory): names `dsl-compiler/` explicitly -
  "restricted-YAML/JSON authoring surface -> execution plan (D8a/D8c);
  promotes `archive/dsl/`'s JSON Schema via `workflow-spec/`;
  offline/authoring-plane only." Depends on `workflow-spec/` (typed
  against, no I/O) and calls `registry/`'s client interface only
  (`getEntry`), never its schema - the dependency direction this ADR
  fixes.
- **ADR-0003** (execution plan is the system spine): names `migrate()`/
  `deriveSignature()` as `workflow-spec/`'s eventual contract and
  anticipates `execution-plan/` splitting out of `workflow-spec/` "once
  `dsl-compiler/` exists" - not yet, per 0004's alias note (`ExecutionPlan
  = WorkflowSpec` remains the shape this package produces).
- **ADR-0012** (module-internal structure): this package is the first
  purely-logic (no owned database) module with an I/O dependency
  (`registry/`'s pool, injected by the caller) - no `database/`
  subdirectory of its own; `domain/` holds the compiler's own result/error
  types.
- **design.md D8a**: restricted-YAML profile (bans anchors/aliases/merge
  keys/custom tags), camelCase fields, "a single JSON Schema validates the
  parsed structure regardless of whether the source was YAML or raw
  JSON."
- **design.md D8c**: step ids are "human-chosen strings, validated unique
  within the whole workflow-spec... global (not per-case) scoping...
  because `{from: step, id: X, output: Y}` and `dependsOn` resolve against
  one flat id-namespace regardless of which branch case or map body a
  step happens to sit inside." This is the exact rule this package's
  document-wide duplicate-id and reference-resolution checks enforce.
- **design.md D12**: the registry is the sole source of truth for which
  digests/functions exist - 5.3's "reject unknown service/function
  references" is this decision applied at compile time.
- **`archive/dsl/schema/README.md`** ("Limitations" section, carried
  forward by 0004): explicitly flags the restricted-YAML profile and
  cross-reference resolution as NOT enforceable by the JSON Schema alone,
  naming task 5.6a and "a later analysis pass" as where they belong. This
  package IS that parser and that analysis pass.
- **`docs/impl-plans/0004-workflow-spec-schema.md`**: today's binding
  contract (`WorkflowSpec`/`Node`/`Binding` types, `validate()`,
  `ExecutionPlan` alias) - this package imports it, does not modify it.
- **`docs/impl-plans/0007-registry.md`**: the real `registry/` module
  (`getEntry(pool, digest)`, keyed by bare `<alg>:<hex>` digest, per
  `test/registry/fixtures.ts`'s `DIGEST` shape) this package's 5.3 check
  calls.
- **`docs/impl-plans/0006-interpreter-plain-steps.md`**: `engine/`'s
  `submitRun(repos, spec, input)` - the consumer this package's output
  feeds, exercised end-to-end in this package's own test design (below),
  not modified by it.

**Open questions this package must nonetheless make a call on:**

- **What object shape does `compile()` accept for non-YAML input?**
  Called with a raw JS value (already-parsed JSON) rather than a YAML
  string. Decision: `compile()` accepts `string | unknown` - a string is
  always treated as restricted-YAML source and parsed accordingly; any
  other value is assumed already-parsed and the restricted-profile check
  is skipped for it (there is no YAML AST to check - a plain JS object has
  no anchors/aliases by construction). This matches D8a's own framing
  ("a single JSON Schema validates the parsed structure... regardless of
  whether the source was YAML or raw JSON") and the archived `test.js`'s
  own dual-path precedent.
- **Does registry validation (5.3) apply to `branch`/`map`-nested steps,
  or only top-level ones?** Decision: to every `Step` node found anywhere
  in the document (top-level, inside a branch case, inside a map body,
  arbitrarily nested per D8d). 5.3's own text ("reject unknown
  service/function references") is not scoped to plain-only, and nothing
  about the check requires the step to be reachable by today's plain-step
  interpreter - it is a pure document-shape question the registry can
  already answer for any step.
- **Is a registry pool a required or optional dependency of `compile()`?**
  Decision: required. 5.3 is explicit in-scope work for this package, not
  an optional extra; there is no real caller (task list has none yet) that
  would want compilation without it, and making it optional would let a
  workflow-spec with dangling service references silently "compile" clean.

## Plan

### Module layout (`src/dsl-compiler/`, per ADR-0012's module shape)

```
src/dsl-compiler/
  index.ts                    barrel: compile, CompileResult, CompileError, CompileErrorCode
  constants.ts                COMPILE_ERROR_CODES, restricted-YAML-profile constants
  domain/
    compile-result.ts         CompileResult, CompileError, CompileErrorCode
  restricted-yaml.ts          parseRestrictedYaml(source: string): ParsedYamlResult
  semantic-validation.ts      validateStepReferences(doc): CompileError[]
  registry-validation.ts      validateServiceReferences(doc, pool): Promise<CompileError[]>
  compile.ts                  compile(input, deps): Promise<CompileResult>
```

No `database/` subdirectory - this module owns no schema/pool of its own
(ADR-0007: "offline/authoring-plane only"); it receives a `registry/`
`Queryable` pool from its caller, exactly the way `registry/`'s own client
functions receive one, never opening a connection itself.

### Interfaces

```ts
// domain/compile-result.ts
export type CompileErrorCode =
  | "restricted_yaml_violation"
  | "schema_invalid"
  | "duplicate_step_id"
  | "unresolved_step_reference"
  | "internal_step_id_referenced_externally"
  | "unknown_service_digest"
  | "unknown_service_function";

export interface CompileError {
  code: CompileErrorCode;
  /** Step id or ajv instancePath, when applicable - "" for whole-document errors. */
  path: string;
  message: string;
}

export type CompileResult =
  | { ok: true; executionPlan: ExecutionPlan }
  | { ok: false; errors: CompileError[] };
```

```ts
// compile.ts
export async function compile(
  input: string | unknown,
  deps: { registryPool: Queryable },
): Promise<CompileResult>;
```

`compile()` never throws for an invalid *document* (mirrors
`workflow-spec/validate()`'s own never-throws contract - callers get
`{ ok: false, errors }`, not a catch block per error kind). It DOES let a
genuinely exceptional failure (e.g. the registry pool's connection itself
failing) propagate uncaught, exactly as `getEntry` already does - this
package adds no new fault-tolerance behavior around `registry/`'s own I/O.

### Data flow inside `compile()`

1. **Parse.** If `input` is a `string`, `restricted-yaml.ts` parses it
   with the `yaml` package's `parseDocument`, then walks the resulting AST
   (via `yaml`'s `visit`) checking every node for: an `.anchor` (rejects -
   anchor definition), `isAlias(node)` (rejects - alias reference), a pair
   whose key resolves to the literal string `<<` (rejects - merge key),
   and any node whose `.tag` is a non-null, non-core-schema tag (rejects -
   custom tag). Any violation short-circuits with
   `{ ok: false, errors: [{ code: "restricted_yaml_violation", ... }] }`
   - the rest of the pipeline never runs against parser output that could
   contain resolved-away indirection. If `input` is not a `string`, this
   step is skipped (see "Open questions" above) and the value is used
   as-is.
2. **Schema validate.** Call `workflow-spec/`'s existing `validate(doc)`.
   Any `ValidationError` maps 1:1 to a `CompileError` with
   `code: "schema_invalid"` (`path` = the ajv `instancePath`). Short-
   circuits here too - semantic/registry checks assume a
   structurally-valid document.
3. **Semantic validation** (`semantic-validation.ts`, no I/O). Walks the
   whole `Node` tree (steps, recursively through every branch case's
   `steps` and every map's `body`) and:
   - Collects every step id seen anywhere in the document; a repeat
     (even across different branch cases/map bodies, per D8c's flat
     namespace rule) is `duplicate_step_id`.
   - For every `dependsOn` entry and every `{from:"step", id, output}`
     binding anywhere in the document, confirms `id` resolves to some
     step id collected above; a miss is `unresolved_step_reference`.
   - For every such reference, confirms the referenced id is visible from
     the referencing site's own scope: a step inside branch case `X`'s
     subgraph (or a map body's subgraph) may only be referenced from
     within that SAME subgraph (nested branches/maps inside it included)
     or not at all from outside it; a reference from outside is
     `internal_step_id_referenced_externally` (D8c/5.7/5.8's rule,
     enforced here structurally even though `branch`/`map` execution
     itself is out of scope - see "Explicitly NOT in scope" above).
   Collects ALL violations found (does not short-circuit per-error, only
   before moving to step 4 if any exist).
4. **Registry validation** (`registry-validation.ts`, task 5.3). For every
   `Step` node anywhere in the document, extracts the digest from
   `service` (`<repo>@<alg>:<hex>` -> `<alg>:<hex>`, matching
   `registry/`'s own bare-digest key) and calls `getEntry(registryPool,
   digest)`: a `null` result is `unknown_service_digest`; a non-null
   result whose `functions` map lacks `step.function` is
   `unknown_service_function`. Runs only if step 3 found no errors (no
   point spending registry round-trips validating a document already
   known to be semantically broken).
5. If every step produced no errors: `{ ok: true, executionPlan: doc as
   ExecutionPlan }` - byte-identical to the input, per 0004's
   `ExecutionPlan = WorkflowSpec` alias (no distinct execution-plan
   document exists yet). Otherwise: `{ ok: false, errors: [...] }`
   (concatenated across whichever steps ran).

### New dependency

Adds the `yaml` package (`^2.x`, matching `archive/dsl/schema/`'s own
prior use) to `package.json` `dependencies` - the only new runtime
dependency this package needs; `ajv` (already a dependency via
`workflow-spec/`) is reused as-is via `validate()`.

### New error/constant surface

No new `ERROR_IDS` entries - `compile()`'s expected, recoverable
rejections are reported as data (`CompileError.code`), the same pattern
`workflow-spec/validate()` already established for schema errors, not
thrown `PlatformError`s. `constants.ts` holds `COMPILE_ERROR_CODES` (the
`CompileErrorCode` string literals, named once) and the small set of
YAML-AST predicates' named thresholds (none currently needed beyond the
predicates themselves - flagged here so Phase 3 doesn't invent an
unnamed magic string for e.g. the merge-key literal `"<<"`).

### Sequencing rationale

- **Why now:** this is the first package where every prerequisite is a
  *real, built* module rather than an archived spike - `workflow-spec/`
  (0004)'s types/`validate()`, `registry/` (0007)'s `getEntry` client, and
  `engine/` (0006a)'s `submitRun` (as this package's own end-to-end proof,
  not a dependency it imports). 0004's own plan doc explicitly deferred
  5.2/5.3/5.6a for exactly this reason ("`registry/` currently only exists
  as the archived JS spike... a separate promotion, not this package's
  job") - that promotion (0007) has since happened.
- **What it depends on:** `workflow-spec/` (0004, `validate`/types),
  `registry/` (0007, `getEntry`). Both `reviewed`.
- **What it unblocks:** the first genuine authoring-surface entry point
  into the platform - a human- or tool-authored YAML document can now be
  turned into something `engine/submitRun` accepts, closing the loop this
  package's own test design (below) exercises end-to-end. It also
  directly unblocks 6.2b's own future compiler-adjacent needs (a
  `branch`/`map`-bearing document can already be parsed/validated/
  registry-checked today, even though it can't be *run* until 6.2b
  exists) and gives a real target for a future `apps/dispatch-api`
  authoring endpoint.
- **What it deliberately does NOT try to unblock:** 5.9's signature
  publishing (`workflow-store/` doesn't exist) and 5.10's "distinct
  execution-plan" split (moot while `ExecutionPlan = WorkflowSpec`) -
  both would need real decisions this package has no reason to force.

## Test design

**Default setup evaluated: plain Vitest is sufficient for most of this
package; the registry-check and end-to-end tests need `testcontainers-node`
because they call real `registry/`/`core/` databases.** No crash/
concurrency/load test is warranted - this package has no transaction of
its own, no lease/retry semantics, and no contention surface (mirrors
0004's own "first genuinely I/O-free package" posture for its pure parts,
extended here with two ordinary I/O-dependent integration tests for the
parts that do touch a database).

| # | Test | Scope item | Correctness property verified |
|---|---|---|---|
| TC-1 | A restricted-YAML document using `&anchor`/`*alias` is rejected with `restricted_yaml_violation`, never silently resolved. | 5.6a | D8a's anchor/alias ban. |
| TC-2 | A document using a `<<` merge key is rejected with `restricted_yaml_violation`. | 5.6a | D8a's merge-key ban. |
| TC-3 | A document using a custom tag (`!myTag`) is rejected with `restricted_yaml_violation`. | 5.6a | D8a's custom-tag ban. |
| TC-4 | An ordinary restricted-YAML document (no anchors/aliases/tags) parses and reaches schema validation - proves the profile checks don't false-positive on plain YAML. | 5.6a | D8a (profile ban is narrowly scoped, not YAML-hostile). |
| TC-5 | A raw JS object (not a string) skips the restricted-YAML step entirely and is schema-validated directly. | 5.2 | The "Open questions" decision on non-string input. |
| TC-6 | A schema-invalid document (e.g. missing `workflowSpecVersion`) is rejected with `schema_invalid`, `path` set from ajv. | 5.2/5.6a | D8/D11 (schema is still the structural gate). |
| TC-7 | A document with two steps sharing the same id - one at top level, one nested inside a `branch` case - is rejected with `duplicate_step_id`. | 5.2 | D8c's document-wide flat id namespace. |
| TC-8 | A `dependsOn` entry naming a nonexistent step id is rejected with `unresolved_step_reference`. | 5.2 | D8a's `dependsOn` escape hatch presupposes a resolvable target. |
| TC-9 | A `{from:"step", id, output}` binding naming a nonexistent step id is rejected with `unresolved_step_reference`. | 5.2 | D8's "this IS the dependency edge" contract. |
| TC-10 | A step OUTSIDE a `branch` case references (via `dependsOn`) a step id defined INSIDE that case's subgraph - rejected with `internal_step_id_referenced_externally`. | 5.2 | D8c/5.7's internal-id-reference rejection rule. |
| TC-11 | A step inside a `map` body may reference a sibling step defined in the SAME body (accepted, no error). | 5.2 | Confirms TC-10's rule is scope-based, not a blanket ban. |
| TC-12 (testcontainers) | `service` references a digest never registered in `registry/` - rejected with `unknown_service_digest`. | 5.3 | D12: the registry is the sole source of truth for what exists. |
| TC-13 (testcontainers) | `service` references a registered digest, but `function` names a function absent from that digest's capabilities - rejected with `unknown_service_function`. | 5.3 | D12, same registry-authority rule at function granularity. |
| TC-14 (testcontainers) | `service`/`function` both resolve against a real registered entry - compiles to `{ ok: true }`. | 5.3 | Confirms the check isn't vacuously always-rejecting. |
| TC-15 (testcontainers) | A document with both a semantic error (TC-7 shape) and an otherwise-valid registry reference reports the semantic error and does NOT spend a registry round-trip (registry validation is skipped per step 4's short-circuit). | 5.2/5.3 | The plan's own short-circuit-on-semantic-failure design decision. |
| TC-16 (end-to-end, testcontainers, both `core/` and `registry/`) | A restricted-YAML fixture with two plain steps (B reads A's output) is compiled via `compile()` against a real registry with both digests registered, the resulting `executionPlan` is fed to `engine/submitRun`, and the run is driven to completion by manually calling `completeStep` (mirroring 0006's own interpreter test pattern) - `getRunResult` returns the expected resolved `outputs`. | 5.2/5.3 (integration) | The whole point of this package: a human-authored YAML document, once compiled, is byte-for-byte what `engine/` already knows how to run - proves 0004's `ExecutionPlan = WorkflowSpec` alias holds in practice, not just in the type system. |

**Collapsing the test-design gate into Phase 1's approval.** This package
qualifies as small/low-risk per the process's own collapse criterion: it
adds no new database schema, no transaction/lease/retry semantics, and no
concurrency surface (`registry/getEntry` is a plain read this package
calls exactly once per step, with no interleaving concern); its two
testcontainers-backed test groups reuse `startTestPostgres`/
`startRegistryPostgres`, already-established helpers, not new
infrastructure. It is not foundational or consolidation-critical - no
other module depends on `dsl-compiler/` existing (ADR-0007 lists it as a
leaf feeding future `apps/*`, none of which exist yet). Plan + test design
are therefore presented together here for one combined agreement.

## Implementation notes

_(filled in during Phase 3)_

## Review notes

_(filled in during Phase 4)_
