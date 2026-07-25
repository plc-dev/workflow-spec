# Workflow-spec authoring-surface JSON Schema

Formal JSON Schema for the workflow-execution-platform's authoring-surface
grammar, transcribed from `openspec/changes/workflow-execution-platform/design.md`
(decisions **D8, D8a, D8b, D8c, D8d**). This is the deliverable of task **1.7**:
transcription/tooling work only — no open syntax decisions remain.

- **Schema draft:** JSON Schema **draft 2020-12** (declared via `$schema`).
- **Validated artifact:** the *parsed* document structure, whether the source
  was restricted YAML or raw JSON (D8a: YAML is a structural superset of JSON, a
  single schema validates either once parsed). Field naming is camelCase
  throughout (D8a).

## Files

| Path | What |
| --- | --- |
| `workflow-spec.schema.json` | The schema. |
| `examples/` | Complete WorkflowSpec docs that MUST validate. |
| `examples-invalid/` | Docs that MUST fail, each commented with what's wrong. |
| `test.js` | Loads the schema (ajv) + parses each example (yaml) and asserts pass/fail. |
| `package.json` | Deps (`ajv`, `yaml`) and `npm test`. |

Run the tests:

```
cd dsl/schema
npm install
npm test
```

Current status: **9 passed, 0 failed** (5 valid examples pass, 4 invalid
examples are correctly rejected).

## Structure (which decision each part implements)

- **`WorkflowSpec`** (top level) — D8/D8a. Fields: `irVersion` (required
  integer; locked name per **D8d**/D11), `name`, optional `description`,
  optional `inputParameters` (flat names), optional `sessionState`, `steps`,
  optional `outputs`.
- **`sessionState`** — D8a: declared once per logical key (`interactivity:
  interactive|batch` + optional `fallback` Binding), never repeated per binding.
  `interactivity` appears only here (D8a: static-scope interactivity is not a DSL
  concept).
- **`Binding`** — D8/D8a/D8c, modeled as a `oneOf` over these kinds:
  - `{ from: static, ref }` — `ref` matches the dataset **URN** scheme
    `urn:<platform>:<resourceType>:<namespace>/<name>[:<tag> | @<alg>:<digest>]`
    (D8a; validated by regex).
  - `{ from: session, key }` — read.
  - `{ from: request, param }` — flat parameter name only; dotted/nested paths
    are rejected (D8a; `flatName` regex disallows `.`).
  - `{ from: step, id, output }` — another step's output (this *is* the
    dependency edge, D8).
  - `{ from: item }` — the current forEach item; deliberately minimal, no other
    fields (D8a).
  - `{ literal: <any JSON value> }` — literal constant, opaque pass-through
    (D8c); also the `allowedTools` nesting-target shape (D9c).
  - `{ compute: <JSON-Logic obj>, using: { name: Binding, ... } }` — D8/D10.
- **`WriteTarget`** — D8c: `{ to: session, key }`. Gating is automatic runtime
  behavior (D4), so there is no authored `gated` flag.
- **Secret references** — D8c/D7: a **separate category**, `{ scope:
  writer|user, name }`, living in a step's `secrets` block. Secrets are **not** a
  Binding kind, which is exactly what prevents them appearing in `compute`'s
  `using` (D10's categorical exclusion is enforced by construction — a secret ref
  simply matches no Binding alternative).
- **`Step`** — D8c: `{ id, service, function, dependsOn?, reads?, writes?,
  secrets? }`. `service` must be a digest-pinned OCI ref (`@<alg>:<digest>`);
  a bare tag is rejected (D8c hard rule; `ociDigestRef` regex).
- **`branch`** — D8c: `{ id, kind: "branch", selector, cases }`. `cases` is a
  **map keyed by the stringified selector value**, and the `default` case is an
  inline key inside that same map (matching the design.md example exactly, not a
  separate top-level field). Each case is `{ steps, yields? }`.
- **`map`** — D8c: `{ id, kind: "map", source, body, yields? }`.
- **`yields`** — D8c: `{ name: Binding, ... }` exposing named results out of a
  branch case or a map body (the same flat/named/typed shape as top-level
  `outputs`).
- **Nesting** — D8d: `branch`/`map` nest to any depth; expressed by `steps` /
  `body` items recursively referencing the same `node` union.

## Transcription notes / judgment calls

These are minor structural choices forced by transcribing prose + abbreviated
examples into a formal schema. None reopen a design question; each resolves to
the most faithful reading of design.md.

1. **`branch.default` is an inline `cases` key, not a top-level field.** The task
   brief mentioned both styles; the concrete design.md example (lines ~692-703)
   shows `"true"`, `"false"`, and `default` as three keys *inside the same
   `cases` map*. The schema implements exactly that: `default` is just another
   `cases` entry, validated by the same case shape. No separate top-level
   `default` property exists.

2. **`kind` discriminates the node union.** A plain `Step` is defined as a node
   with **no** `kind` field (`"kind": false`), while `branch`/`map` require
   `kind: "branch"|"map"`. This makes the `oneOf` over `step`/`branchNode`/
   `mapNode` unambiguous. The design shows plain steps without a `kind` field, so
   treating its absence as "plain step" is the faithful reading.

3. **`steps`/`body`/case-`steps` require `minItems: 1`.** A branch case or map
   body with zero steps is meaningless; the design always shows at least one.
   (Top-level `steps` also could be empty in principle, but is left non-empty-
   agnostic — only required to be present and an array. See limitation below.)

4. **`irVersion` typed as integer `>= 1`.** D11/D8d lock the name and describe it
   as an integer with forward-only migration. Migration logic itself is out of
   scope for this schema (task 1.7); the schema only requires presence + integer
   type.

5. **URN regex is permissive within each segment.** It enforces the overall
   `urn:<platform>:<resourceType>:<ns>/<name>[:tag|@alg:digest]` shape (D8a) but
   does not constrain platform/resourceType to a fixed vocabulary, keeping the
   `resourceType` extensibility D8a explicitly calls for.

6. **`literal` accepts any JSON value** (including `null`, arrays, objects,
   scalars) — D8c: "an arbitrary JSON value/structure, passed through opaquely."

## Limitations — what this schema does NOT (and cannot) enforce

- **Restricted-YAML profile (D8a).** The ban on YAML **anchors (`&`), aliases
  (`*`), merge keys (`<<`), and custom tags** CANNOT be enforced by this JSON
  Schema. Any YAML parser resolves those constructs away *before* a JSON Schema
  validator ever sees the resulting structure — by validation time they are gone.
  Enforcing the restricted profile is the responsibility of the **parser**
  (task **5.6a**), not this schema. Do not assume this schema alone provides that
  guarantee.

- **`yields` required when a case/body has more than one step (D8c ~line 737).**
  Deliberately NOT enforced structurally. The rule is "`yields` required whenever
  a body/case contains > 1 step; with exactly one step it defaults to that step's
  whole output object." JSON Schema *could* express this with `if`/`then` keyed
  on array length, but the brief directs leaving it as a documented rule rather
  than encoding it, so `yields` is simply optional here. Enforced elsewhere
  (authoring/validation layer).

- **Cross-reference resolution.** `{ from: step, id: X, output: Y }` and
  `dependsOn` refer to step ids in one flat, document-scoped namespace (D8c). This
  schema does not verify that referenced ids exist, that ids are unique across the
  whole document, or that a branch-case/map-body internal id is not referenced
  from outside its sub-graph. Those are semantic reference-resolution rules for a
  later analysis pass, not structural constraints of a single document.

- **`branch` case-shape consistency (D8c ~line 739).** The "every case yields the
  same logical shape under the same names" expectation is a semantic-type claim,
  explicitly left to authoring discipline / the derived-signature layer, not
  schema validation.
