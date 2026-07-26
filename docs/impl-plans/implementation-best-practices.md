# Implementation best practices

Binding coding conventions for every work package implemented under
`docs/impl-plans/`, driven by the `/impl-package` command
(`.kilo/command/impl-package.md`). Extracted from the local code review of
package 0001 (durable core) - not a fresh design decision, a codification
of what that review already required.

**This list is closed except by explicit instruction from the repo
owner.** `/impl-package` (and any agent acting under it) MUST follow every
practice below during Phase 3 (Implement) of every future work package,
but MUST NOT add, remove, reinterpret, or "improve" an entry on its own
initiative - only the repo owner extends this document, and only when they
explicitly say so.

## 1. No scattered `process.env` reads

All environment variables are read in exactly one place: `src/config.ts`,
via a `zod` schema (per ADR-0009). No other module reads `process.env`
directly.

- **Required** variables have no `.default(...)` in the schema - a
  missing or invalid value throws at parse time (fail closed), never
  silently falls back.
- **Optional** variables get an explicit default in the schema itself -
  "what happens if this isn't set" is answered in one place, not wherever
  the value happens to be consumed.
- The parsing function (e.g. `parseConfig(env)`) is exported separately
  from the module-level singleton (`config`) it produces, so tests can
  exercise fail-closed/default behavior against an arbitrary env object
  without module-reimport tricks.
- Every environment variable `config.ts` reads is documented in the
  repo-root `.example.env` (see §5) - the two are kept in sync by hand.

## 2. No inlined raw SQL strings in production code

Every SQL query issued by production code (anything under `src/`) is a
named constant, not a string literal inline at the call site.

- Constants are prefixed `SQL_` (e.g. `SQL_CLAIM_EXECUTION`) so every
  query in the codebase is greppable by that prefix alone.
- Constants live in a sibling `<name>.queries.ts` file next to the
  module/repository that issues them (e.g.
  `src/core/repositories/executions.queries.ts` next to
  `executions.ts`) - not a single catch-all queries file for the whole
  codebase.
- **Test code is exempt.** SQL used for test setup/fixtures/assertions
  (seeding rows, asserting row counts, etc.) may stay inline - that is
  idiomatic test code, not "the code" this practice is about.

## 3. No magic numbers/strings in production code

Any hardcoded value that has meaning beyond its immediate line (a
timeout, a default lease duration, a log-event name, a redact path, a
status string, etc.) is extracted into a named constant.

- Shared constants for a module live in that module's own `constants.ts`
  (e.g. `src/core/constants.ts`); constants used by only one file may live
  at the top of that file instead.
- If a value's canonical source of truth is unavoidably split across two
  runtimes (e.g. a lease-duration default that exists both as a
  PL/pgSQL function's SQL-level `DEFAULT` and as a TypeScript function's
  default parameter), extract the TypeScript-side constant anyway and
  leave an explicit comment cross-referencing the other side, noting they
  must be kept in sync by hand.

## 4. Structured error taxonomy, never bare `Error`

Production code throws subclasses of the shared `src/errors.ts` taxonomy
(`PlatformError`, `RetryableError`, `FatalError` - per ADR-0009), never a
bare `new Error("...")`.

- Every thrown error carries a stable, namespaced **`errorId`** (defined
  once in a central `ERROR_IDS` map, e.g.
  `core.executions.enqueue_no_row_returned`) - the id is the thing an
  external system keys its OWN user-facing copy off of.
- The error's `message` is only this codebase's own default/fallback
  (used in logs, dev output) - never assumed to be end-user-facing, and
  kept in a `DEFAULT_ERROR_MESSAGES` map keyed by `errorId`, not
  duplicated inline at each throw site.
- Structured context relevant to debugging (ids, keys - never a
  secret-shaped value) is passed via the error's `context` option, not
  interpolated into the message string.

## 5. `.example.env` documents every environment variable

The repo root `.example.env` lists every variable `src/config.ts`'s schema
reads, each with a one-line comment stating its purpose, whether it's
required or optional, and its default if optional. Updated in the same
change that adds/removes/changes a variable in `config.ts` - never allowed
to drift out of sync.
