# Architecture Decision Records

This directory records the **software design** decisions that translate the
conceptual design in `openspec/changes/workflow-execution-platform/design.md`
(decisions D1-D17) into an actual repository structure, module boundaries,
and internal contracts/interfaces.

These are software-architecture decisions, not product/conceptual ones - they
answer "how do we build this" given that D1-D17 already answered "what are we
building." Each ADR names which conceptual decision(s) it derives from.

## Index

| ADR | Title | Derives from |
|---|---|---|
| [0001](./0001-monorepo-and-typescript.md) | A single TypeScript package, plus a separate Go exec-agent (revised: no npm workspaces) | D8, D11 (execution plan as shared type contract) |
| [0002](./0002-core-owns-consolidated-schema.md) | `core/` owns the consolidated transactional schema | D6 (4-way consolidation) |
| [0003](./0003-execution-plan-is-the-system-spine.md) | The execution plan is the system spine (`workflow-spec/` today; `execution-plan/` splits out with the compiler) | D8, D8a-d, D11 |
| [0004](./0004-binding-resolution-contract.md) | Binding resolution: resolver-per-kind, handles not values | D1, D2, D6 (R3), D8, D10, D16 |
| [0005](./0005-step-dispatch-is-cli-nesting-stays-flexible.md) | Step dispatch is CLI-only; nested calls stay transport-flexible | D9b, D9c, D17 |
| [0006](./0006-control-plane-stores-are-separate.md) | Control-plane stores (registry, workflow-spec store) are separate from core | D12, D13 |
| [0007](./0007-package-and-app-inventory.md) | Module inventory and dependency direction (revised: modules, not packages) | all of the above |
| [0008](./0008-in-pod-exec-agent.md) | In-pod exec-agent realizes step dispatch | D4, D4a, D6 (R7), D7, D8d, D17; resolves ADR-0005's open questions |
| [0009](./0009-language-build-and-quality-tooling.md) | Language, build, and code-quality tooling | extends ADR-0001; D6a (clean-room ethos), D7/task 9.6 (redaction), D6 R7/D8d (error taxonomy) |
| [0010](./0010-ci-hygiene-and-local-dev-environment.md) | CI, repository hygiene, and local development environment | extends ADR-0009; D7 (secret scanning), ADR-0006 (dev-stack database split) |
| [0011](./0011-nested-dispatch-via-minted-callbacks.md) | Nested dispatch via minted, per-invocation callback references | D7, D9b, D9c, D12; extends ADR-0004/0008 |
| [0012](./0012-module-internal-structure-and-naming.md) | Module-internal structure, cross-cutting `shared/`, and naming conventions | extends ADR-0007/0009; no new D-number (implementation-hygiene, not conceptual design) |

**Note on naming across ADR-0002 through ADR-0006/0008:** these were
drafted before ADR-0001's revision and refer to `@wfx/core`, `@wfx/registry`,
etc. as if they were separate npm packages. Read these as **module/
directory names within the single package** (`core/`, `registry/`, ...) -
the ownership and boundary arguments in those ADRs are unaffected by the
packages-to-modules rename; only ADR-0001 and ADR-0007 needed substantive
revision.

## Status of prior art

Three real, tested components existed at the repository root prior to this
series: a JSON Schema for the DSL authoring surface, a Postgres-backed service
registry, and a Postgres-backed placement resolver (tasks 1.7, 2.x, 1.10 of
the `workflow-execution-platform` change). A fourth component, a promoted
TypeScript execution engine, was described as complete by task 6.1 of that
change's `tasks.md` but was never actually committed.

All four (the three real ones plus the never-landed engine) have been moved
to `archive/` as of this ADR series - preserved as a reference/inspiration
for the real implementation, not as a starting point to build on directly
(see ADR-0001 for why: language and schema-ownership boundaries changed).
