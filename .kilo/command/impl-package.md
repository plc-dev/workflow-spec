---
description: Plan, test-design, and implement a work package for workflow-execution-platform
---

Drive one work package of `openspec/changes/workflow-execution-platform/`
through the four-phase process below. A work package is a tracer-bullet
vertical slice - sized around a buildable deliverable, not around
`tasks.md`'s numbering (which follows conceptual-discovery order, D1-D17,
not build order). Do not skip phases or silently merge them, except where
explicitly allowed below.

Argument: `$ARGUMENTS` - either a description of the package to work on,
or `next` to have you propose the next package given what's already
`[x]`/`[ ]` in `tasks.md` and what `docs/impl-plans/` already covers, or
empty to ask the user what they want to work on.

Ground truth, in priority order when they conflict: `docs/adr/*.md`
(how to build it) > `openspec/changes/workflow-execution-platform/design.md`
(what to build, D1-D17) > `openspec/changes/workflow-execution-platform/tasks.md`
(work breakdown, sequenced by discovery order - re-sequence as needed).
Read `docs/impl-plans/README.md` first for the document shape, and skim
existing `docs/impl-plans/NNNN-*.md` files to avoid re-planning covered
ground or contradicting an already-agreed plan.

## Phase 1 - PLAN (requires explicit agreement before Phase 2)

1. If the package boundary isn't already obvious from `$ARGUMENTS`,
   propose one now, as part of this same phase (package boundaries are a
   planning decision, not a separate step). Prefer the smallest slice that
   is independently buildable and testable given what's already landed -
   check `docs/adr/0007-package-and-app-inventory.md`'s dependency-direction
   diagram and `core/`'s consolidation role (ADR-0002) before proposing
   something that would require building on top of a module that doesn't
   exist yet.
2. Pull together, from the ADRs/design.md/tasks.md, everything that bears
   on this package: which modules/files it touches (per ADR-0007's
   inventory), which `tasks.md` line-item IDs it covers (list them
   explicitly - this becomes the package's Scope), which ADR decisions and
   design.md D-numbers it implements, and any open questions those sources
   leave unresolved that this package must nonetheless make a call on.
3. Synthesize a concrete plan: file/module layout, interfaces/function
   signatures, data flow, and - explicitly - the sequencing rationale (why
   this package now, what it depends on that must already exist, what it
   unblocks).
4. Allocate the next `NNNN` and write `docs/impl-plans/NNNN-<slug>.md`
   using the shape in `docs/impl-plans/README.md`, status `draft`. Add a
   row to that README's index table.
5. Present the plan and STOP. Do not write any implementation code yet.
   Wait for explicit agreement. Revise and re-present on request.
6. On agreement, set the doc's status to `plan-agreed`.

## Phase 2 - TEST DESIGN (requires explicit agreement before Phase 3)

1. Enumerate concrete test cases / acceptance criteria, each mapped to a
   specific Scope item and to the specific correctness property (an
   ADR guarantee or design.md D-number) it verifies - not generic
   "unit test the function" entries.
2. Evaluate whether the default setup (Vitest, per
   `docs/adr/0009-language-build-and-quality-tooling.md`; testcontainers-node
   for anything whose behavior depends on real Postgres semantics) is
   sufficient for this package, or whether this package's own correctness
   properties warrant something beyond it (e.g. a crash-kill-mid-transaction
   test, a concurrency/contention test, a load/scale check - mirroring what
   `archive/spikes/1.2*` already did for the durable core). Default to the
   standard setup; only propose more when the package's own stakes justify
   it, and say explicitly why.
3. Append this to the same `docs/impl-plans/NNNN-*.md` document under its
   test-design section.
4. Present it and STOP. Wait for explicit agreement.
   - **Small/low-risk packages may collapse this into Phase 1's approval**:
     if so, do both steps above during Phase 1, present plan + test design
     together, and get one combined agreement. State plainly that you are
     collapsing the gate and why the package qualifies (small, low-risk,
     not foundational/consolidation-critical).
5. On agreement, set the doc's status to `tests-agreed` (or keep
   `plan-agreed` if the gate was collapsed).

## Phase 3 - IMPLEMENT

0. Read `docs/impl-plans/implementation-best-practices.md` and follow every
   practice in it (env vars only via `src/config.ts`, no inlined raw SQL
   strings, no magic numbers/strings, structured errors via
   `src/errors.ts`, `.example.env` kept in sync) for any code this phase
   writes. That document is closed except by the repo owner's explicit
   instruction - do not add to it, remove from it, or reinterpret it on
   your own initiative, even if a new situation seems to call for it;
   flag the gap to the user instead.
1. Implement exactly what was agreed in Phase 1. If reality forces a
   deviation, stop and flag it rather than silently diverging - small
   deviations can be noted in the doc's implementation-notes section as you
   go; anything that changes the plan's shape should go back to the user.
2. Write and run the tests agreed in Phase 2.
3. Update `docs/impl-plans/NNNN-*.md`: implementation notes (what was
   actually built, deviations and why, any follow-up work spun off as new
   `tasks.md` items or new packages), and set status to `implemented`.
4. Flip every covered `tasks.md` checkbox to `[x]`, each with a short
   "Done: see ..." note in the existing `tasks.md` style, pointing at the
   real files/tests (not the plan doc alone).

## Phase 4 - REVIEW

Compare the actual implementation against the agreed plan and agreed
tests (not a fresh read of the code in a vacuum) - confirm every Scope
item is covered, every agreed test exists and passes, and every deviation
is recorded. Update the doc's review-notes section and status to
`reviewed`. Then use the `suggest` tool to offer a local code review pass,
as usual.
