# 0008: shared/database/ and shared/trust-tier.ts consolidation

## Status

`reviewed`

## Scope

This package does not implement any `tasks.md` line item - it is a
cross-cutting refactor triggered by a local code-review pass on
`docs/impl-plans/0007-registry.md` (registry/), which found that `core/`
and `registry/` - the first two modules to each own a database
(ADR-0002/ADR-0006) - had already produced two independent copies of the
same Postgres connection/transaction plumbing, and that `registry/` and
`scheduler/` had independently defined the same trust-tier vocabulary.
Per the repo owner's direct instruction, this package:

1. Amends **ADR-0012** to add two new sanctioned `src/shared/` entries:
   `database/` (pool factory, generic transaction wrapper, `Queryable`
   type) and `trust-tier.ts` (the `TRUST_TIERS`/`TrustTier` vocabulary).
2. Consolidates every duplication flagged by that review pass (and one
   more found while executing this package - see "Additional finding"
   below) into those two entries.
3. **Fixes a real robustness gap** the consolidation surfaced:
   `registry/`'s first version of its transaction wrapper was missing the
   tolerant-rollback/`'error'`-listener handling `core/`'s version already
   had - registry writes were exposed to a bug `core/` had already fixed
   once, independently, in a copy nobody was keeping in sync.
4. Adds a new best practice (`implementation-best-practices.md` #6,
   repo-owner-authorized addition) requiring `/impl-package` to surface
   (not silently resolve, not silently ignore) deduplication potential the
   moment a second instance of a pattern appears, going forward.

Unlike every other `docs/impl-plans/NNNN-*.md` document, this one's
"Scope" is not a set of `tasks.md` IDs - there are none to check off.

## Sources

- **The local code-review pass** on 0007 (six parallel tracks: security,
  performance, business logic, deploy safety, duplication, dead code) -
  the duplication track's findings are this package's actual origin.
- **ADR-0012 §3** ("`shared/` is a CLOSED set, not a utility bucket") -
  governs whether/how a new `shared/` entry may be added; this package's
  first job is amending that ADR, not silently working around it.
- **ADR-0002** (core/'s consolidated schema, `withTransaction`/`CoreRepos`)
  and **ADR-0006** (registry/'s own, separate database) - the two existing
  transaction wrappers whose shared mechanism this package extracts.
- **ADR-0007**'s dependency-direction diagram (`scheduler/` depends on
  `registry/`, never the reverse) - the constraint that made "just import
  `scheduler/`'s `TRUST_TIERS` from `registry/`" (or vice versa) not an
  option, and that `shared/` (below both) resolves without inverting.
- **The repo owner's direct instruction and this session's clarifying
  Q&A** (five decisions, each with a stated default the repo owner
  confirmed or overrode): the `shared/database/` shape; keeping `core/`'s
  repositories on `PoolClient` rather than loosening them to `Queryable`;
  doing the FULL pre-existing-test-duplication sweep (not just the new
  registry files); tracking this as its own `docs/impl-plans/` doc; and
  hoisting `TRUST_TIERS` into `shared/` (overriding this doc's own default
  recommendation of "leave the two copies independent + add a drift
  test" - the repo owner chose full unification instead).

## Plan (as directed)

### File/module layout

```
src/shared/
  database/
    index.ts                  barrel
    connection-pool.ts         createPool(config?) -> Pool
    queryable.ts               Queryable interface ({ query })
    transactions.ts            withTransaction<Repos,T>(pool, buildRepos, fn)
  trust-tier.ts                TRUST_TIERS, TrustTier
  index.ts                     (extended) re-exports the above

src/core/
  database/
    connection-pool.ts         REMOVED - createPool now shared/database/'s
    transactions.ts            (rewritten) withTransaction(pool, fn) ->
                                CoreRepos, now a thin wrapper over
                                shared/database/'s generic withTransaction
  index.ts                     (extended) createPool re-exported from
                                shared/ instead of core/'s own file

src/registry/
  database/
    connection-pool.ts         REMOVED - createPool/Queryable now
                                shared/database/'s
    transactions.ts            (rewritten) withRegistryTransaction(pool, fn)
                                -> RegistryRepos, now a thin wrapper over
                                shared/database/'s generic withTransaction -
                                this is what closes the robustness gap
  constants.ts                 (rewritten) TRUST_TIERS/TrustTier
                                re-exported from shared/ instead of
                                defined locally; two new LOG_EVENT_*
                                constants added (see "Additional finding")
  admin.ts, conformance.ts     (extended) a logger.debug call added to
                                each (see "Additional finding")
  index.ts, get-entry.ts,
  get-placement-facts.ts,
  repositories/*.repository.ts (extended) import Queryable from shared/
                                instead of the now-removed
                                registry/database/connection-pool.ts;
                                FunctionCapabilityInput deduplicated (see
                                "Additional finding")

src/scheduler/trust.ts         (rewritten) TRUST_TIERS/TrustTier
                                re-exported from shared/ instead of
                                defined locally; isTrustEligibleForOptimization
                                unchanged

biome.json                     noRestrictedImports entries added for the
                                5 new shared/ files, mirroring the
                                existing pattern for config.js/errors.js/
                                observability/*.js

test/helpers/
  registry-postgres.ts          (new) startRegistryPostgres,
                                resetRegistryTables, seedRegisteredImage,
                                seedFixtureImage - collapses the 7
                                registry test files' repeated
                                __dirname/schema-path/TRUNCATE/seed
                                boilerplate
  reset.ts                      (new) resetExecutionTables,
                                resetExecutionAndWorkflowRunTables,
                                resetWorkflowRunTables, resetSessionTables,
                                resetPlacementTables,
                                resetPlacementAccessTable - collapses the
                                13 pre-existing core/engine/session/
                                scheduler test files' repeated TRUNCATE
                                strings

test/registry/**                (7 files updated to use registry-postgres.ts)
test/engine/*.test.ts,
test/core/**/*.test.ts,
test/session/*.test.ts,
test/scheduler/placement.test.ts (13 files updated to use reset.ts)
test/registry/database/
  transactions.test.ts          (new) the regression test for the
                                robustness fix - see "Fixed bug" below
test/scheduler/trust.test.ts    (updated) literal tier strings instead of
                                a TRUST_TIERS.PRODUCTION_PROVEN-style
                                dot-access constant (TRUST_TIERS is now an
                                array/tuple, not an object map)

docs/adr/0012-...md             amended (2 new shared/ entries, 2 new
                                Consequences bullets, core/'s example tree
                                updated)
docs/impl-plans/
  implementation-best-practices.md  new #6 (dedup-check), old #6
                                     ("Module structure and naming")
                                     renumbered to #7
```

### Fixed bug: registry/'s transaction wrapper was missing core/'s
robustness handling

`core/database/transactions.ts`'s `withTransaction` (0001) does two things
its rollback path needs that `registry/database/transactions.ts`'s first
version (0007) did not:

1. Attaches a swallowing `client.on("error", ...)` listener before
   `BEGIN`, removed in `finally` - without it, a forcibly terminated
   backend (a real dropped connection, or a crash test using
   `pg_terminate_backend`) emits an unhandled `'error'` event.
2. Wraps its own `ROLLBACK` in a nested `try/catch` - if the connection is
   already dead when `ROLLBACK` runs, that failure is expected and must
   not replace/mask the original error the caller needed to see.

`registry/`'s independent first copy had neither. This was undetected
because 0007's own test design never exercised a mid-transaction crash
(only a thrown-JS-error rollback, TC-10) - the gap was invisible to every
test that existed at the time. Both wrappers now delegate to
`shared/database/transactions.ts`'s single generic implementation, so the
fix (and any future one) lands in both places at once.
`test/registry/database/transactions.test.ts`'s third test is the actual
regression test - it fails against 0007's original registry-only
implementation and passes against this revision.

### Additional finding (found while executing this package, not by the
originating review)

While consolidating `Queryable`/`createPool` imports across `registry/`,
`FunctionCapabilityInput` (`Omit<FunctionCapability, "digest" |
"functionName">`) was found repeated as an inline type expression in five
places (`admin.ts`, `get-entry.ts`, `domain/registry-entry.ts`,
`domain/placement-facts.ts`, `test/registry/fixtures.ts`) even though
`repositories/function-capabilities.repository.ts` already had a named
alias for exactly this shape. Per the new best-practice #6 this package
itself adds, this should properly have been surfaced back to the repo
owner as its own decision point rather than folded in silently - it is
recorded here as a deviation from that practice's own procedure (a
retroactive gap, not a violation committed after #6 existed) precisely
because #6 did not exist yet when this was found. Resolution taken:
moved the canonical alias into `domain/function-capability.ts` (the
correct home - `repositories/` should depend on `domain/`, not the
reverse, which the alias previously lived backwards from) and reused it
at all five sites plus the barrel.

A second incidental finding, addressed per the repo owner's explicit
"add registry logging" decision (not itself a duplication, listed here
only because it landed in the same package): `registry/` was the only
logic-bearing module with zero `logger` calls. `LOG_EVENT_REGISTER_IMAGE`/
`LOG_EVENT_RECORD_TRUST_TIER` were added to `registry/constants.ts`,
matching the existing `LOG_EVENT_*` convention in `scheduler/constants.ts`/
`session/`/`engine/`, with a `logger.debug` call added to `registerImage`/
`recordTrustTier` respectively.

### Sequencing rationale

- **Why now**: the duplication was found by 0007's own review, immediately
  after 0007 landed - fixing it before a THIRD copy exists (`workflow-
  store/`, per ADR-0007's inventory) is cheaper than after.
- **What it depends on**: 0001 (`core/`'s original transaction wrapper,
  the source of the robustness fix now shared) and 0007 (`registry/`'s
  first copy, the site of the gap).
- **What it unblocks**: any future own-database module (`workflow-
  store/`) building on `shared/database/` from day one instead of writing
  a third independent copy; best-practice #6 governs every future
  package's own duplication scan from here on.

## Test design

**Gate collapsed - executed under direct repo-owner instruction**, not
through the normal Phase 1/2 propose-and-wait cycle: the repo owner's
message already specified the consolidation to perform and answered this
session's clarifying questions before any code was written, which is
functionally equivalent to an already-agreed plan and test design. This
section records what was actually verified, in the same shape Phase 2
would have used had it been run as a separate gate.

| # | Test | Verifies |
|---|---|---|
| TC-1 | `test/registry/database/transactions.test.ts` - commits both repos' writes together on success | `withRegistryTransaction` unchanged behavior after delegating to `shared/database/`'s generic version |
| TC-2 | same file - rolls back both repos' writes together when `fn` throws | same |
| TC-3 | same file - rolls back cleanly on a `pg_terminate_backend` mid-transaction crash, without masking the original error or leaking an unhandled `'error'` event | **the actual regression test for the fixed bug** - fails against 0007's original implementation |
| TC-4 | `test/scheduler/trust.test.ts` (updated) | `isTrustEligibleForOptimization`'s behavior is unchanged after `TRUST_TIERS`/`TrustTier` moved to `shared/trust-tier.ts` |
| TC-5 | `test/registry/database/schema.test.ts`'s two pre-existing drift-guard tests (from 0007's own review) | still pass unchanged - `registry/constants.ts`'s re-exported `TRUST_TIERS`/`MATERIALIZATION_COST_CLASSES` still round-trip against the real schema |
| TC-6 | full `test/registry/**` suite (33 tests, 10 files after this package's additions) | every registry behavior is unchanged after the `Queryable`/`FunctionCapabilityInput`/logging/test-helper changes |
| TC-7 | full `test/core/**`, `test/engine/**`, `test/session/**`, `test/scheduler/**` suites | every pre-existing behavior is unchanged after the 13-file `test/helpers/reset.ts` extraction (each helper mirrors its call sites' exact prior TRUNCATE string - an extraction, not a widening) |
| TC-8 | `npx tsc --noEmit` | no type regressions across the whole refactor |
| TC-9 | `npx biome check .` | no lint/import-restriction regressions; new `noRestrictedImports` entries actually enforced (checked by inspection - nothing outside `shared/database/`'s own files deep-imports them) |

No crash/concurrency/scale testing beyond TC-3 was judged necessary -
TC-3 already is that kind of test (a real crashed-connection scenario,
matching `core/`'s own precedent), and the rest of this package is a pure
mechanical extraction of already-tested behavior.

## Implementation notes

Built as planned; two things came up during implementation, both recorded
above (out of process order, since best-practice #6 - the very thing this
package adds - didn't exist yet when the first one was found):

- `FunctionCapabilityInput`'s canonical home moved from
  `repositories/function-capabilities.repository.ts` to
  `domain/function-capability.ts` during implementation (not the original
  plan's literal words, which didn't specify a home) - the repository file
  importing FROM `domain/` and domain types never importing FROM
  `repositories/` is the correct intra-module dependency direction per
  ADR-0012, and the alternative (leaving it in `repositories/` and having
  `domain/registry-entry.ts` import from a sibling `repositories/` file)
  would have inverted that direction.
- `RegistryRepos.client` was removed by 0007's own review as dead code,
  then reintroduced by this package once TC-3's crash test needed the
  same escape hatch `core/`'s `CoreRepos.client` already provides, for the
  identical reason (fetching the in-transaction connection's own backend
  pid to kill it and prove the rollback path). This is not a reversal of
  0007's review finding - at the time, nothing used it; now something
  legitimately does.
- `npx tsc --noEmit`, `npx biome check .`, and `npx vitest run` all pass
  clean: **206/206 tests across 36 files** (up from 203/35 before this
  package - the 3 new tests are `test/registry/database/
  transactions.test.ts`'s three cases). One round of `biome check --write
  .` (3 files, then 1 more after adding the crash test - import-order/
  line-wrapping only) was run to fix purely mechanical findings; no logic
  changed by it.
- `docs/impl-plans/0005-placement.md` and `docs/impl-plans/0007-
  registry.md` both describe `TRUST_TIERS`/`FunctionCapabilityInput`
  shapes that this package changed - both are left as historical records
  (per this repo's convention of never rewriting a prior package's own
  account of what it built), with this paragraph as the pointer forward;
  no line inside either document was edited.

## Review notes

Compared against the plan as directed (there is no separate prior
"agreed" version of this doc to diff against, since Phase 1/2's gates were
collapsed under direct instruction - reviewed against the five clarifying
decisions and the originating review's findings instead):

- All 5 clarifying-question decisions were followed exactly: the
  `shared/database/` shape as specified; `core/`'s repositories left on
  `PoolClient`; the full 13-file pre-existing sweep was done; this doc was
  created; `TRUST_TIERS` was fully hoisted into `shared/` (the repo
  owner's override of this doc's own initial recommendation).
- Every duplication finding from the originating review is resolved:
  `withTransaction`/`createPool`/`Queryable` (with the robustness gap
  actually fixed, not just extracted with the gap intact - verified by
  TC-3 actually failing against 0007's original code before this package,
  and passing after), `FunctionCapabilityInput`, the 7-file registry test
  bootstrap, and the 13-file core/engine/session/scheduler test bootstrap.
- New best-practice #6 is in place in `implementation-best-practices.md`,
  worded to require surfacing (not silently deciding) future duplication
  findings - this package's own "Additional finding" section is an
  explicit acknowledgment that this exact package predates that rule and
  so didn't follow it for its own incidental finding.
- Final verification immediately before writing this section:
  `npx tsc --noEmit` clean, `npx biome check .` clean, `npx vitest run`
  206/206 passing across 36 files.

No further follow-up work identified. `workflow-store/` (the next
own-database module per ADR-0007) is the natural first real test of
whether `shared/database/`'s extraction was actually reusable, not
theoretically so - left as a future package's own concern, not this one's.
