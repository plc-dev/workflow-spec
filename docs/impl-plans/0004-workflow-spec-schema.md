# 0004: Workflow-spec schema - `workflow-spec/` module (types, JSON Schema, `validate()`)

## Status

`reviewed`

## Scope

This package covers task **5.1** only:

- **5.1:** Define the execution plan schema (steps, bindings, write targets, secret
  refs, outputs) per design.md D8 - engine-agnostic.

Concretely: promote `archive/dsl/schema/workflow-spec.schema.json` (task
1.7's transcription deliverable) into a real top-level `src/workflow-spec/` module
(ADR-0007), extended with the one binding kind ADR-0003 names but the
archived schema never got (`itemResource`, D16), plus the TypeScript
domain types the JSON Schema has no equivalent of, plus a `validate(doc)`
function.

**Explicitly NOT in scope** (left for future `workflow-spec/`-adjacent packages, once
their own prerequisites exist or their own stakes justify a dedicated
package):

- **5.2** (authoring-surface-to-execution-plan compiler) - needs `dsl-compiler/`
  (doesn't exist) and 5.6a's restricted-YAML/JSON parser. `@wfx`-shaped
  packages don't exist per ADR-0001's revision, but the module doesn't
  exist either way.
- **5.3** (reject unknown service/function references at compile time) -
  needs `registry/` promoted to a real TS module with a client interface
  `dsl-compiler/` can call (`registry/` currently only exists as the
  archived JS spike, `archive/registry/` - a separate promotion, not this
  package's job).
- **5.4/5.4a/5.5/5.6/5.6a-5.6e/5.7/5.8/5.14/5.15/5.16** - these are either
  authoring-surface/compiler concerns (5.4, 5.4a, 5.6a) that build on top
  of the types this package defines rather than being part of the type
  contract itself, or validation rules this package's JSON Schema already
  states as designed (5.6c's flat-request-param rule, 5.7/5.8's
  branch/map internal-id-reference rejection) but doesn't yet enforce
  beyond structural shape - semantic reference-resolution is explicitly
  out of scope for a JSON Schema (see archived `dsl/schema/README.md`'s
  own "Limitations" section, carried forward below), or bindings
  (`itemResource`'s runtime resolution against 12.4's cache, 5.15/5.16)
  whose *type* this package defines but whose *resolution logic* belongs
  to a future `item-pool/`-consuming package.
- **5.9** (derived-signature generation *and publish* through the
  workflow-spec store's discovery mechanism) - `deriveSignature`'s pure
  "walk the execution plan for `request`/`session` bindings" logic is a natural `workflow-spec/`
  addition ADR-0003 names as part of the package's eventual contract, but
  5.9's own text bundles it with publishing through 11.2's discovery
  surface, which doesn't exist (`workflow-store/` isn't built). Deferred
  as a whole rather than half-built here with no consumer to prove it
  against - mirrors 0003's own restraint (`session/`'s snapshot-chain
  half deferred wholesale, not partially stubbed).
- **5.10** (execution-plan-to-execution-engine compilation) - needs 6.2's generic
  interpreter, which doesn't exist yet beyond spike 1.5.
- **5.11** (JSON-Logic vs. CEL "against real branch/map cases") - D10 has
  already *decided* JSON-Logic on desk-research/UI-decomposability
  grounds, but 5.11's own text asks for validation against real cases,
  which this package's schema-only scope doesn't exercise (no evaluator
  exists yet). Left `[ ]`, not touched.
- **5.12** (`compute` binding evaluation) - needs a real JSON-Logic
  evaluator (the future `logic/` pure module, per ADR-0007), which
  doesn't exist. This package types a `compute` binding's shape
  (`compute`/`using`) but does not evaluate it.
- **5.13/5.13a/5.13b** (`workflowSpecVersion` tag migration chain, fail-closed on
  too-new, minimum-supported-version window) - ADR-0003 lists `migrate()`
  as part of `@wfx/execution-plan`'s eventual contract, but it is a genuinely separate,
  non-trivial deliverable (a real migrator-chain mechanism, a fail-closed
  error path, a deprecation-sweep policy) with its own tasks.md line
  items - sized as its own future package rather than folded in here,
  mirroring how 6.1 was split into 6.1a/6.1b rather than bundled. This
  package's schema only *requires* `workflowSpecVersion`'s presence/type (exactly
  what the archived schema already did) and defines
  `CURRENT_WORKFLOW_SPEC_VERSION = 1` as a constant with nothing yet to migrate
  from.

## Sources

- **ADR-0003** ("The execution plan is the system spine"): names the exact contract
  this package builds - types (`WorkflowSpec`/`Step`/`Binding`
  discriminated union explicitly listing `itemResource` among its eight
  kinds/`WriteTarget`/`sessionState`/`branch`/`map`/`yields`), the
  canonical JSON Schema (promoted from `archive/dsl/schema/`), and
  `validate(doc)`. `migrate()`/`deriveSignature()` are named as part of
  the same eventual package but are explicitly deferred here (see Scope).
  `@wfx/execution-plan` "depends on nothing with I/O... may depend on `@wfx/logic`...
  and `@wfx/urn`... both pure" - neither exists yet, so `compute`'s
  expression and `static`/`itemResource`/URN-shaped strings are typed as
  plain `unknown`/`string` for now (see "Open questions" below).
- **design.md D8/D8a/D8c/D8d**: the concrete grammar this package's types
  and schema encode - the `Binding` discriminated union (`static | session
  | request | step | item | literal | compute`), `sessionState` declared
  once per key, the dataset URN scheme, flat `request` params, digest-only
  `service` refs, `branch`'s stringified-selector-keyed `cases` (with
  `default` as an inline key), `map`'s `source`/`body`/`yields`, secrets as
  a category separate from `Binding`, `workflowSpecVersion` as the locked version
  field name, and unrestricted `branch`/`map` nesting depth.
- **design.md D10**: `compute`'s `using` inputs structurally exclude
  secret references - a consequence of secrets not being a `Binding` kind
  at all (already true in the archived schema; this package's `itemResource`
  addition does not change it, since a secret ref still matches none of the
  `Binding` union's members).
- **design.md D16**: the one binding kind ADR-0003 lists but the archived
  schema (predating D15/D16) never added - `{ from: itemResource, itemId:
  <a Binding>, path: <locator> }`, resolving at *run time* against a cache
  this package does not build. This package's job is only the *type*
  (`itemId` is itself a `Binding`, typically request-scoped; `path` is a
  string locator) - see "Open questions" for the path-grammar judgment
  call this package has to make despite D16 leaving the exact grammar
  open.
- **`archive/dsl/schema/`** (task 1.7's deliverable): the actual starting
  point - `workflow-spec.schema.json` plus its `README.md`'s "Transcription
  notes" and "Limitations" sections, both carried forward into this
  package's own docs rather than re-derived from scratch, since nothing
  about D8/D8a/D8c/D8d changed between 1.7 and now. Only genuinely new
  content: `itemResource` (D16) and this package's own TypeScript domain
  types (the archived schema was JSON-Schema-only, no TS types existed
  anywhere for `WorkflowSpec` before this package).
- **ADR-0007**: `workflow-spec/` is a named top-level module - "pure: WorkflowSpec/
  Step/Binding types, JSON Schema, validate, migrate, deriveSignature" -
  and is explicitly called out as depended-on by `dsl-compiler/`,
  `workflow-store/`, `scheduler/`, and `engine/` (via `logic/`/`urn/`
  transitively) once each exists. This package creates `workflow-spec/` for the
  first time, populating only the types/schema/validate slice (mirroring
  `session/`'s own precedent in 0003 - populate only the currently-buildable
  slice of a module's eventual scope).
- **ADR-0012**: pure modules have no `database/` - confirmed applicable
  here (`workflow-spec/` has no DB, no I/O at all). Barrel-only cross-module imports,
  kebab-case, no abbreviations, `domain/` for types, a named feature file
  (`validate.ts`) rather than logic in `index.ts`.

**Open questions these sources leave unresolved, resolved here as a call
this package makes:**

- **`itemResource.path`'s exact grammar.** D16 itself says "JSON Pointer
  (RFC 6901) is the leading candidate... but the exact grammar is not
  formally locked down" and separately lists it as an Open Question in
  design.md's own Open Questions section. Resolved **for this package's
  schema only**: validate `path` as an RFC 6901 JSON Pointer string
  (`^$|^(/[^/~]*(~[01][^/~]*)*)*$`, the standard JSON-Pointer regex,
  matching the empty pointer or any sequence of `/`-prefixed reference
  tokens with `~0`/`~1` escaping). This is a **provisional, revisitable**
  choice consistent with D16's own framing ("the leading candidate"), not
  a re-opening or silent closing of the open question - documented here,
  and in the schema's own description field, as exactly that. If D16's
  open question is ever formally resolved differently, this package's
  regex is the one line that needs to change.
- **How should `compute`'s expression and URN-shaped strings (`static.ref`,
  the dataset-URN pattern) be typed in TypeScript, given `logic/`/`urn/`
  don't exist yet?** Resolved: named **placeholder type aliases** -
  `LogicExpression`, `Urn`, `JsonPointer`, `OciDigestRef` - each currently
  aliased to `Record<string, unknown>`/`string`, rather than inlining
  `unknown`/`string` directly into `Binding`/`Step`'s own field types.
  Noted explicitly (not silently assumed) as an interim typing choice per
  ADR-0003's own "MAY depend on" phrasing (not "MUST") - `workflow-spec/` is
  buildable and useful without either pure module existing yet. The
  placeholder-alias indirection means tightening these later (once
  `logic/`/`urn/` land) is a one-line change to each alias's own
  definition, not a hunt through every interface that references it - a
  smaller, more localized refinement than editing `Binding`/`Step`
  directly.
- **Does this package enforce `yields` being required when a case/body
  has more than one step (D8c's own stated rule)?** No - carrying forward
  the archived schema's own documented limitation verbatim: JSON Schema
  could express this with an `if`/`then` keyed on array length, but D8c's
  own text directs leaving it as a documented rule rather than encoding
  it. Unchanged from 1.7's original judgment call; not revisited here.
- **Does this package enforce branch-case/map-body internal-step-id
  isolation, or step-id uniqueness across the whole document?** No -
  carrying forward the archived schema's "Limitations" section verbatim:
  this is semantic reference-resolution, not structural document shape,
  and belongs to a later analysis pass (task 5.6, dependency-graph
  inference; part of the deferred `dsl-compiler/`), not this schema.

## Plan

### File/module layout

```
src/workflow-spec/                              (NEW top-level module - ADR-0007)
  index.ts                           (new) barrel - exports every domain
                                     type, CURRENT_WORKFLOW_SPEC_VERSION, validate()
  constants.ts                       (new) CURRENT_WORKFLOW_SPEC_VERSION = 1;
                                     JSON_SCHEMA_ID
  domain/
    workflow-spec.ts                 (new) WorkflowSpec
    node.ts                          (new) Node, Step, BranchNode,
                                     MapNode, CaseBody (D8c's node union -
                                     kept in one file since Step/BranchNode/
                                     MapNode only make sense as members of
                                     the same discriminated union)
    binding.ts                       (new) Binding discriminated union
                                     (8 kinds incl. itemResource)
    session-state.ts                 (new) SessionStateDeclaration
    write-target.ts                  (new) SessionWriteTarget
    secret-ref.ts                    (new) SecretRef
    placeholder-types.ts             (new) LogicExpression, Urn,
                                     JsonPointer, OciDigestRef - named
                                     stand-ins for logic/'s and urn/'s
                                     eventual real types (see Open
                                     questions)
  schema/
    workflow-spec.schema.json        (new) promoted from
                                     archive/dsl/schema/, extended with
                                     itemResource
  validate.ts                       (new) validate(doc): ValidationResult,
                                     backed by ajv (draft 2020-12)

test/workflow-spec/
  fixtures/
    valid/*.json                    (new) complete WorkflowSpec docs that
                                     MUST validate (ported + extended from
                                     archive/dsl/schema/examples/)
    invalid/*.json                   (new) docs that MUST fail, one
                                     documented defect each (ported +
                                     extended from
                                     archive/dsl/schema/examples-invalid/)
  validate.test.ts                  (new) fixture-driven pass/fail +
                                     targeted per-binding-kind cases
  domain.test.ts                    (new) type-level sanity via runtime
                                     shape checks (see Test design)

package.json                        (extended) + ajv dependency
```

No changes to `src/core/`, `src/engine/`, `src/session/`, or
`src/shared/` - this package touches nothing that already exists, the
same "additive, no shared-file churn" shape 0002/0003 both had.

### Interfaces (signatures)

```ts
// src/workflow-spec/domain/placeholder-types.ts
// Named stand-ins for types that will eventually live in the future pure
// modules `logic/` (D10's JSON-Logic evaluator) and `urn/` (D8a/D13's URN
// parser) - neither exists yet (ADR-0003: workflow-spec/ "MAY depend on" them, not
// "MUST"). Each alias is currently just unknown/string; the indirection
// means tightening these later is a one-line change here, not a hunt
// through every interface that references one.
export type LogicExpression = Record<string, unknown>; // D10 compute expr
export type Urn = string;                                // D8a dataset URN
export type JsonPointer = string;                        // D16 itemResource path
export type OciDigestRef = string;                       // D8c digest-pinned service ref

// src/workflow-spec/domain/binding.ts
export type Binding =
  | StaticBinding
  | SessionBinding
  | RequestBinding
  | StepBinding
  | ItemBinding
  | LiteralBinding
  | ComputeBinding
  | ItemResourceBinding;

export interface StaticBinding { from: "static"; ref: Urn; }
export interface SessionBinding { from: "session"; key: string; }
export interface RequestBinding { from: "request"; param: string; }
export interface StepBinding { from: "step"; id: string; output: string; }
export interface ItemBinding { from: "item"; }
export interface LiteralBinding { literal: unknown; }
export interface ComputeBinding {
  compute: LogicExpression; // D10; placeholder until logic/ exists
  using?: Record<string, Binding>;
}
export interface ItemResourceBinding {
  from: "itemResource";
  itemId: Binding;       // D16: typically request-scoped, but any Binding
  path: JsonPointer;      // D16: provisional grammar - see Open questions
}

// src/workflow-spec/domain/session-state.ts
export interface SessionStateDeclaration {
  interactivity: "interactive" | "batch";
  fallback?: Binding;
}

// src/workflow-spec/domain/write-target.ts
export interface SessionWriteTarget { to: "session"; key: string; }

// src/workflow-spec/domain/secret-ref.ts
export interface SecretRef { scope: "writer" | "user"; name: string; }

// src/workflow-spec/domain/node.ts
export interface Step {
  id: string;
  service: OciDigestRef; // always digest-pinned (D8c hard rule)
  function: string;
  dependsOn?: string[];
  reads?: Record<string, Binding>;
  writes?: Record<string, SessionWriteTarget>;
  secrets?: Record<string, SecretRef>;
}
export interface CaseBody {
  steps: Node[];
  yields?: Record<string, Binding>;
}
export interface BranchNode {
  id: string;
  kind: "branch";
  selector: Binding;
  cases: Record<string, CaseBody>; // keyed by stringified selector value;
                                    // "default" is an inline key (D8c)
}
export interface MapNode {
  id: string;
  kind: "map";
  source: Binding;
  body: Node[];
  yields?: Record<string, Binding>;
}
export type Node = Step | BranchNode | MapNode;

// src/workflow-spec/domain/workflow-spec.ts
export interface WorkflowSpec {
  workflowSpecVersion: number; // locked field name, D8d/D11
  name: string;
  description?: string;
  inputParameters?: string[];
  sessionState?: Record<string, SessionStateDeclaration>;
  steps: Node[];
  outputs?: Record<string, Binding>;
}

// src/workflow-spec/validate.ts
export interface ValidationError {
  /** ajv instancePath, e.g. "/steps/0/service" */
  path: string;
  message: string;
}
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}
// Validates the parsed document structure (already-parsed JSON/YAML - see
// Scope: the restricted-YAML profile itself is NOT and cannot be checked
// here, per the archived schema's own documented limitation, carried
// forward unchanged). Does not throw on an invalid doc - returns
// { valid: false, errors } so callers (a future dsl-compiler/, a future
// workflow-spec store) decide what to do with an invalid document.
export function validate(doc: unknown): ValidationResult;

// src/workflow-spec/constants.ts
export const CURRENT_WORKFLOW_SPEC_VERSION = 1;
```

### Data flow

```ts
import { validate, CURRENT_WORKFLOW_SPEC_VERSION, type WorkflowSpec } from "../workflow-spec/index.js";

const parsed: unknown = JSON.parse(rawDocText); // or a YAML parse, done
                                                 // by a future dsl-compiler/
const result = validate(parsed);
if (!result.valid) {
  // caller's responsibility - this package makes no decision about
  // rejecting vs. surfacing-to-author here
  throw new Error(result.errors.map((e) => `${e.path}: ${e.message}`).join("; "));
}
const spec = parsed as WorkflowSpec; // safe once result.valid is true
```

No transaction, no repository, no shared `withTransaction`/`CoreRepos`
pattern - this package has nothing to compose with `core/`'s consolidated
schema, matching ADR-0007's own framing of `workflow-spec/` as one of the three pure
modules with no I/O at all.

### Sequencing rationale

- **Why now:** `workflow-spec/` is the one module ADR-0003 explicitly says to "build
  first" - `dsl-compiler/` produces it, `workflow-store/` persists it,
  `scheduler/` and `engine/` consume it, and "none of those can be
  meaningfully built without it." Every other still-open branch of
  section 5 (5.2-5.16) and every task depending on a real execution plan document
  (5.9's signature, 5.10's compilation, 6.2's interpreter, 8.7/8.8/8.12's
  end-to-end tests) is currently blocked on nothing but this package.
  Compared to the other candidates evaluated for this slot
  (`registry/` promotion, `session/`'s snapshot-chain half, `scheduler/`+
  placement promotion), this is the smallest, most self-contained, and
  most-blocking-of-other-work slice available.
- **What it depends on:** nothing already built (`core/`, `engine/`,
  `session/` are all untouched); depends only on `archive/dsl/schema/`'s
  already-done transcription work (task 1.7) as its starting point, and on
  adding `ajv` as a new dependency.
- **What it unblocks:** `dsl-compiler/` (5.2 and everything under it),
  `workflow-store/` (11.1, which needs to store *something* typed), and
  gives `scheduler/`/`engine/` a real type to eventually accept once 5.10/
  6.2 exist - none of those could start meaningfully before this.
- **What it deliberately does NOT unblock yet:** anything requiring
  `logic/` (a real JSON-Logic evaluator, 5.12) or `urn/` (parsed URN
  types, currently plain strings here) to exist - both remain future pure
  modules, built when a real consumer needs more than `unknown`/`string`
  typing.

## Test design

**Collapsing Phase 2's gate into Phase 1's approval.** This package
qualifies for 0002/0003's own documented exception: it is small (one new
pure module, ~7 files), low-risk (no I/O, no shared state, nothing else in
the repo imports from or is affected by it yet), and not
foundational/consolidation-critical in the way `core/`'s schema or
`engine/`'s dispatch loop are - an error here is caught by a failing
`validate()` call, not by data corruption or a stuck execution. Presenting
plan + test design together for one combined agreement.

### Setup: default Vitest is sufficient; testcontainers-node is not needed at all

Every test below is pure - no database, no filesystem I/O beyond loading
fixture JSON files already present in `test/`, no concurrency. This is the
first package in the repo with genuinely nothing for testcontainers-node
to do: `workflow-spec/` has no `database/` per ADR-0012 (pure modules don't get one),
so there is no real-Postgres-semantics stake to test against. Plain
Vitest, no container startup, no `testTimeout`/`hookTimeout` relevance.

No load/scale test - `validate()` compiles the ajv schema once at module
load and calls a synchronous validator function; there is no hot path or
contention shape here comparable to `claim_execution()`/`signal_wait()`.

### Test cases

| # | Test | Scope item | Correctness property verified |
|---|---|---|---|
| TC-1 | A minimal valid `WorkflowSpec` (one plain step, no branch/map, no `sessionState`, no `outputs`) validates successfully | 5.1 schema | design.md D8 - the execution plan's baseline structural contract |
| TC-2 | A doc missing `workflowSpecVersion`, missing `name`, or missing `steps` each fails validation with a non-empty `errors` array pointing at the missing field | 5.1 schema | D8d - `workflowSpecVersion` is a required, locked-name field; D8 - `name`/`steps` are the minimum a `WorkflowSpec` needs to mean anything |
| TC-3 | Each of the 8 `Binding` kinds (`static`, `session`, `request`, `step`, `item`, `literal`, `compute`, `itemResource`), given a well-formed example, validates individually when used as a step's `reads` entry | 5.1 schema | D8/D8a/D8c/D16 - the discriminated union is complete and each kind's own required fields are correctly modeled |
| TC-4 | An `itemResource` binding with a well-formed nested `itemId` (itself a `request` binding) and a valid RFC 6901 `path` (including the empty-string pointer and a multi-segment pointer with `~0`/`~1` escaping) validates; a malformed `path` (e.g. `"foo.bar"`, no leading `/`) fails | 5.1 schema | D16 - this package's own resolved provisional grammar choice for `path` |
| TC-5 | `{ from: request, param: "a.b" }` (a dotted path) fails validation; `{ from: request, param: "query" }` passes | 5.1 schema | D8a - a workflow's derived signature stays flat; dotted/nested paths are rejected at the binding-source level |
| TC-6 | `{ from: static, ref: "urn:workflow-platform:dataset:team/name:v1" }` and the `@sha256:...`-digest form both pass; `{ from: static, ref: "not-a-urn" }` fails | 5.1 schema | D8a - the dataset URN scheme |
| TC-7 | A step with `service: "registry.internal/svc@sha256:<hex>"` passes; a step with a bare-tag `service` (no `@alg:digest`) fails | 5.1 schema | D8c - a step's service reference is always digest-pinned, never a mutable tag |
| TC-8 | A step's `secrets` block with `{ scope: "writer", name: "apiKey" }` validates; a `compute` binding's `using` map rejects a value shaped like a `SecretRef` (`{scope, name}`) because it matches no `Binding` union member | 5.1 schema | D8c (secrets are a category separate from `Binding`) and D10 (secrets structurally excluded from `compute`'s `using`, by construction, not a runtime check) |
| TC-9 | A `branch` node with `cases` keyed `"true"`/`"false"`/`default`, each with `steps` + `yields`, validates; a `cases` map with zero entries fails (`minProperties: 1`) | 5.1 schema | D8c - `branch`'s value-keyed cases map, `default` as an inline key |
| TC-10 | A `map` node with `source`/`body`/`yields` validates; a `body` with zero steps fails (`minItems: 1`) | 5.1 schema | D8c - `map`'s statically-shaped body |
| TC-11 | A `branch` case's `steps` containing a nested `map` node, whose `body` contains a nested `branch` node, validates (two levels of alternating nesting) | 5.1 schema | D8d - `branch`/`map` nesting depth is unrestricted |
| TC-12 | A `sessionState` block with one key declaring `interactivity: interactive` and a `fallback` binding, and a second key declaring only `interactivity: batch` (no fallback), both validate; a key missing `interactivity` fails | 5.1 schema | D8a - `sessionState` declared once per key, `fallback` optional |
| TC-13 | A doc with an unrecognized top-level property (e.g. `foo: 1`) fails validation; a `Binding` object with an extra unrecognized property fails | 5.1 schema | `additionalProperties: false` throughout - keeps the authoring surface and the execution-plan type contract exactly in sync (ADR-0003's "one type universe, one validator") |
| TC-14 | `validate()` called with a deliberately invalid doc returns `{ valid: false, errors: [...] }` rather than throwing, and `errors[0]` has both a non-empty `path` and a non-empty `message` | `validate()` | this package's own resolved interface choice - callers decide what to do with an invalid document, `validate()` never throws on invalid input |

TC-3 through TC-13 are implemented as a mix of inline fixture objects in
`validate.test.ts` (one assertion per row) and the ported/extended
`test/workflow-spec/fixtures/{valid,invalid}/*.json` files (whole-document
compositions exercising several rules together, carried forward from
`archive/dsl/schema/examples{,-invalid}/` with `itemResource` examples
added) - `validate.test.ts` iterates every fixture file and asserts
pass/fail, mirroring the archived `test.js`'s own approach.

`domain.test.ts` has no correctness property of its own to verify beyond
"this compiles" - TypeScript's structural typing means the domain types
have no runtime behavior to test. It exists only to exercise each type in
a realistic composed `WorkflowSpec` value (one per `Binding` kind) so a
future refactor that silently narrows a type incorrectly is caught by
`tsc --noEmit`, not left undiscovered until some future package's own
code fails to compile against it.

## Implementation notes

Built exactly as planned, with one directed change from the plan-agreement
round-trip (see "Test design" note above) and a couple of small mechanical
findings surfaced while writing the code - neither is a deviation from the
plan's own shape:

- **Placeholder types, not inlined `unknown`/`string`, per explicit
  direction during plan approval.** `src/workflow-spec/domain/placeholder-types.ts`
  defines `LogicExpression`, `Urn`, `JsonPointer`, `OciDigestRef` as named
  aliases (currently `Record<string, unknown>`/`string`), and every field
  that would otherwise have been raw `unknown`/`string`
  (`ComputeBinding.compute`, `StaticBinding.ref`, `ItemResourceBinding.path`,
  `Step.service`) references the alias instead. The plan document itself
  was updated in place (Open questions, interface sketch) before writing
  any code, so the plan and the implementation agree exactly - no
  after-the-fact reconciliation needed.
- **ajv's `Ajv2020` had to be imported as a named import
  (`import { Ajv2020 } from "ajv/dist/2020.js"`), not the default import
  the plan's own data-flow sketch implicitly assumed.** A default import
  (`import Ajv2020 from "ajv/dist/2020.js"`) type-checks as having no
  construct signature under this repo's `NodeNext`/`esModuleInterop`
  tsconfig, even though `ajv`'s own `.d.ts` declares both a named class
  export and a `export default` re-export of it - a TypeScript/Node
  module-interop quirk specific to this dependency, not a design choice.
  Confirmed the named import resolves to the same runtime class (both
  compiles the same schema and validates identically) before settling on
  it. No test depends on which import style was used, so no test
  needed updating.
- **`ValidationError.message` needed an explicit fallback for ajv's
  optional `error.message`.** ajv's `ErrorObject.message` is typed
  `string | undefined` (only absent if a custom keyword's error function
  omits it, which never happens for this schema's own vocabulary) -
  `toValidationError` falls back to a fixed string
  (`"Schema validation failed with no message."`) rather than allowing
  `undefined` to leak into `ValidationError.message`'s `string` type. Not
  exercised by any test (ajv always supplies a message for every keyword
  this schema uses), noted here rather than silently working around a
  type error.

All 14 planned test cases (TC-1 through TC-14) are implemented and
passing, split across two files:

- `test/workflow-spec/validate.test.ts` (46 tests): the whole-document fixture suite
  (TC-1, ported/extended from `archive/dsl/schema/examples{,-invalid}/` -
  6 valid + 5 invalid fixtures under `test/workflow-spec/fixtures/`, one new
  `itemResource` example added to each side) plus TC-2 through TC-14 as
  dedicated `describe` blocks, each comment-labeled with its TC number.
- `test/workflow-spec/domain.test.ts` (1 test): the compile-time domain-type exercise
  described in the plan's Test design section.

`npx tsc --noEmit`, `npx biome check .`, and `npx vitest run` all pass
clean (107/107 tests across 16 files, up from 0003's 60 - the 47 new tests
are exactly this package's 46 `validate.test.ts` cases plus 1
`domain.test.ts` case) - verified directly immediately before writing this
section, not assumed. `biome check --write .` was run once to fix three
purely mechanical formatting/import-order findings (import-statement
ordering in `node.ts`, object-wrapping in `index.ts` and
`validate.test.ts`) - no logic changed by that pass.

`biome.json`'s `noRestrictedImports` list needed **no new entries**: that
rule only lists *existing* cross-module relative imports (ADR-0012 §4's
documented, hand-maintained limitation), and nothing outside `workflow-spec/` itself
imports any of its internals yet - `workflow-spec/` has no consumer in this repo so
far (test files import via the barrel, `../../src/workflow-spec/index.js`, exactly
as intended). This will need a new entry the first time a future package
(`dsl-compiler/`, `workflow-store/`, `scheduler/`, `engine/`) imports
`workflow-spec/`'s barrel from a relative depth not already covered by an existing
rule entry - not needed yet.

No env vars were added or changed - `.example.env` needed no update
(verified by inspection: `grep -rn "process.env" src/workflow-spec/` returns no
matches).

No follow-up tasks spun off beyond what Scope already named as explicitly
deferred (5.2/5.3/5.9/5.10/5.11/5.12/5.13/5.13a/5.13b) - none of those were
touched or partially started.

**Post-review fixes** (from the local code review pass immediately after
this section was first written - both within this package's own scope, no
plan/test-design change; each is also covered by a new/strengthened test,
not just fixed in place, mirroring 0002/0003's own posture):

- **`validate()` threw an uncaught `RangeError` on an adversarially deep
  binding-nesting chain, breaking its own documented never-throws
  contract.** The `Binding` schema is recursive (`compute.using` and
  `itemResource.itemId` both recurse into `#/$defs/binding`) - a small
  (tens of KB) but deeply nested document (e.g. 5,000 nested `compute`
  bindings) exhausted ajv's generated recursive validator's call stack, a
  straightforward DoS vector for any future caller validating untrusted,
  externally-authored workflow-spec documents. Fixed by wrapping
  `validateFn(doc)` in a try/catch that converts a `RangeError`
  specifically into an ordinary `{ valid: false, errors: [...] }` result
  (any other thrown error still propagates, since only stack-depth
  exhaustion is an expected/adversarial shape here, not a general
  catch-all). Regression test: `test/workflow-spec/validate.test.ts` - "does not
  throw on an adversarially deep binding-nesting chain - returns invalid
  instead."
- **`constants.ts`'s `JSON_SCHEMA_DRAFT`/`JSON_SCHEMA_ID`/
  `JSON_POINTER_PATTERN` were hand-duplicated literals with no code path
  connecting them to the actual schema file they described, and none of
  the three was ever imported anywhere - dead, drift-risk code introduced
  beyond what the plan's own file-layout sketch had named (the plan listed
  only `CURRENT_WORKFLOW_SPEC_VERSION`/`JSON_SCHEMA_ID`).** Fixed by having
  `constants.ts` itself load and parse `schema/workflow-spec.schema.json`
  once (`WORKFLOW_SPEC_JSON_SCHEMA`), deriving `JSON_SCHEMA_ID` from the loaded
  schema's own `$id` field instead of a second hardcoded copy, and
  removing `JSON_SCHEMA_DRAFT`/`JSON_POINTER_PATTERN` entirely (both were
  pure duplicates of values already stated once in the schema file, with
  no consumer). `validate.ts` now imports `WORKFLOW_SPEC_JSON_SCHEMA` from
  `constants.ts` instead of independently re-reading/re-parsing the file
  itself - one file read at module load, not two. No dedicated new test -
  this is a duplication/dead-code removal with no behavior change; every
  existing schema-validation test still passes unchanged against the
  now-single-sourced schema object.
- **A related `tsc` finding surfaced while fixing the `RangeError`
  handling, not part of the original review**: `validateFn(doc)`'s return
  type is `boolean | Promise<unknown>` in ajv's own types (to cover
  schemas that opt into `$async` validation), which `tsc --noEmit`
  correctly flagged once the call was moved into a `let`-assigned
  variable inside a `try` block. This schema has no `$async` keyword, so
  the call is always synchronous - fixed with an explicit `as boolean`
  cast and a comment explaining why the cast is safe, not by ignoring or
  suppressing the type error.

Re-ran `npx tsc --noEmit`, `npx biome check .`, and `npx vitest run`
immediately after these fixes: clean typecheck, clean lint, 108/108 tests
passing across 16 files (up from 107, the one new regression test).

## Review notes

Compared against the agreed plan (Phase 1, as amended during approval to
use placeholder types) and agreed test design (Phase 2, collapsed into the
same agreement), not a fresh read of the code in a vacuum:

- Every Scope item (task 5.1) is present: `WorkflowSpec`/`Step`/`Node`/
  `Binding` (all 8 kinds incl. `itemResource`)/`SessionStateDeclaration`/
  `SessionWriteTarget`/`SecretRef` domain types, the promoted-and-extended
  JSON Schema at `src/workflow-spec/schema/workflow-spec.schema.json`, and
  `validate()` at `src/workflow-spec/validate.ts`, all re-exported through
  `src/workflow-spec/index.ts`'s barrel.
- The placeholder-type directive from plan approval is implemented exactly
  as agreed: `LogicExpression`/`Urn`/`JsonPointer`/`OciDigestRef` exist as
  named aliases in `domain/placeholder-types.ts`, and every field that
  would otherwise have been inlined `unknown`/`string` references one.
- All 14 agreed test cases (TC-1 through TC-14) exist and pass -
  cross-checked against the Test design table's own file/property
  mapping; every `describe` block in `validate.test.ts` is comment-labeled
  with its TC number.
- A local code review pass (`/local-review-uncommitted`) found one real
  bug (`validate()`'s uncaught `RangeError` on adversarially deep
  nesting, breaking its own never-throws contract) plus one duplication/
  dead-code finding (`constants.ts`'s three hand-duplicated, unused
  schema literals). Both were fixed, the bug with a new regression test
  (see Implementation notes' "Post-review fixes"); the duplication fix is
  a behavior-neutral single-sourcing change covered by the existing test
  suite continuing to pass unchanged. The review's other four tracks
  (security beyond the RangeError DoS angle, performance, deploy safety,
  and the remaining business-logic checks) returned no findings - the
  module is additive-only (no existing file was modified except
  `package.json`'s new `ajv` dependency; `biome.json` untouched, as noted
  above), with no shared state or existing consumer to regress.
- Re-ran `npx tsc --noEmit`, `npx biome check .`, and `npx vitest run`
  immediately after the post-review fixes: clean typecheck, clean lint,
  108/108 tests passing across 16 files.
- No scope creep: 5.2/5.3/5.9/5.10/5.11/5.12/5.13/5.13a/5.13b were not
  touched, consistent with the plan's explicit exclusions; `logic/`/
  `urn/` were not created (their eventual types remain placeholder
  aliases, as agreed).
- `tasks.md` accurately reflects reality: 5.1 marked `[x]` with a pointer
  to the real files/tests, not just this doc.

No further follow-up issues found. Package considered complete for its
stated scope.
