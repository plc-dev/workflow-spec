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
| 0001 | Durable core: `core/` schema + `engine/` claim/complete primitives | draft | 6.1a (split from 6.1) |
</content>
</invoke>
