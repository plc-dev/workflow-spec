# 0012: Secrets - `secrets/` module (broker-agnostic interface + OpenBao adapter) + real worker-side resolution/injection

## Status

`plan-agreed`

## Scope

This package builds the first real secrets path end to end: a
broker-agnostic `secrets/` module (ADR-0007), an OpenBao adapter (task
1.6's decided product), and wires actual resolution into `apps/worker`'s
existing dispatch call so `InvokeRequest.secrets` - a field the exec-agent
has supported and delivered correctly since task 6.14/0010, but which
`apps/worker` (0011) has only ever sent as an empty array - carries real,
resolved values.

**In scope:**

- **9.1** (secret scope model + reference syntax in the DSL) - **already
  built, not by this package.** `src/workflow-spec/domain/secret-ref.ts`'s
  `SecretRef { scope: "writer" | "user"; name: string }`, `Step.secrets:
  Record<string, SecretRef>` (`node.ts`), and the JSON Schema's
  `$defs/secretRef` (`workflow-spec.schema.json`) already implement this
  exactly, landed as part of task 5.1 (`docs/impl-plans/0004-workflow-
  spec-schema.md`) - confirmed by inspection, not re-derived here. This
  package closes 9.1's checkbox with a pointer to that pre-existing work;
  it adds no new DSL surface.
- **9.2** Broker-agnostic secrets store interface + an OpenBao adapter -
  new `src/secrets/` module.
- **9.3** Worker-side, in-step-execution secret resolution - wired into
  `apps/worker/dispatch.ts`, resolving immediately before the exec-agent's
  `Invoke` call, inside the same function that already builds the rest of
  the request.
- **9.4** Per-request injection via the exec-agent's `Invoke` RPC payload -
  the agent-side mechanism (`buildEnv`, `agent/internal/execrunner/
  execrunner.go`) already exists and is already tested (0010); this
  package is the first real *caller* that populates `InvokeRequest.secrets`
  with resolved values instead of leaving it empty.
- **9.6, log-redaction half only** - ensure no code path added by this
  package ever logs a resolved secret value (extends the existing
  `stderrExcerpt`-style care already established in 0011's worker-loop).
  The payload-at-rest-encryption half of 9.6 stays deferred (see below).

**Explicitly NOT in scope (left `[ ]`, with a reason):**

- **9.5** (bind user-secret lifetime to session TTL, re-resolve on replay).
  `session_pointer` (`core/`, task 3.1) has no TTL column and no expiry
  mechanism at all yet - there is nothing in this repo today that
  represents "a session's TTL" for a lease to be bound to. This package's
  `resolve()` reads a plain OpenBao KV v2 path for the `user` scope
  exactly as it does for `writer` scope (see "Open questions"); the
  lease/TTL-minting half of D7 rule 5 that 9.5 actually describes is a
  separate, later addition once session TTL exists as a real platform
  concept.
- **9.6, payload-at-rest-encryption half.** D7's own text makes this
  conditional ("if the selected engine offers a codec hook") - `core/`'s
  engine is raw Postgres via `pg` (ADR-0009/D6a), which offers no
  serialization codec hook to attach encryption to. Nothing to build
  against; not a gap this package can close.
- **9.7** (exclude secret-consuming calls from the memoization cache) -
  depends on 3.8's memoization cache, which does not exist (session
  materialization, 3.2-3.9, is not built). Vacuously satisfied today (there
  is no memoization cache for a secret-consuming call to accidentally
  enter), not actually implemented.
- **9.8** (E2E: a pooled container serving different workflows never
  observes a foreign secret) - `apps/worker` has no pooling/sharing
  mechanism at all (0011's dispatch is spawn-per-call against one static
  endpoint; see the placement-wiring finding recorded against tasks
  4.1/4.3/4.4/4.6/4.7 in this same planning pass). There is no "pooled
  container" for this test to exercise. This package's own Test design
  does include a narrower, already-meaningful regression check - two
  sequential real invocations with two different secrets never cross-
  contaminate (see Test design TC-9) - but that is a check on this
  package's own per-invocation isolation, not 9.8's stated pooled-sharing
  scenario, and does not check that box.

## Sources

- **design.md D7** (full text read for this plan): the scope taxonomy
  (writer/user), the five numbered rules this package must satisfy -
  referenced-never-inlined (rule 1, already true per 9.1's existing DSL
  shape), per-request injection never env-var-for-the-container's-
  lifetime (rule 2, already true per the agent's existing `buildEnv`),
  push-by-value acceptable given trusted/non-caching services (rule 3,
  what this package's `resolve()`-then-inject shape implements), resolve
  inside the step's execution with only a reference ever in durable
  history (rule 4 - see "How rule 4 is already satisfied" below), and
  user-secret lifetime rides the session (rule 5 - explicitly deferred to
  9.5, above). Also the OpenBao decision itself and its "practical
  mapping onto D7's model" paragraph (writer-scoped -> writer-scoped KV
  path; user-scoped -> session-scoped KV path) - this package implements
  exactly that mapping for the read side.
- **`archive/spikes/1.6-secrets-broker-eval/FINDINGS.md`** (task 1.6): the
  actual product decision (OpenBao) and its rationale (D7 rule 5's
  session-TTL-bound revocation being native/free in OpenBao vs.
  Enterprise-gated in Infisical) - not re-litigated here, taken as
  ground truth.
- **ADR-0008** (`docs/adr/0008-in-pod-exec-agent.md`), "Secrets: resolved
  by relocating 'the request', not by a new rule": confirms the `Invoke`
  RPC payload *is* D7 rule 3's "the request" now that dispatch is
  CLI-only, and that the agent (not the worker) decides OS-level delivery
  (a subprocess-scoped env var, per the actually-implemented
  `execrunner.go`) - this package's job stops at handing the agent a
  correctly-resolved `secrets` array; it does not change agent-side
  delivery.
- **ADR-0007**: names `secrets/` as "broker-agnostic interface + an
  OpenBao adapter (task 1.6); implements the agent-RPC-relayed
  secret-delivery path from ADR-0008" - the exact shape this package
  builds - and fixes its place in the dependency direction (a domain-logic
  module, no schema of its own, called by `apps/worker`).
- **ADR-0012 / `implementation-best-practices.md`**: module-internal shape
  (`secrets/` gets `domain/` + top-level logic files, no `database/` -
  it owns no schema); rule 1's "env vars only via `src/shared/config.ts`"
  and the already-accepted apps-local-config exception 0011 established
  for exactly the same fail-closed-blast-radius reason (see "Open
  questions" below for how this package applies that same reasoning
  to itself); rule 4's structured-error taxonomy.
- **`docs/impl-plans/0010-exec-agent.md` / `0011-worker-cli-dispatch.md`**:
  the already-`reviewed` agent-side mechanism (`api.Secret`, `buildEnv`)
  and worker-side call site (`dispatch.ts`'s `buildInvokeRequest`,
  currently hardcoded to omit `secrets`) this package extends.

**How D7 rule 4 ("only a reference ever appears in recorded
arguments/history") is already structurally satisfied, not something this
package has to newly enforce:** `workflow_runs.spec` (the stored
`WorkflowSpec`/`ExecutionPlan`) only ever contains `Step.secrets:
Record<string, SecretRef>` - a `{scope, name}` reference, never a value
(`SecretRef` has no value field at all, by construction, same pattern as
every other "reference, not value" binding kind in this codebase). This
package's `resolve()` call happens entirely inside `dispatch.ts`, and its
resolved value is only ever placed on the one `InvokeRequest` sent to the
agent for that one call - never written back into `core/`'s durable
tables. No new enforcement code is needed for rule 4; this section
documents why, so it isn't silently assumed.

## Open questions these sources leave unresolved, resolved here as a call this package makes

- **Where does env-var-name-for-injection come from, vs. the broker's own
  secret name?** `Step.secrets` is `Record<string, SecretRef>` - the
  *value* (`SecretRef`) names the secret in the broker; the *key* is left
  unspecified by D7/D8c for what it means operationally. Resolved,
  mirroring `Step.reads`' existing key-is-the-CLI-flag-name convention
  exactly: **the record key is the env var name the invoked subprocess
  will see** (`agent/internal/api/types.go`'s `Secret.Name` is used
  verbatim as `NAME=value` in `buildEnv` - nothing sanitizes it
  agent-side). This package validates each key against a
  conventional env-var-name pattern (`^[A-Z][A-Z0-9_]*$`) before ever
  calling the broker, failing closed with a new `FatalError` rather than
  letting an unsafe/malformed name reach the agent - the same "fail on
  our own side with a clear error" posture `dispatch.ts` already applies
  to `args`' flag names.
- **Where does `writerId` come from for a given run, to resolve a
  `writer`-scoped reference against?** `core/`'s `workflow_runs` table
  carries `session_id` (used for `user`-scope) but has no `writer_id`
  column, and no `identity/` module (D14) or `workflow-store/` (D13)
  exists yet to source one from. Resolved: a **small, justified `core/`
  addition**, exactly mirroring `session_id`'s existing shape -
  `workflow_runs.writer_id TEXT` (nullable, no FK, no platform-side
  validation, consistent with D14's "opaque `writerId`, never issued by
  the platform"), `WorkflowRunsRepo.create`'s input gains an optional
  `writerId`, and `engine.submitRun`'s `opts` gains an optional
  `writerId` - the exact same three-point mirror `session_id` already has
  in `schema.sql`/`workflow-runs.repository.ts`/`interpreter.ts`. This is
  the same category of addition 0011 already made once (`ExecutionsRepo.
  markFailed`) for the same reason: a real caller needs a durable place
  to put a value nothing upstream currently provides, and there genuinely
  is nowhere else for it to live yet.
- **Does `secrets/` read its own env vars, given rule 1's "one place,
  `shared/config.ts`" wording?** Resolved by extending, not
  re-litigating, 0011's own precedent: `shared/config.ts`'s singleton is
  parsed eagerly at import time and transitively imported by nearly every
  module (via `shared/observability/logger.ts`) - making
  `SECRETS_BROKER_URL`/`SECRETS_BROKER_TOKEN` required there would fail
  closed for every test/module that imports `core/`/`engine/`/etc.
  without ever resolving a secret, exactly the blast-radius problem 0011
  already hit for `DATABASE_URL`/`AGENT_INVOKE_BASE_URL`. Resolved the
  same way: **`secrets/` itself reads no env vars at all** (its
  `createOpenBaoSecretsStore(config)` takes an explicit config object,
  mirroring `scheduler/`'s "takes `CoreRepos`, opens nothing itself"
  posture) - `SECRETS_BROKER_URL`/`SECRETS_BROKER_TOKEN` are parsed in
  `src/apps/worker/config.ts` (the one real caller today), both
  **optional** (unlike `AGENT_INVOKE_BASE_URL`): a workflow whose steps
  declare no secrets at all must not be forced to stand up OpenBao. If a
  step *does* declare a secret and no store is configured, that is a
  real, fail-closed error at dispatch time (see Plan).
- **Does this package implement secret *writing*/provisioning?** No - D7
  and the FINDINGS.md verdict both describe secrets as provisioned into
  the broker ahead of time (by whatever authors writer-scoped secrets, or
  by the platform when a user-scoped secret is first collected - neither
  mechanism is designed yet, and isn't this package's job). This package
  is read-only: `SecretsStore.resolve(...)`. Provisioning is left for a
  future package once there is a real caller that needs to write (e.g.
  a user-secret-collection flow).

## Plan

### File/module layout

```
src/secrets/
  index.ts                        (new) barrel
  constants.ts                    (new) SECRETS_KV_MOUNT default ("secret"),
                                   ENV_VAR_NAME_PATTERN, OPENBAO_DATA_PATH_PREFIX,
                                   DEFAULT_FETCH_TIMEOUT_MS, log event names
  domain/
    secret-path.ts                (new) buildSecretPath(ref, context) -> string (pure)
  secrets-store.ts                (new) SecretsStore interface, SecretResolutionContext
  openbao-secrets-store.ts        (new) createOpenBaoSecretsStore(config) -> SecretsStore

src/core/
  database/schema.sql             (extended) workflow_runs.writer_id TEXT (nullable)
  domain/workflow-run.ts          (extended) WorkflowRun.writerId
  repositories/workflow-runs.repository.ts   (extended) create() accepts writerId
  repositories/queries/workflow-runs.queries.ts (extended) SQL_CREATE_WORKFLOW_RUN

src/engine/
  interpreter.ts                  (extended) submitRun(...opts) accepts writerId,
                                   passed straight through to repos.workflowRuns.create

src/apps/worker/
  config.ts                       (extended) SECRETS_BROKER_URL/SECRETS_BROKER_TOKEN
                                   (both optional), SECRETS_BROKER_MOUNT (optional)
  constants.ts                    (extended) SECRET_ENV_VAR_NAME_PATTERN,
                                   new WORKER_* error ids' string values live in
                                   shared/errors.ts as usual, not here
  main.ts                         (extended) constructs a SecretsStore (or undefined)
                                   from config, threads it into WorkerDeps
  dispatch.ts                     (extended) dispatchStep/buildInvokeRequest resolve
                                   step.secrets via the injected SecretsStore
  worker-loop.ts                  (extended) WorkerDeps gains secretsStore?,
                                   passes run.writerId/run.sessionId as the
                                   resolution context

test/
  secrets/openbao-secrets-store.test.ts   (new)
  secrets/secret-path.test.ts              (new)
  core/database/schema.test.ts             (extended) writer_id column assertion
  core/repositories/workflow-runs.repository.test.ts (extended) writerId round-trip
  engine/interpreter.test.ts               (extended) submitRun writerId passthrough
  apps/worker/dispatch.test.ts             (extended) secret resolution/validation
  apps/worker/worker-loop.integration.test.ts (extended) T12+ - see Test design
  apps/worker/support/secret-echo-cli.sh   (new) test-only fixture, NOT under
                                            agent/testdata/ (that belongs to the
                                            already-reviewed 0010 package; 0011
                                            already established the norm of adding
                                            new test support under
                                            test/apps/worker/support/ rather than
                                            touching that fixture)
```

No `database/` under `src/secrets/` - it owns no schema (ADR-0007: a
domain-logic module, not a database-owning one). No `repositories/` either
- there is nothing here that is a thin CRUD wrapper over a table; the
whole module is the OpenBao HTTP client and the pure path-building logic.

### Interfaces (signatures)

```ts
// src/secrets/secrets-store.ts
import type { SecretRef } from "../workflow-spec/index.js";

export interface SecretResolutionContext {
  writerId?: string | null;
  sessionId?: string | null;
}

export interface SecretsStore {
  /** Resolves one secret reference to its plain value. Throws FatalError
   * SECRETS_MISSING_WRITER_ID / SECRETS_MISSING_SESSION_ID if the ref's
   * scope needs a context field the caller didn't supply; FatalError
   * SECRETS_NOT_FOUND if the broker has no entry at the resolved path;
   * RetryableError SECRETS_BROKER_UNREACHABLE on a transport-level
   * failure. Never returns a value for a scope/context combination that
   * doesn't structurally make sense (see secret-path.ts). */
  resolve(ref: SecretRef, context: SecretResolutionContext): Promise<string>;
}

// src/secrets/domain/secret-path.ts
export function buildSecretPath(ref: SecretRef, context: SecretResolutionContext): string;
// "writer/<writerId>/<name>" | "session/<sessionId>/<name>" - pure, no I/O.

// src/secrets/openbao-secrets-store.ts
export interface OpenBaoSecretsStoreConfig {
  baseUrl: string;
  token: string;
  mount?: string;           // default SECRETS_KV_MOUNT ("secret")
  fetchTimeoutMs?: number;  // default DEFAULT_FETCH_TIMEOUT_MS
}
export function createOpenBaoSecretsStore(config: OpenBaoSecretsStoreConfig): SecretsStore;
```

```ts
// src/apps/worker/dispatch.ts - extended
export interface BuildInvokeRequestParams {
  executionId: number;
  step: Step;
  resolvedInput: Record<string, unknown>;
  timeoutMs: number;
}

export async function dispatchStep(
  agentBaseUrl: string,
  params: BuildInvokeRequestParams,
  opts: {
    authToken?: string;
    secretsStore?: SecretsStore;
    secretsContext?: SecretResolutionContext;
  } = {},
): Promise<{ ok: true; output: Record<string, unknown> } | { ok: false; response: InvokeResponse }>;
// buildInvokeRequest itself becomes async (resolving secrets is I/O);
// resolves every entry of params.step.secrets via opts.secretsStore,
// validates each record key against SECRET_ENV_VAR_NAME_PATTERN first,
// and throws FatalError WORKER_SECRETS_STORE_NOT_CONFIGURED before any
// resolution attempt if step.secrets is non-empty but opts.secretsStore
// is undefined.
```

### Data flow

```
apps/worker/main.ts:
  config = parseWorkerConfig(process.env)
  secretsStore = config.secretsBrokerUrl && config.secretsBrokerToken
    ? createOpenBaoSecretsStore({ baseUrl: config.secretsBrokerUrl, token: config.secretsBrokerToken, mount: config.secretsBrokerMount })
    : undefined
  -> WorkerDeps.secretsStore

worker-loop.ts runOnce():
  run = repos.workflowRuns.findById(execution.runId)
  ...
  dispatchStep(agentBaseUrl, { executionId, step: node, resolvedInput, timeoutMs }, {
    authToken,
    secretsStore: deps.secretsStore,
    secretsContext: { writerId: run.writerId, sessionId: run.sessionId },
  })

dispatch.ts dispatchStep():
  if step.secrets present and !secretsStore: throw FatalError (terminal, fails the run - same
    posture as an unsupported binding kind)
  for each [envVarName, ref] in step.secrets:
    assertValidSecretEnvVarName(envVarName)          // fail closed, our own side
    value = await secretsStore.resolve(ref, secretsContext)
    secrets.push({ name: envVarName, value })
  -> InvokeRequest.secrets, sent to the agent's real /invoke - agent's
     existing buildEnv() delivers each as a subprocess-scoped env var,
     unmodified by this package.
```

### Sequencing rationale

- **Why now:** every module this package touches is already `reviewed`
  and stable (`workflow-spec/`'s `SecretRef` since 0004, the exec-agent's
  `Secrets`/`buildEnv` since 0010, `apps/worker`'s dispatch/worker-loop
  since 0011) - the only genuinely new piece is the broker client itself
  and threading a resolved value through an already-existing, currently-
  hardcoded-empty field. Task 1.6's product decision (OpenBao) has been
  sitting unimplemented since before `apps/worker` existed;
  `docker-compose.dev.yml`'s own header comment already names `openbao`
  as a service "with no consumer yet... add when the packages that
  actually need them land" - this is that package.
- **What it depends on that must already exist:** `workflow-spec/`'s
  `SecretRef`/`Step.secrets` (0004), the exec-agent's `Secrets` wire field
  and `buildEnv` delivery (0010), `apps/worker`'s `dispatch.ts`/
  `worker-loop.ts`/`config.ts` shape to extend (0011) - all `reviewed`.
- **What it unblocks:** a real user-secret-collection/provisioning flow
  and 9.5's TTL-binding (once session TTL is a real concept); 9.8's
  pooled-isolation e2e test (once 7.x's pooling exists - this package's
  narrower TC-9 is the closest available proxy today); the `identity/`
  module (D14), once built, gains a real `writerId` column to populate
  instead of leaving it `NULL` for every run submitted today.
- **What it deliberately does NOT unblock yet:** 9.5 (session-TTL-bound
  lease/revocation - needs session TTL, not built), 9.7 (memoization
  exclusion - needs 3.8, not built), full 9.8 (needs 7.x pooling, not
  built) - all explicitly named in Scope above, not silently assumed.

## Test design

Not collapsed with Phase 1 (as flagged there): this package makes a real
correctness-bearing addition to `core/`'s already-`reviewed` schema
(`workflow_runs.writer_id`) and introduces a new external dependency (a
real OpenBao instance) whose wire behavior must be verified against the
real product, not a mock - the same class of justification 0001/0003/
0005/0011 each already gave for keeping this gate separate.

### Is the default setup (Vitest + testcontainers-node for Postgres) sufficient?

**Not on its own - two additions are warranted, for specific reasons,
mirroring exactly how 0011 justified its own one addition:**

1. **A real OpenBao container.** This package's defining correctness
   property is "our TS client speaks OpenBao's real KV v2 wire protocol
   correctly" - a hand-mocked `fetch()` response would only prove our own
   code parses whatever shape we hand-wrote, not that we match OpenBao's
   actual response envelope (`{data: {data: {...}, metadata: {...}}}`,
   its actual 404/403 status-code behavior, its actual `X-Vault-Token`
   header handling). `testcontainers`' `GenericContainer` (already a
   transitive dependency via `@testcontainers/postgresql`) starts
   `openbao/openbao` in `-dev` mode (fixed root token, auto-unsealed,
   KV v2 auto-mounted at `secret/`) - a new, justified, narrowly-scoped
   addition (one more container image, not a new test framework).
2. **Reuse (not a new addition) of 0011's real-agent-process helper**
   (`test/apps/worker/support/agent-process.ts`) - already proven capable
   of spawning the real Go agent binary against an arbitrary fixture
   script; this package adds one new fixture script
   (`test/apps/worker/support/secret-echo-cli.sh`) rather than a new
   harness.

**No new concurrency, crash, or load test is warranted.** This package
introduces no new concurrent-write path in `core/` (the `writer_id`
column is written once, at `create()`, exactly like `session_id` already
is - no new update path, no new contention). OpenBao's own internal
consistency is out of scope to re-verify (it is a mature product, not
code this package is writing). The one isolation property genuinely worth
checking - a secret resolved for one invocation never leaking into
another's subprocess environment - is a property of the OS process
boundary `execrunner.go`'s `exec.Cmd` already establishes per call (0010
built and tested this), not a new concurrency mechanism this package
introduces; TC-10 below re-verifies it end-to-end as a regression check,
not because this package's own code newly claims to provide it.

### Test cases

| # | Test | Scope item | Correctness property verified |
|---|---|---|---|
| TC-1 | `buildSecretPath`: `writer` scope + `writerId` -> `writer/<writerId>/<name>`; `user` scope + `sessionId` -> `session/<sessionId>/<name>`; `writer` scope with no `writerId` in context throws `FatalError SECRETS_MISSING_WRITER_ID`; `user` scope with no `sessionId` throws `FatalError SECRETS_MISSING_SESSION_ID`. Plain Vitest, no I/O | 9.2 | The Open-questions-resolved writer-path/user-path mapping (FINDINGS.md's "practical mapping onto D7's model" paragraph) |
| TC-2 | `createOpenBaoSecretsStore(...).resolve()` against a real OpenBao dev container: seed `secret/data/writer/w1/api-key` = `{value:"sk-test-123"}` via a direct KV v2 write in test setup; `resolve({scope:"writer",name:"api-key"}, {writerId:"w1"})` returns `"sk-test-123"` | 9.2 | D7 rule 3 (push-by-value via a synchronous broker read) against OpenBao's real KV v2 wire shape, not a mocked one |
| TC-3 | `resolve()` for a path with no entry returns... no - throws `FatalError SECRETS_NOT_FOUND` (never `RetryableError`) | 9.2 | Fail-closed classification: a missing secret is a real registration/config gap, not a transient condition - mirrors `dispatch.ts`'s existing fatal-vs-retryable split for `4xx` vs. transport failures |
| TC-4 | `resolve()` against a closed local port (broker unreachable) throws `RetryableError SECRETS_BROKER_UNREACHABLE` | 9.2 | Transient-vs-fatal classification, extending ADR-0008's Window A/C "transient unreachability is safe to retry" framing to the broker call specifically |
| TC-5 | `resolve()` against a broker that accepts the connection but never responds, with a short `fetchTimeoutMs`, throws `RetryableError` within a bounded time (not indefinitely) | 9.2 | Bounded resolution latency - mirrors 0011's own `AGENT_FETCH_TIMEOUT_MARGIN_MS` fix, applied here to the broker call before this package's own review pass has to catch the same class of gap twice |
| TC-6 | `dispatch.ts`'s secret-env-var-name validation: `"API_KEY"` accepted; `"api-key"`, `"1KEY"`, `"API KEY"`, `"API-KEY"` all rejected with `FatalError WORKER_INVALID_SECRET_ENV_VAR_NAME`, before any network call (mocked `SecretsStore.resolve` never invoked) | 9.3 | This package's own resolved "record key = env var name" convention (Open questions) validated with the same fail-on-our-side posture `assertValidArgFlagName` already established for `args` |
| TC-7 | `dispatchStep` called with a `step.secrets` containing one entry and `opts.secretsStore` undefined throws `FatalError WORKER_SECRETS_STORE_NOT_CONFIGURED` before calling `invoke()` (mocked, asserted never called) | 9.3 | The resolved "optional store, fail closed if actually needed" call (Open questions) - a workflow that doesn't need secrets must not require standing up OpenBao, but one that does must fail loudly, not silently send an empty array |
| TC-8 | `dispatchStep` with two `step.secrets` entries and a stub `SecretsStore` (in-memory, resolves by name): the built `InvokeRequest.secrets` contains exactly `[{name: envVarKey, value: stubValue}, ...]` for both, `InvokeRequest.args` is unaffected (built from `resolvedInput` exactly as before, independent code path) | 9.3, 9.4 | D7 rule 2 (per-request, never env-for-container-lifetime - this is *the* per-request payload) and rule 4 (secrets never touch `args`/durable history - proven structurally at the point the request object is constructed) |
| TC-9 | **Real end-to-end**: real testcontainers Postgres (`core/`) + real OpenBao dev container (seeded with a known secret) + real spawned exec-agent binary + the new `secret-echo-cli.sh` fixture (echoes only env vars matching a known test prefix, never the full environment, to avoid asserting against the agent's own unrelated env). Compile/submit a one-step workflow whose step declares `secrets: { TEST_SECRET: { scope: "writer", name: "api-key" } } }`, run via `runOnce`/`runWorkerLoop` with a real `SecretsStore` and `writerId: "w1"` in the resolution context. Assert: (a) the fixture's echoed output shows `TEST_SECRET` set to the seeded value: the agent really delivered it; (b) querying `core/`'s `workflow_runs`/`executions`/`checkpoints` rows for this run directly, no row's serialized JSON contains the raw secret value as a substring | 9.3, 9.4 (the package's central claim) | The full D7/ADR-0008 path proven against real products on both sides (worker<->OpenBao, worker<->agent<->subprocess), and D7 rule 4's durable-history guarantee checked directly against the database, not assumed from code inspection alone |
| TC-10 | **Isolation regression** (real agent, same process across two calls): two sequential `runOnce` cycles for two different steps, each with a *different* seeded secret value, dispatched to the SAME long-running spawned agent process. Assert each invocation's echoed env shows only its OWN call's value, never the other's | 9.3, 9.4 (explicitly NOT 9.8 - see Scope) | The narrower proxy for 9.8 this package's Scope section names: per-invocation subprocess-env isolation, re-verified end to end through this package's own new code path (0010 already tested the underlying `exec.Cmd`-per-call mechanism in isolation; this checks this package's dispatch code doesn't accidentally reuse or leak a resolved value across calls) |
| TC-11 | `core/`: fresh `schema.sql` apply asserts `workflow_runs.writer_id` exists, nullable, no FK/CHECK (schema.test.ts extension); `WorkflowRunsRepo.create({writerId: "w1", ...})` then `findById` round-trips `writerId`; `create({...})` with no `writerId` stores `NULL` | 9.3 (the `writerId` addition) | The small, justified `core/` addition's own correctness, mirroring `session_id`'s already-tested shape exactly |
| TC-12 | `engine.submitRun(repos, spec, input, { writerId: "w1", sessionId: "s1" })` creates a `workflow_runs` row with both fields set; omitting `writerId` leaves it `null` (mirrors the existing `sessionId` test) | 9.3 | `submitRun`'s pass-through contract for the new option, extended exactly like its existing `sessionId` option |
| TC-13 | A step dispatch that fails (agent reports nonzero exit) while carrying a resolved secret: assert the structured log entries `worker-loop.ts` emits on the terminal-failure path (captured via a test-local pino transport/stream) never contain the resolved secret value anywhere in the logged object, even though the value was in scope at the failure site | 9.6 (log-redaction half) | The log-redaction half of 9.6 - extends 0011's own `stderrExcerpt`-bounding precedent to this package's new resolved-secret value specifically |

TC-1, TC-6, TC-7, TC-8 are plain Vitest, no I/O (TC-1 has no I/O at all;
TC-6/7/8 mock `SecretsStore`/`invoke` and assert on call counts/thrown
errors, per `dispatch.ts`'s existing unit-test style). TC-2 through TC-5
use the new real-OpenBao-container setup. TC-9, TC-10, TC-13 use the
existing testcontainers-Postgres + real-agent-process pattern (0011)
extended with the real OpenBao container and the one new fixture script.
TC-11/TC-12 use the existing testcontainers-Postgres pattern already
established for `core/`/`engine/` tests.
