# Implementation plans

This directory holds one persistent document per **work package** used to
implement `openspec/changes/workflow-execution-platform/`. A work package is
a tracer-bullet-style vertical slice - sized around a cohesive, buildable
deliverable (e.g. "durable core: `core/` schema + `engine/` claim/complete
primitives"), not around `tasks.md`'s numbering, which follows the
conceptual-design discovery order (D1-D17), not a buildable dependency
order.

These documents are **not ephemeral** - they stay in the repo as a durable
record of what was planned, how it was tested, and what actually happened,
suitable for feeding into a PR description by hand later.

Produced and driven by the `/impl-package` command (see
`.kilo/command/impl-package.md`).

**`implementation-best-practices.md`** in this directory is a binding set
of coding conventions every work package's Phase 3 (Implement) must follow
(env vars only via `src/shared/config.ts`, no inlined raw SQL, no magic
numbers/strings, structured errors via `src/shared/errors.ts`,
`.example.env` kept in sync). It is closed except by the repo owner's
explicit instruction - `/impl-package` must not extend it on its own.
Module-internal directory structure and naming conventions are governed by
`docs/adr/0012-module-internal-structure-and-naming.md` (a normal,
amendable ADR, referenced but not restated by the best-practices doc).

## Naming

`NNNN-<slug>.md`, numbered sequentially in creation order (mirrors
`docs/adr/`'s numbering convention). `NNNN` does not imply a dependency or
build order by itself - the package's own "Sequencing" section states that
explicitly.

## Document shape

Each plan document carries:

- **Status**: `draft` -> `plan-agreed` -> `tests-agreed` (skippable for
  small/low-risk packages, collapsed into `plan-agreed`) -> `implemented` ->
  `reviewed`.
- **Scope**: the exact `tasks.md` line-item IDs this package covers.
- **Sources**: the ADRs / `design.md` decisions this package implements.
- **Plan**: modules/files/interfaces, and the sequencing rationale (why
  this package now, what it depends on, what it unblocks).
- **Test design**: concrete test cases mapped to scope items and to the
  specific correctness properties (D-numbers/ADR guarantees) they verify,
  plus an explicit evaluation of whether the default Vitest +
  testcontainers-node setup (ADR-0009) is sufficient or whether this
  package's own properties (e.g. crash/concurrency semantics akin to the
  archived spikes) warrant something additional.
- **Implementation notes**: what was actually built, deviations from the
  plan (and why), follow-ups spun off as new `tasks.md` items or new
  packages.
- **Review notes**: filled in after a local review pass.

## Index

| # | Package | Status | Scope (tasks.md) |
|---|---|---|---|
| 0001 | Durable core: `core/` schema + `engine/` claim/complete primitives | reviewed | 6.1a (split from 6.1) |
| 0002 | Durable sleep: `waits` table, `signal_wait()`, LISTEN/NOTIFY `WakeListener` | reviewed | 6.1b |
| 0003 | Session log: `session_log`/`session_pointer` tables + `session/` module (append, rewind, replay) | reviewed | 3.1, 3.10 |
| 0004 | Workflow-spec schema: `workflow-spec/` module (types, JSON Schema, `validate()`) | reviewed | 5.1 |
| 0005 | Placement: `core/`'s placement schema + `scheduler/`'s decision logic | reviewed | 4.1a (new, split from 1.10/4.1-4.7) |
| 0006 | Execution interpreter: plain-step dependency-graph execution | reviewed | 6.2a (new, split from 6.2) |
| 0007 | Registry: `registry/`'s own metadata-index database | reviewed | 2.1, 2.1a, 2.1b, 2.1c, 2.2, 2.5, 2.8, 2.10 |
</content>
</invoke>
