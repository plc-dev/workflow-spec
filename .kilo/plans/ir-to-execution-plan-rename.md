# Plan: IR → execution plan rename

## Decisions captured

1. **Type alias (option b)**: `WorkflowSpec` stays as the top-level type. Add `ExecutionPlan = WorkflowSpec` as a temporary alias, flagged with a TODO for when `dsl-compiler/` lands.
2. **Schema field**: `irVersion` → `workflowSpecVersion` (author-facing). Execution plan versioning is a separate future concern.
3. **YAML/JSON profile language**: belongs to the authoring-surface schema, not the execution plan.
4. **Glossary**: new document at `docs/glossary.md` with entries for workflow-spec, execution plan, run, compose vs. nest, service image, registry entry, workflow-spec store.
5. **Archive**: left untouched.

## Implementation phases

### Phase 1: Code rename (directories + imports + constants)

1. **Rename directories**:
   - `src/ir/` → `src/execution-plan/`
   - `test/ir/` → `test/execution-plan/`

2. **Update imports** (3 files):
   - `src/engine/interpreter.ts`: `../ir/index.js` → `../execution-plan/index.js`
   - `src/engine/bindings.ts`: `../ir/index.js` → `../execution-plan/index.js`
   - `src/engine/dependency-graph.ts`: `../ir/index.js` → `../execution-plan/index.js`

3. **Update constants** (`src/execution-plan/constants.ts`):
   - `CURRENT_IR_VERSION` → `CURRENT_EXECUTION_PLAN_VERSION`
   - `IR_JSON_SCHEMA` → `EXECUTION_PLAN_JSON_SCHEMA`
   - Update comments

4. **Update barrel** (`src/execution-plan/index.ts`):
   - Re-export `CURRENT_EXECUTION_PLAN_VERSION` (was `CURRENT_IR_VERSION`)

5. **Update validate** (`src/execution-plan/validate.ts`):
   - Import `EXECUTION_PLAN_JSON_SCHEMA` (was `IR_JSON_SCHEMA`)
   - Update comment

6. **Add type alias** (`src/execution-plan/domain/workflow-spec.ts`):
   ```typescript
   // TODO: Split ExecutionPlan from WorkflowSpec when dsl-compiler/ lands.
   // Currently they are identical (no compile step exists yet).
   // See docs/glossary.md for the distinction.
   export type ExecutionPlan = WorkflowSpec;
   ```

7. **Update comments**:
   - `src/engine/interpreter.ts:23`: "IR JSON Schema" → "execution plan JSON Schema"
   - `src/core/database/schema.sql:67`: "IR node id" → "execution plan node id"
   - `src/execution-plan/domain/workflow-spec.ts:1`: "top-level IR document" → "top-level execution plan document"

### Phase 2: Schema + fixtures

1. **Update schema** (`src/execution-plan/schema/workflow-spec.schema.json`):
   - Description: "workflow-execution-platform IR" → "workflow-execution-platform execution plan"
   - Required field: `irVersion` → `workflowSpecVersion`
   - Property: `irVersion` → `workflowSpecVersion`
   - Update description to clarify this is the authoring-surface version

2. **Update test fixtures** (16 files in `test/execution-plan/fixtures/`):
   - All `valid/*.json` and `invalid/*.json` files: `irVersion` → `workflowSpecVersion`
   - Rename `invalid/03-missing-irversion.json` → `invalid/03-missing-workflow-spec-version.json`

3. **Update test code** (`test/execution-plan/validate.test.ts`):
   - Any references to `irVersion` in test names or assertions

### Phase 3: Design records (ADRs + design doc)

1. **Retitle ADR-0003**:
   - `docs/adr/0003-ir-is-the-system-spine.md` → `docs/adr/0003-execution-plan-is-the-system-spine.md`
   - Title: "The IR is the system spine (`@wfx/ir`)" → "The execution plan is the system spine (`@wfx/execution-plan`)"
   - Update all prose: "IR" → "execution plan" (except where it refers to the authored spec)
   - Add note: "The `WorkflowSpec` type is currently identical to the execution plan; this will split when the compiler lands."

2. **Update ADR-0001** (`docs/adr/0001-monorepo-and-typescript.md`):
   - Line 11: "representation (IR)" → "representation (execution plan)"
   - Line 12: "The IR is a *type" → "The execution plan is a *type"
   - Line 60: "JSON Schema for the IR" → "JSON Schema for the execution plan"
   - Line 61: "TypeScript types for the IR" → "TypeScript types for the execution plan"
   - Line 101: "IR contract" → "execution plan contract"

3. **Update ADR-0004** (`docs/adr/0004-binding-resolution-contract.md`):
   - Line 69: "the IR already anticipates" → "the execution plan already anticipates"

4. **Update ADR-0005** (`docs/adr/0005-step-dispatch-is-cli-nesting-stays-flexible.md`):
   - Line 45: "no new IR construct" → "no new execution plan construct"

5. **Update ADR-0007** (`docs/adr/0007-package-and-app-inventory.md`):
   - Line 10: "the IR spine" → "the execution plan spine"
   - Line 46: "IR-declared intent" → "execution-plan-declared intent"
   - Line 76: "authoring surface -> IR" → "authoring surface -> execution plan"

6. **Update ADR-0009** (`docs/adr/0009-language-build-and-quality-tooling.md`):
   - Line 13: "non-IR runtime shapes" → "non-execution-plan runtime shapes"
   - Line 80: "`ir/` remains on JSON Schema" → "`execution-plan/` remains on JSON Schema"
   - Line 84: "competing IR contract" → "competing execution plan contract"

7. **Update ADR-0011** (`docs/adr/0011-nested-dispatch-via-minted-callbacks.md`):
   - Line 34: "not a new IR construct" → "not a new execution plan construct"

8. **Update ADR-0012** (`docs/adr/0012-module-internal-structure-and-naming.md`):
   - Line 198: "an IR compiler" → "an execution plan compiler"

9. **Update `docs/adr/README.md`**:
   - Line 16: "IR as shared type contract" → "execution plan as shared type contract"
   - Line 18: "The IR is the system spine (`ir/`)" → "The execution plan is the system spine (`execution-plan/`)"

10. **Amend D8d** (`openspec/changes/workflow-execution-platform/design.md:784`):
    - "The IR version field is `irVersion`" → "The workflow-spec version field is `workflowSpecVersion`"
    - Clarify: this is the authoring-surface version, not the execution plan version

11. **Amend D11** (`openspec/changes/workflow-execution-platform/design.md:921-952`):
    - Reframe motivation: UI lagging behind backend → UI lagging behind authoring-surface version
    - "IR schema versioning" → "workflow-spec versioning"
    - Add note: execution plan versioning is a separate future concern

12. **Update design.md** (all other ~40 occurrences):
    - Replace "IR" with "execution plan" except where it refers to the authored spec
    - Specific cases:
      - Line 28: "stable intermediate representation (IR)" → "stable intermediate representation (execution plan)"
      - Line 29: "keeping the IR as statically analyzable" → "keeping the execution plan as statically analyzable"
      - Line 44: "Every requirement, IR construct" → "Every requirement, execution plan construct"
      - Line 216: "generic IR interpreter" → "generic execution plan interpreter"
      - Line 389: "DSL/IR split" → "DSL/execution plan split"
      - Line 413: "IR-to-engine compilation" → "execution-plan-to-engine compilation"
      - Line 496: "IR-to-engine compilation step" → "execution-plan-to-engine compilation step"
      - Line 589: "stable IR; the IR has static shape" → "stable execution plan; the execution plan has static shape"
      - Line 594: "IR (what runs)" → "execution plan (what runs)"
      - Line 602: "static output (the IR)" → "static output (the execution plan)"
      - Line 604: "The IR is built from" → "The execution plan is built from"
      - Line 609: "walking the IR for" → "walking the execution plan for"
      - Line 616: "from a stable IR" → "from a stable execution plan"
      - Line 622: "every IR construct" → "every execution plan construct"
      - Line 660: "against the abstract IR" → "against the abstract execution plan"
      - Line 696: "against the abstract IR" → "against the abstract execution plan"
      - Line 698: "D8's IR summary" → "D8's execution plan summary"
      - Line 774: "D8's own IR summary" → "D8's own execution plan summary"
      - Line 776: "the IR version field name" → "the workflow-spec version field name"
      - Line 831: "not a separate IR construct" → "not a separate execution plan construct"
      - Line 834: "not new IR" → "not new execution plan"
      - Line 876: "distinct IR construct" → "distinct execution plan construct"
      - Line 882: "the IR gains a new binding kind" → "the execution plan gains a new binding kind"
      - Line 917: "the IR's control-flow grammar" → "the execution plan's control-flow grammar"
      - Line 919: "embedded in the IR" → "embedded in the execution plan"
      - Line 923: "whatever IR version" → "whatever workflow-spec version"
      - Line 1027: "child's IR was macro-expanded" → "child's execution plan was macro-expanded"
      - Line 1033: "workflow-specs (IR + doc)" → "workflow-specs (execution plan + doc)"
      - Line 1045: "parent's IR already contains" → "parent's execution plan already contains"
      - Line 1084-1085: "IR-VERSION MISMATCH" → "WORKFLOW-SPEC-VERSION MISMATCH"
      - Line 1181: "A new IR binding kind" → "A new execution plan binding kind"
      - Line 1239: "every other decision, IR construct" → "every other decision, execution plan construct"
      - Line 1241: "D8 isolates it to the IR" → "D8 isolates it to the execution plan"
      - Line 1248: "constrains the IR" → "constrains the execution plan"
      - Line 1268: "IR-version-mismatch-on-fork" → "workflow-spec-version-mismatch-on-fork"

### Phase 4: Spec + proposal + tasks

1. **Update proposal.md** (`openspec/changes/workflow-execution-platform/proposal.md`):
   - Line 9: "stable intermediate representation (IR)" → "stable intermediate representation (execution plan)"
   - Line 18: "compiled to a stable, engine-agnostic, version" → (no change needed, already says "execution plan" context)
   - Line 48: "authoring-surface-to-IR" → "authoring-surface-to-execution-plan"

2. **Update tasks.md** (`openspec/changes/workflow-execution-platform/tasks.md`):
   - Line 7: "the IR contract" → "the execution plan contract"
   - Line 29: "IR-to-engine compilation step" → "execution-plan-to-engine compilation step"
   - Line 32: "engine-agnostic IR interpreter" → "engine-agnostic execution plan interpreter"
   - Line 32: "hand-written IR document" → "hand-written execution plan document"
   - Line 76: "IR-derived workflow-writer intent" → "execution-plan-derived workflow-writer intent"
   - Line 87: "Define the IR schema" → "Define the execution plan schema"
   - Line 88: "authoring-surface-to-IR compiler" → "authoring-surface-to-execution-plan compiler"
   - Line 89: "at IR-compile time" → "at execution-plan-compile time"
   - Line 103: "IR-to-execution-engine compilation" → "execution-plan-to-execution-engine compilation"
   - Line 106: "IR version tag" → "workflow-spec version tag"
   - Line 155: "older IR document" → "older workflow-spec document"
   - Line 182: "workflow-spec's IR + authoring doc" → "workflow-spec's execution plan + authoring doc"
   - Line 190: "IR-version mismatch" → "workflow-spec-version mismatch"

3. **Update workflow-dsl/spec.md** (`openspec/changes/workflow-execution-platform/specs/workflow-dsl/spec.md`):
   - Line 48: "stable intermediate representation (IR)" → "stable intermediate representation (execution plan)"
   - Line 48: "Only the IR SHALL be consumed" → "Only the execution plan SHALL be consumed"
   - Line 50: "produce equivalent IR" → "produce equivalent execution plans"
   - Line 52: "compile to IR" → "compile to execution plans"
   - Line 56: "resulting IR" → "resulting execution plan"
   - Line 110: "workflow-spec's IR" → "workflow-spec's execution plan"
   - Line 128: "compiled to IR" → "compiled to an execution plan"
   - Line 129: "the IR SHALL NOT contain" → "the execution plan SHALL NOT contain"
   - Line 129: "external to the IR" → "external to the execution plan"
   - Line 165: "declared in the IR" → "declared in the execution plan"
   - Line 302: "IR carries a whole-document version tag" → "Workflow-spec carries a whole-document version tag"
   - Line 303: "compiled IR document" → "compiled workflow-spec document"
   - Line 303: "named `irVersion`" → "named `workflowSpecVersion`"
   - Line 306: "workflow-spec IR document" → "workflow-spec document"
   - Line 310: "workflow-spec IR document's version tag" → "workflow-spec document's version tag"
   - Line 314: "added to the IR schema" → "added to the workflow-spec schema"
   - Line 343: "Deprecated IR versions" → "Deprecated workflow-spec versions"

4. **Update workflow-spec-store/spec.md** (`openspec/changes/workflow-execution-platform/specs/workflow-spec-store/spec.md`):
   - Line 26: "full internal IR" → "full internal execution plan"
   - Line 36: "its IR SHALL require" → "its execution plan SHALL require"
   - Line 101: "IR-version mismatch" → "workflow-spec-version mismatch"
   - Line 102: "different IR versions" → "different workflow-spec versions"
   - Line 102: "IR versioning model" → "workflow-spec versioning model"
   - Line 105: "different IR version" → "different workflow-spec version"

5. **Update execution-scheduling/spec.md** (`openspec/changes/workflow-execution-platform/specs/execution-scheduling/spec.md`):
   - Line 84: "workflow-spec's IR contains" → "workflow-spec's execution plan contains"

6. **Update item-pool-integration/spec.md** (`openspec/changes/workflow-execution-platform/specs/item-pool-integration/spec.md`):
   - Line 66: "IR-compile time" → "execution-plan-compile time"

### Phase 5: Impl plans

1. **Update 0004-ir-schema.md** (`docs/impl-plans/0004-ir-schema.md`):
   - Title: "IR schema - `ir/` module" → "Execution plan schema - `execution-plan/` module"
   - Line 11: "Define the IR schema" → "Define the execution plan schema"
   - Line 25: "authoring-surface-to-IR compiler" → "authoring-surface-to-execution-plan compiler"
   - Line 48: "walk the IR for" → "walk the execution plan for"
   - Line 55: "IR-to-execution-engine compilation" → "execution-plan-to-execution-engine compilation"
   - Line 66: "IR version tag migration chain" → "workflow-spec version tag migration chain"
   - Line 80: "The IR is the system spine" → "The execution plan is the system spine"
   - Line 375: "real IR document" → "real execution plan document"
   - Line 424: "the IR's baseline" → "the execution plan's baseline"
   - Line 436: "the IR type contract" → "the execution plan type contract"

2. **Update 0005-placement.md** (`docs/impl-plans/0005-placement.md`):
   - Line 64: "IR-declared intent" → "execution-plan-declared intent"
   - Line 377: "IR-to-engine compilation" → "execution-plan-to-engine compilation"

3. **Update 0006-interpreter-plain-steps.md** (`docs/impl-plans/0006-interpreter-plain-steps.md`):
   - Line 10: "generic IR interpreter" → "generic execution plan interpreter"
   - Line 110: "submitted run's IR document" → "submitted run's execution plan document"
   - Line 401: "the IR schema" → "the execution plan schema"
   - Line 402: "runs an IR document" → "runs an execution plan document"
   - Line 607: "neither the IR" → "neither the execution plan"

4. **Update README.md** (`docs/impl-plans/README.md`):
   - Line 64: "IR schema: `ir/` module" → "Execution plan schema: `execution-plan/` module"

### Phase 6: Glossary

Create `docs/glossary.md` with entries:

- **workflow-spec**: The authored, human-editable document that a workflow-writer creates. Plural authoring surfaces (restricted YAML/JSON, code builder) are supported. Versioned by `workflowSpecVersion`.
- **execution plan**: The compiled, engine-agnostic document that the scheduler analyzes and the interpreter runs. Currently identical to the workflow-spec (no compiler exists yet); will split when `dsl-compiler/` lands.
- **run**: One execution of an execution plan.
- **compose**: Combining steps into a workflow (writer activity). Reuse across workflows is by fork into the workflow-spec store.
- **nest**: A service function calling other registered services (service-author activity).
- **service image**: A container image registered in the service registry, exposing functions via OpenAPI.
- **registry entry**: Metadata for a service image in the service registry.
- **workflow-spec store**: Storage for workflow-specs under URN identity + immutable version, supporting fork-based reuse.

### Phase 7: Verification

1. **Run tests**: `npm test` — verify all tests pass
2. **Run lint**: `npm run lint` — verify no lint errors
3. **Run typecheck**: `npm run typecheck` — verify no type errors
4. **Manual check**: `grep -rnw 'IR' --exclude-dir=node_modules --exclude-dir=archive .` — verify no remaining "IR" references (except in archive)
5. **Manual check**: `grep -rn 'irVersion' --exclude-dir=node_modules --exclude-dir=archive .` — verify no remaining `irVersion` references

## Notes

- **Archive**: All files under `archive/` are left untouched (historical record).
- **Type alias**: `ExecutionPlan = WorkflowSpec` is temporary; flagged with TODO for when `dsl-compiler/` lands.
- **Schema field**: `irVersion` → `workflowSpecVersion` (author-facing). Execution plan versioning is separate future work.
- **YAML/JSON profile**: Belongs to the authoring-surface schema, not the execution plan.
