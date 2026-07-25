# ADR-0001: A single TypeScript package, plus a separate Go exec-agent

## Status

Proposed (revised - see "Revision note" below)

## Context

`openspec/changes/workflow-execution-platform/design.md` (D8) splits the
workflow DSL into an authoring surface and a stable intermediate
representation (IR), and D11 makes that IR a versioned, migrated document
consumed by the scheduler and the execution engine alike. The IR is a *type
contract* shared across every plane of the system (authoring, control-plane
storage, scheduling, execution) - that fact motivates a single language and
type system, independent of how the source tree is physically divided.

Three real components existed prior to this ADR series, each in plain
JavaScript: a JSON Schema for the DSL authoring surface (`archive/dsl/`), a
Postgres-backed service registry (`archive/registry/`), and a Postgres-backed
placement resolver (`archive/placement-resolver/`). A fourth component (an
execution engine) was described as already promoted into a TypeScript
`packages/` workspace by task 6.1 of that change's `tasks.md`, but the files
were never committed - only an empty `packages/*/node_modules` scaffold
existed.

**Revision note.** This ADR originally committed to an npm-workspaces
monorepo (multiple packages under `packages/`), on the assumption that
package boundaries were needed to enforce the dependency-direction rules
ADR-0007 draws. On inspection, that assumption doesn't hold: "boundary"
(which modules may import which) and "package" (a unit with its own
`package.json` and `exports` map) are two different mechanisms. The one
place a stronger, compiler-enforced boundary looked genuinely justified -
the service registry's `registerImage`/`recordTrustTier` privilege split
(D12) - was already described, in the original design itself (task 2.10),
as only "the structural boundary a future auth layer would enforce," not
the actual security boundary. Paying for workspace overhead (multiple
`package.json` files, `exports` maps to maintain, workspace linking) to
harden a boundary the design already calls provisional is not a good
trade, especially since nothing in this system is published externally.

## Decision

1. The repository is a **single Node/TypeScript package**: one
   `package.json`, one `tsconfig.json`, one `node_modules`, one lockfile.
   Source is organized into directories mirroring the module inventory in
   ADR-0007 (`src/ir/`, `src/core/`, `src/engine/`, `src/scheduler/`,
   `src/session/`, `src/dataset-catalog/`, `src/secrets/`, `src/nesting/`,
   `src/item-pool/`, `src/identity/`, `src/registry/`,
   `src/workflow-store/`, `src/dsl-compiler/`).
2. **Deployable processes are distinguished by entrypoint, not by package.**
   `worker`, `dispatch-api`, and `mcp-gateway` are `src/apps/<name>/main.ts`
   files, each bundled into its own Docker image, all drawing from the same
   dependency graph and type system.
3. **All TypeScript, with one deliberate, narrow exception.** ADR-0008's
   in-pod exec-agent lives in its own directory (`agent/`) as a separate Go
   module with its own toolchain - justified specifically by its role as
   PID 1 in every pooled pod (static-binary footprint matters when
   multiplied across the fleet), not a general polyglot policy. No other
   component gets this exception without an equally specific justification.
4. **The JSON Schema for the IR remains the canonical wire contract** (see
   ADR-0003). TypeScript types for the IR are derived from or validated
   against that schema, never maintained as an independent, parallel source
   of truth.
5. **The three real archived components are promoted by rewrite, not by
   copy** - their logic and, where real, their test coverage are the
   reference implementation, but the promoted code is written fresh as
   modules within this one package, against the boundaries in ADR-0002/
   ADR-0007. Verbatim porting is not a goal in itself.
6. **Module boundaries are enforced by convention, code review, and lint
   rules - not by `package.json` `exports` maps.** This is a conscious
   trade, not an oversight: the one boundary that might have justified
   compiler-level privacy (registry's privilege split) is left at the same
   level of enforcement the original design already accepted for it (see
   the Revision note above) - a future authorization layer is the real
   enforcement mechanism either way, and a package boundary would only
   have simulated one.

## Consequences

- One toolchain, one type system, spanning authoring -> storage -> scheduler
  -> engine - the actual mechanism that makes D8's "synthesize once, execute
  the plan" split pay off in practice rather than only on paper.
- No workspace-management overhead (no `exports` maps, no workspace
  linking, no cross-package version bumping) - a single `npm install`,
  a single build.
- The Go exec-agent is the only place a second toolchain/CI pipeline exists
  in this repository; everything else shares one.
- Real, non-trivial porting cost for the three archived JS components
  (each is small: on the order of a few hundred lines per component).
- The archived, never-landed `packages/engine` description from task 6.1 is
  superseded - there is no `packages/` directory at all in this design.

## Alternatives considered

- **npm-workspaces monorepo (the original form of this ADR).** Rejected on
  revision: nothing in this system is published externally, so semantic
  package versioning/`exports`-map privacy buys enforcement for exactly one
  boundary the design already treats as provisional, at the cost of real
  workspace-management overhead for every other package.
- **Keep the existing plain-JS spike layout and grow it in place.** Rejected:
  would leave the IR contract (the single most shared interface in the
  system, per D8/D11) informally typed at exactly the seam where type
  safety matters most.
- **Full polyglot (e.g. a different language per plane).** Rejected: no
  concrete requirement forces a second language anywhere except the
  exec-agent's PID-1-in-every-pod footprint concern (ADR-0008), which is
  specific enough to justify its own narrow exception rather than opening
  the door generally.
