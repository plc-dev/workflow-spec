# ADR-0009: Language, build, and code-quality tooling

## Status

Proposed

## Context

ADR-0001 committed to a single TypeScript package plus a narrow Go
exception (the ADR-0008 exec-agent), and ADR-0007 laid out the resulting
module inventory. Neither fixed the runtime version, module format, build
tooling, lint/format tool, test runner, the database access layer, or how
non-IR runtime shapes (env config, RPC payloads) get validated. This ADR
closes those gaps - the code-authoring and build-time half of the tooling
decision space; ADR-0010 covers the operational half (CI, dependency/secret
hygiene, local dev environment).

Throughout, the same posture already established by D6a (clean-room over
adopting a framework) and by this session's earlier decisions (no
Turborepo/Nx, no dependency-cruiser, no npm workspaces) is applied
consistently: prefer the smallest tool that actually solves the problem in
front of it, over a heavier one that solves problems this project doesn't
have yet.

## Decision

**Runtime & module format.** Latest active Node.js LTS, pinned via
`"engines"` in `package.json` and a `.nvmrc` (one pin, not two competing
mechanisms). ESM only (`"type": "module"`, `moduleResolution: "NodeNext"`) -
greenfield, no legacy CJS consumers to support.

**TypeScript configuration.** `strict: true`, plus `noUncheckedIndexedAccess`
and `noImplicitOverride`. `exactOptionalPropertyTypes` is deliberately
**not** enabled - real friction against the discriminated-union-heavy
`Binding` model (ADR-0004) for low payoff. Type-checking is a single
`tsc --noEmit` over the whole package - no project references, since those
exist to speed up *multi-package* incremental builds, which no longer
applies to a single package (ADR-0001's revision).

**Build (apps only).** esbuild bundles each `src/apps/*/main.ts` into one
JS file per deployable. Libraries under `src/` are never built as separate
artifacts - they only exist as source consumed directly within the one
package and bundled into whichever app imports them.

**Lint & format: Biome only.** One fast tool, one config, covering both
lint and format. No dependency-cruiser, no ESLint plugin ecosystem - the
module-boundary rules in ADR-0007 are enforced by code review and (where a
Biome rule genuinely fits, e.g. restricting cross-directory imports of
`registry/admin.ts`) a Biome lint rule, never by a second tool bought
specifically to encode architecture (see ADR-0001 decision 6 for why this
is an accepted trade, not a weaker one in the way that matters).

**Testing: Vitest + testcontainers-node.** Every component whose behavior
depends on real Postgres semantics (`SELECT ... FOR UPDATE SKIP LOCKED`,
`LISTEN`/`NOTIFY`, transaction isolation) is tested against a real,
ephemeral, testcontainers-managed Postgres instance - not mocked, matching
what the archived spikes already established as necessary (their own
findings are explicit that mocking this class of behavior would validate
nothing real). This formalizes and generalizes what
`archive/scripts/with-postgres.sh` hand-rolled per-suite, as a reusable
per-test-file pattern instead of a bespoke shell script.

**Database access: raw `pg`, hand-written SQL, no query builder or ORM.**
Consistent with D6a's clean-room choice for the durability core itself: an
ORM or even a query builder abstracts over exactly the control this system
depends on (explicit transaction boundaries, advisory-lock-shaped query
patterns, `LISTEN`/`NOTIFY`). Kysely was considered and rejected for the
same reason in weaker form - it still interposes a query-building layer
between the code and the SQL that matters most.

**Migrations: deferred, not tooled.** Each store (`core/`, `registry/`,
`workflow-store/`) has exactly one canonical, idempotent `schema.sql`,
applied fresh by both testcontainers (tests) and the local dev stack
(ADR-0010) - exactly what the archived spikes already proved sufficient.
A real migration tool (hand-rolled numbered files, or a small library) is
adopted only once a live deployed environment holds data that a schema
change would need to preserve - deciding the concrete tool now, before that
need is concrete, would be speculative.

**Non-IR runtime validation: zod.** `ir/` remains on JSON Schema/ajv
(ADR-0003 - that is the system's canonical wire contract and stays
schema-authored-first). Everything else that is TS-authored-first - env
config, the ADR-0008 `Invoke`/`Evict` RPC payloads - uses zod instead, for
ergonomics, not as a second, competing IR contract.

**Config loading: one `src/config.ts`.** A zod schema over `process.env`,
parsed once at each app's startup; fails closed (a startup crash, not a
silent default) on anything missing or invalid. No scattered
`process.env.X` reads elsewhere in the codebase.

**Observability instrumentation.** `pino` for structured, JSON logging,
with a shared `redact` configuration covering known secret-shaped fields
(directly serving D7/task 9.6, rather than retrofitting redaction later).
OpenTelemetry, auto-instrumenting `pg` and HTTP at each `apps/*` entrypoint,
with `executionId`/`stepId` (the same tuple ADR-0008 already establishes as
the durable idempotency key) carried as span attributes rather than a
second, invented correlation id. The exporter destination is deliberately
left undecided - there is nowhere to send traces yet, and picking one now
would be speculative in the same way a migration tool would be.

**Error taxonomy.** One shared `src/errors.ts`: a `PlatformError` base, with
`RetryableError` and `FatalError` subclasses. D6 R7 (native retries) and
D8d (no DSL-level retry surface - platform-managed) both require the engine
to mechanically distinguish these somewhere; one shared place avoids each
module inventing its own ad hoc convention for the same distinction.

## Consequences

- The build/test/lint toolchain is entirely consistent with ADR-0001's
  single-package decision - nothing here reintroduces multi-package
  tooling through the back door.
- Database code stays close to the metal (raw `pg`), consistent with D6a's
  already-accepted "own the durability core" posture, at the cost of more
  hand-written SQL and manually-maintained row types than a query
  builder/ORM would require.
- Two decisions are explicitly deferred rather than resolved (the migration
  tool, the OpenTelemetry exporter) - both have a named, concrete trigger
  condition for revisiting, not an open-ended "later."

## Alternatives considered

- **node-pg-migrate or a hand-rolled numbered-migrations runner, adopted
  now.** Rejected for now - no live environment yet has data worth
  preserving across a schema change; the archived spikes' single-
  `schema.sql` pattern is already sufficient for the current phase.
- **Kysely or an ORM (Prisma/Drizzle).** Rejected - both interpose a layer
  between code and the exact SQL semantics (`FOR UPDATE SKIP LOCKED`,
  `LISTEN`/`NOTIFY`, explicit transactions) this system's durability core
  depends on, working against D6a's clean-room rationale.
- **ESLint + Prettier, optionally with `eslint-plugin-boundaries` or
  dependency-cruiser.** Rejected - richer plugin ecosystem than Biome, but
  buys mechanical enforcement for a boundary (registry's privilege split)
  ADR-0001 already treats as provisional; not worth the second tool.
- **Jest or Node's built-in `node:test`.** Rejected in favor of Vitest for
  developer-experience reasons (watch mode, TS-native config) - `node:test`
  remains a reasonable minimal alternative if Vitest ever proves to be more
  tool than this project needs.
