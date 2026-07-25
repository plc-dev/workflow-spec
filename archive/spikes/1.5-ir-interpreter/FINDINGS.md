# Spike 1.5 — Generic, engine-agnostic IR interpreter

**Task**: tasks.md 1.5. Spike compiling a trivial hand-written workflow-spec
into a generic, engine-agnostic IR interpreter targeting whichever engine
was selected in 1.4 (now decided: the Postgres-native path, D6/D6a).

## What "generic" and "engine-agnostic" mean here (stated up front)

- **Generic**: `src/interpreter.js` contains no reference to this specific
  workflow's node ids, function names, or shape. It walks whatever
  `nodes`/`reads`/`selector`/`source`/`yields` structure the IR document
  actually contains, and derives dependency order, branch-case selection,
  and map fan-out purely from that structure. A different workflow-spec
  (different steps, different branch/map arrangement) would run against
  the exact same interpreter code, unmodified.
- **Engine-agnostic** is a narrower claim than it might sound: the IR
  *walking logic* (dependency analysis, binding resolution, branch/map
  semantics) doesn't hardcode Postgres specifics - but the *dispatch loop*
  underneath it (`claim_execution`, checkpoints, transactions) is
  necessarily the concrete Postgres-native engine from D6/D6a, not a
  swappable abstraction over multiple real engines. This spike proves "the
  IR shape doesn't need to change per engine," not "this file runs
  unmodified against Temporal tomorrow." Task 5.10 (IR-to-execution-engine
  compilation) is the eventual place a second engine target would plug in,
  and it would target the same `executions`/`checkpoints`/dependency-
  promotion pattern this spike validates - not a different one.

## What was built

- `ir/example-workflow.json` - a real (not toy-simple-to-the-point-of-
  meaninglessness) IR document: a two-case `branch` (discount vs. no
  discount, selected via a `compute` binding), a `map`/`forEach` over a
  runtime-sized `items` array, and a final step that depends on **both**
  the branch's and the map's outputs - the minimum shape that actually
  exercises cross-node dependency ordering, not just a linear pipeline.
- `schema.sql` - the same `executions`/`checkpoints`/`claim_execution()`
  shape as spikes 1.2/1.8, plus two new tables needed to interpret a
  *multi-node* workflow generically: `workflow_runs` (one row per
  invocation) and `run_node_outputs` (per-run, per-**top-level**-node
  completed output - used both to resolve `{from:"step"}` bindings across
  node boundaries and to decide when a blocked node's dependencies are
  satisfied).
- `src/interpreter.js` - dependency analysis (`externalDepsOf`, a generic
  walk for `{from:"step", id}` references, minus a node's own internal
  case/body step ids), submission (`submitRun`), dependency promotion
  (`promoteReadyNodes`, run in the same transaction as the write that
  satisfies a dependency), and per-kind dispatch (plain step, branch
  fan-out/rejoin, map fan-out/rejoin) - all sharing the one
  claim-and-dispatch loop (`processOne`).
- `src/bindings.js` / `src/compute.js` / `src/functions.js` - binding
  resolution, a deliberately minimal JSON-Logic-*shaped* expression
  evaluator (explicitly NOT resolving task 5.11's open JSON-Logic-vs-CEL
  question - just enough to drive a branch selector), and a built-in
  function registry standing in for real service dispatch (explicitly NOT
  attempting the registry/HTTP integration that's tasks 2.x/5.3/6.3/6.4's
  job).
- `src/test-interpreter.js` - three scenarios against a real Postgres
  instance.

## Results

All three scenarios pass reliably (`npm test`, exit code 0, stable across
repeated runs):

### 1. Dependency ordering, proven from DB state, not just eventual outcome

Immediately after `submitRun` - **before any worker has run** - the final
step (`combineTotal`, which reads both the branch's and the map's outputs)
is already `blocked` in the database, while the branch and map nodes (which
have no external dependencies) start `queued`. This is checked directly
against the stored execution rows, not inferred from timing - the
interpreter's dependency analysis runs once, at submission time, purely by
walking the IR for `{from:"step", id}` references.

### 2. Branch-case exclusivity, both directions

Two scenarios (`amount=150` selects the `"true"` case; `amount=50` selects
`"default"`) both complete with the correct `grandTotal` (170 and 60
respectively, hand-computed and matched exactly). In each case, the
**unselected** case's step was checked to have never even been created as
an execution row for that run - not merely "didn't execute," but never
scheduled at all. This is a direct, structural consequence of the
fan-out-on-first-claim design (a branch only ever inserts the *chosen*
case's step), not a runtime check bolted on afterward.

### 3. Map join correctness under genuine concurrency

A 12-item map, processed by 6 concurrent workers, joins into a `lineTotal`
array in exact original source order every run - the same ordered-join
property spike 1.8 already validated, now reached generically (via
`resolveBinding`/`yields` walking the IR) rather than by a hand-written,
workflow-specific join.

### 4. Cross-node binding resolution feeding a downstream step

`combineTotal`'s `sumWithDiscount` function receives `lineTotals` (an
array, from the map's `yields`) and `discountedAmount` (a scalar, from the
branch's `yields`) as ordinary resolved bindings - the interpreter treats a
branch's or map's yielded output exactly the same way it treats a plain
step's output for downstream binding purposes, with one deliberate
exception (see below).

## A design decision this spike validated rather than assumed

**A branch/map node's internal case/body step outputs are structurally
unreachable from outside that node** - they are never written to
`run_node_outputs` (the table any `{from:"step", id}` binding resolves
against), only to `checkpoints` (keyed by `execution_id`, read back
directly by that node's own join logic). This wasn't a validation rule
bolted on top; it's a consequence of where the data physically lives. This
turns out to be exactly what design.md D8c already asks for ("rejection of
direct references to a case's/body's internal step ids") - the
implementation enforces it by construction, which is a stronger, cheaper
guarantee than a check that could in principle be bypassed.

## A real bug this spike caught (worth stating plainly)

The first implementation read a branch's `yields` from `row.node_def.yields`
- but per design.md D8c, `yields` is declared **per-case**, not once on the
branch node itself (different cases can produce different output shapes).
Running the test immediately surfaced this as a hard failure (`no output
named 'discountedAmount'`) rather than a silent wrong answer, because the
"unbound binding" path in `bindings.js` throws loudly instead of resolving
to `undefined`. Fixed by reading `chosenCase.yields` instead. This is
mentioned here deliberately: it demonstrates the value of actually running
this against real Postgres rather than reasoning about the interpreter on
paper - the bug was a plausible one to make from reading D8c's prose alone.

## What this does NOT settle (explicit scope limits, not oversights)

- **Branch cases and map bodies with more than one internal step are not
  supported.** Both are currently limited to exactly one step per
  case/body (checked and thrown loudly, not silently mishandled, if
  violated). A real implementation would need to apply this same
  dependency-promotion logic one level down, recursively, for multi-step
  case/body bodies - a real generalization, deliberately out of scope here
  to keep this spike to what 1.5 asks (prove the pattern), not a full
  DSL-compiler implementation.
- **`{from:"session"}` and `{from:"static"}` bindings are not implemented**
  (they throw a clear, explicit error rather than silently misbehaving) -
  the session layer (section 3) and the dataset catalog (task 5.6d) don't
  exist yet. Once they do, these are two more binding-resolution cases to
  add to `bindings.js`, not a change to the interpreter's core dependency/
  dispatch logic.
- **No real service dispatch.** `functions.js` is an in-process stand-in
  for what will eventually be a digest-pinned OCI service call through the
  registry (2.x) and an HTTP/SDK transport (6.3/6.4). The interpreter's one
  call site that would change is `callFunction` inside `runPlainStep`/
  `runMapChildStep`/`runBranchCaseStep` - everything else (dependency
  ordering, branch/map semantics, binding resolution) is unaffected by that
  swap.
- **5.11 (JSON-Logic vs. CEL) is not resolved** - `compute.js` is a
  deliberately tiny stand-in with exactly the operators this spike's
  selector needed, not a real expression-language choice.
- **Crash/lease-recovery was not re-tested here.** It's inherited from the
  same `claim_execution`/checkpoint primitive spikes 1.2 and 1.8 already
  crash-tested directly - re-testing it again against this spike's specific
  node shapes would be repeating, not adding, evidence, so it wasn't
  redone.
- **No scale/throughput measurement** - this spike used single-digit
  worker counts and a 12-item map; that's spike 1.2e's job, already done
  for the underlying primitive, not this spike's.

## Verdict

**The generic-interpreter approach holds on the Postgres-native engine.**
One dependency-analysis + claim-and-dispatch pattern - the same
`executions`/`checkpoints`/`claim_execution()` primitive already validated
by spikes 1.2, 1.8, and 1.2e - correctly executes an IR document containing
a branch, a map, and cross-node dependencies, with no workflow-specific
code in the interpreter itself. This is the concrete basis 5.10 (IR-to-
execution-engine compilation) and 6.2 (the generic execution-engine
interpreter) can build from, rather than designing the dependency/dispatch
pattern from scratch.

## How to reproduce

`npm test` is fully self-contained (starts/tears down its own Postgres
container via `../../scripts/with-postgres.sh`):

```bash
npm install
npm test
```
