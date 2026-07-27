# 0011: `apps/worker` - real CLI dispatch via the exec-agent

## Status

`reviewed`

## Scope

This package covers tasks **6.15**, **6.3**, and **6.4** - the first
implementation of `apps/worker`, the app ADR-0007 names as "the single
place that actually calls the ADR-0008 exec-agent's `Invoke`/`Evict` RPCs."
Everything this package builds sits on top of five already-`reviewed`
packages: `core/`+`engine/`'s durability primitives (0001/0002),
`workflow-spec/` (0004), `scheduler/`'s placement decision logic (0005),
the plain-step interpreter (0006), `registry/` (0007), `dsl-compiler/`
(0009, `implemented`, not yet `reviewed` - see "Open questions" below),
and the exec-agent itself (0010).

**In scope:**

- **6.15**: wire the interpreter's outer dispatch to a real call - the
  exec-agent's `Invoke` RPC - for every plain step of a compiled
  `WorkflowSpec`/`ExecutionPlan`, replacing the inline in-memory stub
  `dispatch()` function `test/dsl-compiler/compile.integration.test.ts`
  currently uses to prove the interpreter loop.
- **6.3** (spawn-per-call) and **6.4** (warm-pooled) as a SINGLE dispatch
  code path: per ADR-0005/ADR-0008, both are "call the exec-agent's
  `Invoke` RPC against a target Pod" - they differ only in whether the
  target Pod was already warm, which is a placement/pooling concern (7.x,
  not built), not a different dispatch mechanism. This package builds the
  one mechanism; it does not distinguish the two cases at runtime.

**Explicitly NOT in scope (see "Sequencing rationale" for why):**

- **4.1/4.3/4.4-4.7** (placement-aware routing to a specific warm
  replica, promotion/demotion wiring) remain `[ ]`. This package uses a
  single, statically configured exec-agent endpoint for every dispatch
  (see Plan, "Addressing gap" below) - there is no real multi-replica
  pool (7.x) yet for placement to route across. `scheduler/resolvePlacement`
  is a real, tested module (0005) but this package does not call it,
  because doing so now would produce placement decisions with no
  corresponding infrastructure to act on - a future package (following
  7.1/7.2's KEDA/pool work) is the honest place to wire 4.1/4.3/4.4-4.7 in.
- **6.6** (retry/backoff/timeout policy per step) - a dispatch failure in
  this package either rolls back for the *next* claim to retry immediately
  (no backoff) or marks the run failed outright (see Plan). Real backoff
  policy is left to 6.6.
- **9.3/9.4** (secrets resolution/injection) - this package's `InvokeRequest`
  always sends an empty `secrets` array; `step.secrets` (workflow-spec's
  `SecretRef` binding) is not read or resolved here. `secrets/` (task
  9.1-9.4) is a separate, not-yet-built module.
- **`dataFiles`/`positionalArgs`** (heavy/dataset-scoped CLI bindings,
  design.md D17/D17a/D17b) - since 6.2a's binding resolution only
  supports `literal`/`request`/`step` (light bindings), no CALLER in this
  package's original scope ever supplied a real materialized local path
  for `dispatch.ts`'s (later-added, see Review notes' final pass)
  heavy-binding rendering to act on. Dataset-scoped bindings genuinely
  resolving to a local path depend on the dataset catalog (5.6d, not
  built) - `renderHeavyBindings`/`buildInvokeRequest`'s `capability`
  param is written to already be correct once 5.6d lands (this package's
  own established pattern: state a real gap explicitly rather than guess
  a shape), but nothing in THIS package's scope calls it with a non-empty
  `invocationDescriptor` today.

## Sources

- **ADR-0005** (step dispatch is CLI-only): the outer-dispatch mandate
  this package implements - every step, CLI, via `--flag value` /
  `--data-file`/`--state-id`, never REST.
- **ADR-0008** (in-pod exec-agent): the `Invoke`/`Evict` RPC contract
  (`agent/internal/api/types.go`), the idempotency key
  (`executionId`+`stepId`, already the `checkpoints` table's own unique
  key), the "checkpoint-check-before-invoke is the real durable
  idempotency gate" rule this package must honor (the interpreter already
  only calls dispatch for a freshly claimed, not-yet-checkpointed
  execution, so this falls out for free), and the "affinity is an
  optimization, rehydrate-anywhere-on-fallback" framing this package
  explicitly defers rather than half-implements.
- **ADR-0007/0012**: `apps/worker` lives at `src/apps/worker/`, entrypoint
  named `main.ts` (ADR-0012's own lint-rule note names `apps/*/main.ts`
  explicitly), no barrel (`index.ts`) since nothing else imports an app.
- **design.md D17/D17a**: the CLI heavy-data convention this package's
  light-binding-only args translation is the base case of.
- **tasks.md 6.2a** (`docs/impl-plans/0006-interpreter-plain-steps.md`):
  the interpreter this package is the first real caller of; its own text
  explicitly names `apps/worker` as the future caller for
  `resolveStepReads`/`findRunStepNode`/`completeStep`, and its retro notes
  that `StepDispatcher` was removed from `engine/` pending "a real caller
  (a future worker)" to define it - this package is that caller.
- **tasks.md 4.1a/0005**: confirms `Placement.replicaId` is a bare
  `string | null` with no network-address field anywhere in `core/`,
  `scheduler/`, or `registry/` - the basis for this package's "Addressing
  gap" decision below.

## Plan

### Module layout

```
src/apps/worker/
  main.ts             entrypoint: builds the pool + agent client from
                       config, runs the poll loop forever, handles
                       SIGTERM (drain: finish the in-flight transaction,
                       then exit - mirrors agent/main.go's own posture)
  config.ts            zod schema over process.env for this app's own
                       vars (see "Config" below) - app-local, NOT added
                       to shared/config.ts, since these vars are specific
                       to this one entrypoint, not cross-cutting
                       (ADR-0012's shared/ closed-set rule)
  constants.ts          named constants: default poll interval, default
                       lease seconds, default invoke timeout
  agent-client.ts       TS mirror of agent/internal/api/types.go's wire
                       types (InvokeRequest/InvokeResponse/DataFile/
                       Secret), and invoke(baseUrl, req) -> InvokeResponse
                       (a plain fetch() POST to `${baseUrl}/invoke`)
  dispatch.ts           translates a step's resolved reads + step.function
                       into an InvokeRequest (see "Args translation"),
                       calls agent-client.invoke, maps the InvokeResponse
                       into either a resolved output object or a thrown
                       PlatformError
  worker-loop.ts        runWorkerLoop(pool, deps, opts): the actual
                       claim -> resolve -> dispatch -> complete/fail loop,
                       factored out of main.ts so it's directly callable
                       from an integration test without spawning a real
                       process
```

No `database/`, `repositories/`, or `domain/` subdirectories - this app
owns no schema and no repositories of its own (ADR-0012's shape applies
per-module; an app is explicitly not a module in that sense - it composes
`core/`/`engine/`/`workflow-spec/` via their barrels only). No `index.ts`
barrel either, since nothing else imports `apps/worker` - this is a
deliberate, explicit deviation from ADR-0012 point 2's "every module has
an `index.ts`" for the reason ADR-0007 itself already gives (`apps/*` are
"entrypoints, not packages").

### Small, justified addition to `core/`

`ExecutionsRepo` gains one method, mirroring the shape of the existing
`markDone`/`markWaiting`:

```ts
markFailed(id: number): Promise<void>;
```

backed by a new `SQL_MARK_EXECUTION_FAILED` query
(`repositories/queries/executions.queries.ts`) - `UPDATE executions SET
status = 'failed', updated_at = now() WHERE id = $1`. No schema
migration: `'failed'` is already a valid `executions.status` value (`core/
database/schema.sql`'s existing `CHECK` constraint) that no code path has
ever written until now (6.2a's interpreter never calls it; only
`workflow_runs.markFailed` existed as a writable terminal state before
this package). Without this, a fatally-failed step's execution row would
stay `running` with an expiring lease forever, eligible for pointless
reclaim-and-redispatch against a run that's already `failed` - see
"Dispatch failure handling" below for why this matters here specifically.

### Wire types (`agent-client.ts`)

**Superseded by design.md D17b (see this file's Review notes, final
pass) - kept here as the shape originally planned/built against.**
`dataFiles[].flag`/`stateId` are now optional (rendered per the target
function's own registry-declared `invocationDescriptor`/`stateReuse`),
`dataFiles[].stdinFromPath` was added, and `InvokeRequest.positionalArgs`
was added.

Mirrors `agent/internal/api/types.go` exactly (field names, optionality):

```ts
export interface InvokeRequest {
  executionId: string;
  stepId: string;
  function: string;
  args?: Record<string, string>;
  dataFiles?: { flag: string; path: string; stateId: string }[];
  secrets?: { name: string; value: string }[];
  stdin?: string; // base64, matches Go's []byte JSON encoding
  timeoutMs: number;
}

export interface InvokeResponse {
  status: "ok" | "error" | "timeout";
  stdout: string;
  stderr: string;
  exitCode: number;
  output?: unknown; // agent's best-effort JSON.parse of stdout
}

export async function invoke(baseUrl: string, req: InvokeRequest): Promise<InvokeResponse>;
export async function evict(baseUrl: string, stateId: string): Promise<{ ack: boolean }>;
```

`invoke`/`evict` throw a `RetryableError` (`WORKER_AGENT_UNREACHABLE`) on a
network-level failure (fetch throws, non-2xx/non-4xx status) - retryable
because the agent being briefly unreachable is exactly the kind of
transient condition ADR-0008's Window A/C already accept as safe to retry
against content-addressed, idempotency-keyed work. A `4xx` (validation
error on our own request shape - a genuine bug in this package, not a
transient condition) throws a `FatalError`
(`WORKER_INVOKE_REQUEST_REJECTED`) instead.

### Args translation (`dispatch.ts`)

`resolveStepReads` (0006) returns `Record<string, unknown>` - plain JS
values. The agent's `Args` field is `Record<string, string>` (every value
becomes a literal CLI flag value, per `execrunner.go`'s `--<flagName>
<value>` construction). Translation rule for this package (light bindings
only, per Scope):

- `string` -> passed through unchanged.
- `number`/`boolean` -> `String(value)`.
- `object`/`array`/`null` -> `JSON.stringify(value)` (the function's CLI
  entrypoint is responsible for parsing it back; this mirrors how
  `fake-cli.sh` and any real CLI-flag-consuming function would receive a
  JSON-shaped flag value today - no richer convention exists yet in
  design.md/the registry's OpenAPI-spec metadata to do better).
- `undefined` -> the key is omitted from `args` entirely (never sent as
  `"undefined"`).

Flag-name validity: `execrunner.go` requires `^[a-zA-Z][a-zA-Z0-9-]*$` for
every args key. `dispatch.ts` validates each `reads` key against the same
pattern *before* calling `invoke`, throwing `FatalError`
(`WORKER_INVALID_ARG_FLAG_NAME`) - failing on our own side with a clear
error rather than letting the agent's `400` response surface as an opaque
transport error.

### Addressing gap (explicit scope decision)

There is no address/host/port anywhere in `core/`'s `placement` table or
`registry/`'s entry data (confirmed during planning - `Placement.replicaId`
is a bare opaque string, never a network target). Building real
placement-aware addressing needs an actual replica pool (7.1/7.2, not
built). This package's `config.ts` defines a single
`AGENT_INVOKE_BASE_URL` env var, used for **every** dispatch regardless of
`step.service`/`step.function` - a deliberate placeholder, not a
"fallback to any replica" implementation of 4.3 (there is only ever one
configured address, so there is no real fallback to speak of). This is
flagged in tasks.md 4.3's own note ("remains open pending a real caller")
- this package is that caller for 6.15/6.3/6.4, but 4.3 itself stays
`[ ]`, to be picked up once 7.x's pool exists and there is more than one
real address to choose between.

### Worker loop (`worker-loop.ts`)

Directly generalizes `test/dsl-compiler/compile.integration.test.ts`'s
existing manual loop (see that test for the proven pattern) into a
reusable, run-id-agnostic function - the key difference is that a real
worker doesn't hold one `WorkflowRun` in memory across iterations; it
re-fetches whichever run a freshly claimed execution belongs to:

```ts
export interface WorkerDeps {
  agentBaseUrl: string;
  workerId: string;
  leaseSeconds: number;
  invokeTimeoutMs: number;
}

export async function runOnce(pool: Pool, deps: WorkerDeps): Promise<boolean>;
// One claim -> dispatch -> complete/fail cycle, one transaction. Returns
// false if there was nothing to claim (caller sleeps and retries).

export async function runWorkerLoop(
  pool: Pool,
  deps: WorkerDeps,
  opts: { pollIntervalMs: number; signal: AbortSignal },
): Promise<void>;
// Calls runOnce() forever until opts.signal fires; sleeps
// opts.pollIntervalMs after any cycle that returns false.
```

`runOnce`'s transaction body:

```
execution = claimExecution(repos, workerId, { leaseSeconds })
if !execution or execution.runId == null: return false   // not a workflow-run execution (or nothing to claim)

run = repos.workflowRuns.findById(execution.runId)   // must exist - FatalError if not
node = findRunStepNode(run, execution.step)
resolvedInput = resolveStepReads(repos, run, node)

try:
  invokeReq = buildInvokeRequest(execution, node, resolvedInput, deps.invokeTimeoutMs)
  invokeRes = agentClient.invoke(deps.agentBaseUrl, invokeReq)
  if invokeRes.status !== "ok":
    // agent ran the CLI; it exited nonzero or timed out - a real,
    // reported failure, not a transport problem. Terminal for this
    // package (6.6's retry/backoff policy is not built) - fail the run.
    repos.workflowRuns.markFailed(run.id)
    repos.executions.markFailed(execution.id)
    return true   // did work (a terminal failure IS work), commit
  output = parseInvokeOutput(invokeRes)   // FatalError if invokeRes.output isn't a plain object
  completeStep(repos, { run, executionId: execution.id, nodeId: node.id, output })
  return true
catch (RetryableError):
  // agent unreachable etc. - rethrow to let withTransaction ROLL BACK
  // the whole transaction, including the claim itself, so the execution
  // reverts to its pre-claim status and is immediately reclaimable by
  // the next poll (or another worker) - at-least-once, no backoff (6.6).
  rethrow
```

A `RetryableError` propagating out of the transaction body is caught one
level up, in `runOnce`, logged, and turned into a `false` return (so
`runWorkerLoop` sleeps before its next attempt rather than hot-looping) -
`runOnce` itself never lets an error escape to `runWorkerLoop`, so one
step's transient failure can never crash the whole worker process.

### Config (`src/apps/worker/config.ts`)

```ts
AGENT_INVOKE_BASE_URL   string, required, e.g. "http://127.0.0.1:9464"
WORKER_ID                string, default: a generated id (hostname+pid)
CLAIM_LEASE_SECONDS      positive int, default 30
INVOKE_TIMEOUT_MS        positive int, default 30000
POLL_INTERVAL_MS         positive int, default 250
```

Follows `shared/config.ts`'s exact pattern (one zod schema, parsed once,
fails closed) but lives in `apps/worker/` itself, not `shared/` - these
vars are meaningful to this one entrypoint only, and `shared/` is a closed
set per ADR-0012.

### Sequencing rationale

**Why now:** every module this package composes (`core/`, `engine/`,
`workflow-spec/`, `dsl-compiler/`, `registry/`, `agent/`) is already
built and `reviewed`/`implemented`. This is the first package that
actually runs a compiled workflow against a real (non-in-memory-stub)
target, closing the loop the whole stack has been built toward -
`docs/impl-plans/0006-interpreter-plain-steps.md`'s own text names
`apps/worker` as the caller its exported functions were written for but
have never had.

**What it unblocks:** 8.1/8.3/8.4 (end-to-end tests needing a real
dispatch path), and gives 4.1/4.3/4.4-4.7 and 7.1/7.2 a real call site to
design against once they're picked up (this package's `dispatch.ts`/
`worker-loop.ts` split is deliberately structured so a future package can
swap the single static `AGENT_INVOKE_BASE_URL` for a real
`scheduler.resolvePlacement`-driven address lookup without restructuring
the dispatch/complete transaction shape).

**What it depends on that must already exist:** `core/`'s
`claimExecution`/`completeExecution`/`workflow_runs`/`run_node_outputs`
(0001, 0006), `dsl-compiler/compile()` producing a real `ExecutionPlan`
(0009), and the exec-agent binary + its `/invoke`/`/evict` HTTP contract
(0010) - all five already `reviewed` or `implemented`.

## Open questions this package must make a call on

1. **0009's README-index status is stale** (`implemented`, while the
   document's own `## Status` says `reviewed`) - not this package's
   scope to fix, but noted here since 0009 is a Source; the README row
   will be corrected as a one-line drive-by fix in this package's
   Phase 3, not treated as blocking.
2. **Agent auth (`AGENT_AUTH_TOKEN`)**: the agent supports an optional
   bearer token. This package's `agent-client.ts` does not send one (no
   `AGENT_AUTH_TOKEN`-equivalent config var here) - authentication between
   worker and agent is left unconfigured/open, consistent with there
   being no real deployment (mTLS/service-mesh identity, per ADR-0008's
   "in-cluster TLS" framing) to authenticate against yet in this repo.
   Flagged, not silently assumed: a real deployment package would need to
   add this.
3. **`stdin` is never populated** by `dispatch.ts` in this package -
   nothing in workflow-spec's `Step` shape names an stdin source today;
   left as an always-empty field on `InvokeRequest`, consistent with
   Scope's light-bindings-only boundary.

## Test design

### Is the default setup (Vitest + testcontainers-node for Postgres) sufficient?

**Not on its own - one addition is warranted, for a specific reason.**
`test/dsl-compiler/compile.integration.test.ts`'s existing pattern (real
testcontainers-managed `core/` + `registry/` Postgres instances) is
sufficient for everything this package does that touches only Postgres.
But this package's actual, defining correctness property is "our TS
client speaks the exec-agent's real wire protocol correctly, and a real
CLI subprocess actually runs" - a hand-mocked `fetch()` response would
prove our own code parses whatever shape we hand-wrote, not that we
match `agent/internal/api/types.go`'s real JSON encoding (`InvokeResponse`
is a Go struct with `json.RawMessage`/`[]byte`-as-base64 quirks a mock
could easily get subtly wrong in a way that only shows up against the
real binary). Package 0010 already validated the k8s injection shape
(`agent/deploy/kind/run-e2e.sh`) and the agent's own Go-side behavior
(`go test ./... -race`) - this package does not need to re-run either of
those; it only needs a **local-process** (no Docker, no kind/k8s) test
that spawns the real, already-built agent binary and points it at a real
fixture CLI script, exactly mirroring the "local-process integration
test" shape `run-e2e.sh` itself uses for its own `curl` assertions (see
Sources) but driven from this package's own TS HTTP client instead of
`curl`.

**Concretely:** a `test/apps/worker/support/agent-process.ts` helper -

```ts
export async function startTestAgent(execPath: string): Promise<{ baseUrl: string; stop(): void }>
```

- Picks a free TCP port itself (bind `:0` via `node:net`, read back the
  assigned port, close, hand that port to the agent's `--listen`) rather
  than parsing agent stdout for a bound-port announcement (the agent
  prints no such line today).
- `execPath` is `go build`'s output, built once in a `beforeAll` via
  `execFileSync("go", ["build", "-o", tmpBinPath, "."], { cwd: "agent" })`
  - a real, environment-level dependency on the `go` toolchain being
    present (it already is, for package 0010's own `go test`/CI). If
    `go build` fails, the test suite fails loudly with the build's own
    stderr, not a silent skip - this package's core claim is untestable
    without a real agent binary, so masking that failure would defeat
    the point of adding this test layer at all.
- Spawns the binary with `--listen :<port> --exec <fixture-cli-path>
  --state-dir <tmp-dir>`, polls `POST /invoke` with a trivial
  `timeoutMs`-bounded request in a short retry loop until it stops
  connection-refusing (no `/health` endpoint exists on the agent to poll
  instead), then returns.
- Reuses `agent/testdata/fake-cli.sh` as the fixture CLI directly - no
  new fixture script needed. It already echoes back `{"args":[...],
  "stdin":"..."}` on stdout, which is exactly what's needed to assert
  "the flags we translated are the flags the real subprocess received,"
  and it already supports `--exit-code N` for the terminal-failure test.

### Test cases

| # | Test | Scope item | Correctness property verified |
|---|---|---|---|
| T1 | `translateArgsToInvokeArgs`: string passthrough; number/boolean -> `String()`; object/array/null -> `JSON.stringify()`; `undefined` key omitted entirely (table-driven, plain Vitest, no I/O) | 6.15 | This package's own args-translation rule (Plan, "Args translation") - the only place D17/D17a's light-binding CLI convention is actually implemented for a real dispatch call |
| T2 | Flag-name validation: `^[a-zA-Z][a-zA-Z0-9-]*$` accepted; a key with a dot/space/leading digit rejected with `FatalError WORKER_INVALID_ARG_FLAG_NAME`, before any network call | 6.15 | Mirrors `execrunner.go`'s own flag-name constraint (ADR-0008) - fails on our side with a clear error instead of surfacing the agent's opaque `400` |
| T3 | `agent-client.invoke()`: a connection failure (mocked `fetch` throw) maps to `RetryableError WORKER_AGENT_UNREACHABLE` | 6.3/6.4 | ADR-0008 Window A/C's "transient unreachability is safe to retry against idempotency-keyed work" framing |
| T4 | `agent-client.invoke()`: a `400` response maps to `FatalError WORKER_INVOKE_REQUEST_REJECTED`, never treated as retryable | 6.15 | This package's own transient-vs-our-own-bug distinction (Plan) |
| T5 | `agent-client.invoke()`: a `200` response with `status: "error"`/`"timeout"` is returned as a plain `InvokeResponse`, not thrown - passthrough fidelity to `agent/internal/api/types.go`'s exact field names/optionality | 6.15 | ADR-0008's wire contract; keeps the ok/error/timeout *decision* in `dispatch.ts`/`worker-loop.ts`, not the transport client |
| T6 | `apps/worker/config.ts`: missing `AGENT_INVOKE_BASE_URL` fails closed at parse time; unset optional vars fall back to their documented defaults | 6.15 | ADR-0009's fail-closed-config pattern, extended to this app |
| T7 | **Real-agent integration**: compile a two-step YAML workflow (`stepB` reads `{from:"step", id:"stepA", output:"args"}`) via `dsl-compiler/compile()` against real testcontainers Postgres (core + registry) -> `submitRun` -> `runWorkerLoop`/repeated `runOnce` against a REAL spawned agent binary + `fake-cli.sh` -> assert `getRunResult` returns `status: "done"` with `outputs` reflecting the real translated `--flag value` argv `fake-cli.sh` actually received and echoed back | 6.15, 6.3, 6.4 (the package's central claim) | ADR-0005 (CLI, unconditionally) + ADR-0008 (the real `Invoke` wire contract, idempotency key `(executionId, stepId)` sent correctly) - proven against the real binary, not a mock |
| T8 | Same setup as T7, but `fake-cli.sh --exit-code 1` for one step: assert `workflow_runs.status` becomes `failed` AND the claimed execution's own status becomes `failed` (new `ExecutionsRepo.markFailed`), and `getRunResult` reports `failed` rather than leaving the run stuck `running` | 6.15 | This package's own terminal-failure decision (Plan, "Dispatch failure handling") + the new `core/` `markFailed` addition |
| T9 | Same setup as T7, but `AGENT_INVOKE_BASE_URL` pointed at a closed local port for one `runOnce` call: assert the whole claim transaction rolled back (the execution reverts to its pre-claim, reclaimable status, not left `running` with a dangling lease), then a subsequent `runOnce` call successfully claims and completes the SAME execution with no backoff | 6.3/6.4 | This package's "a `RetryableError` rolls back the whole transaction" decision + ADR-0008's at-least-once-is-safe framing; explicitly does NOT claim to implement 6.6's real backoff policy |
| T10 | Extending T7's assertions: `fake-cli.sh`'s `FAKE_CLI_INVOCATIONS_FILE` shows exactly one invocation per step on the successful path - no accidental double-dispatch from this package's own new loop code | 6.15 | Package-specific regression check (0001's checkpoint-gate already prevents double-completion at the DB level; this checks the loop itself never calls `invoke()` twice for one step in the ordinary case) |
| T11 | Two concurrent `runOnce` "workers" (two Node-level loops, same real Postgres + same real agent process) draining a single multi-step run: assert every step is dispatched to the real agent exactly once in total, split across the two callers, with no duplicate `/invoke` call for the same `(executionId, stepId)` | 6.15 | Regression check on this package's own claim/dispatch loop under real contention - 0001 already proves `SKIP LOCKED` prevents double-claim at the SQL level; this checks the new dispatch code built on top of it doesn't reintroduce a race |

T1-T6 are plain Vitest, no I/O (per ADR-0009's default). T7-T11 use the
existing testcontainers-node Postgres pattern (both `core/` and
`registry/` instances, mirroring `compile.integration.test.ts`) **plus**
the new real-agent-process helper described above - the one addition to
the default setup this package's own wire-protocol correctness property
justifies, scoped as narrowly as possible (a local child process, not a
new Docker/kind dependency).

## Implementation notes

Built exactly per the agreed Plan/Test design, with the following
deviations - all discovered during Phase 3, none changing the package's
agreed shape:

1. **`DATABASE_URL` lives in `src/apps/worker/config.ts`, NOT
   `src/shared/config.ts`**, despite `.example.env`'s pre-existing header
   note suggesting the latter. `src/shared/config.ts` exports its `config`
   singleton parsed EAGERLY at module-import time, and is transitively
   imported by nearly every module in this repo (via
   `shared/observability/logger.ts`). Making `DATABASE_URL` required there
   would fail closed for every test/module that merely imports
   `core/`/`engine/`/etc. without ever needing a live connection (`core/`'s
   own tests hand repositories an already-connected testcontainers pool
   directly, never through shared config) - confirmed by actually trying
   this first and reverting once the blast radius became clear. Kept in
   `apps/worker/config.ts` instead, parsed once at this app's own explicit
   startup (`main.ts`), consistent with ADR-0009's "parsed once at each
   app's startup" read literally (each app, not one global parse point for
   all of them). `.example.env`'s stale note is corrected in the same
   change.
2. **`test/apps/worker/worker-loop.integration.test.ts` starts a FRESH
   agent process per test (`beforeEach`/`afterEach`), not one shared
   instance for the whole file.** Discovered while debugging T8: this
   suite's `resetExecutionAndWorkflowRunTables` helper `RESTART IDENTITY`s
   the `executions` sequence between tests, so two different tests can
   produce the SAME `(executionId, stepId)` tuple - which collided with
   the exec-agent's own local dedup cache (ADR-0008, keyed on exactly that
   tuple), causing a later test to silently receive an earlier test's
   STALE cached result instead of actually re-invoking the fixture script.
   This is a test-isolation artifact only (`executionId` is a genuinely
   global, never-reset sequence in real operation) - fixed by giving each
   test its own agent process, not by changing any production code.
3. **T7's fixture YAML reads `stepA`'s `stdin` output (always `""`),
   not its `args` output**, when building `stepB`'s dependent binding.
   `agent/testdata/fake-cli.sh` (task 0010) constructs its own echoed JSON
   by naively wrapping each argv value in double quotes with no escaping;
   round-tripping an already-JSON.stringify'd `args` array (which itself
   contains embedded double quotes) through a SECOND invocation produces
   invalid JSON on the fixture's own account. This is a pre-existing
   fixture limitation, not a bug in this package's own args-translation
   code (T1's unit tests already cover the object/array `JSON.stringify`
   rule directly, without this landmine) - `agent/testdata/fake-cli.sh`
   was left unmodified rather than risk changing an already-`reviewed`
   package's test fixture; the integration test was adjusted instead.
4. **Small, justified `core/` addition, exactly as planned**:
   `ExecutionsRepo.markFailed(id)` + `SQL_MARK_EXECUTION_FAILED`
   (`src/core/repositories/executions.repository.ts`,
   `repositories/queries/executions.queries.ts`), with its own test in
   `test/core/repositories/executions.repository.test.ts` (idempotency,
   mirroring `markDone`'s existing test shape).
5. **No follow-up tasks.md items spun off.** 4.1/4.3/4.4-4.7 (placement-
   aware addressing) and 6.6 (retry/backoff) were already `[ ]` before
   this package and remain `[ ]`, with their existing notes still
   accurate (this package is now the "real caller" 4.3's note anticipated,
   but deliberately does not wire placement in - see Scope).

All 11 agreed test cases (T1-T11) pass; the full repo-wide suite
(`npm test`) passes (44 files, 270 tests) and `agent/`'s own `go test
./...` remains green (untouched by this package). `npx tsc --noEmit` and
`biome check .` are both clean.

## Review notes

Compared against the agreed Plan and Test design (not a fresh read of the
diff in isolation):

- **Every Scope item is covered.** 6.15 (dispatch wired to the real
  `Invoke` RPC), 6.3/6.4 (built as one dispatch code path, per plan).
  Everything the Scope section named as explicitly NOT in scope
  (4.1/4.3/4.4-4.7's placement-aware addressing, 6.6's backoff,
  9.3/9.4's secrets) is confirmed absent from the diff - `dispatch.ts`'s
  `buildInvokeRequest` never sets `secrets`/`stdin`, and `agent-client.ts`
  never calls `scheduler.resolvePlacement`. (`dataFiles`/`positionalArgs`
  rendering was later added per design.md D17b - see this file's final
  Review-notes pass; no caller in this package's own scope ever
  populates a non-empty `invocationDescriptor`, so the original claim
  "never populates dataFiles" still holds for every code path this
  package itself exercises.)
- **Module layout matches the agreed Plan exactly**: `main.ts`,
  `config.ts`, `constants.ts`, `agent-client.ts`, `dispatch.ts`,
  `worker-loop.ts`, no `index.ts`, no `database/`/`repositories/`/
  `domain/` subdirectories - the planned, deliberate ADR-0012 deviation
  for an app (not a module) held.
- **Every agreed test (T1-T11) exists and passes**, mapped 1:1 to the
  Test design table's scope items/correctness properties - confirmed by
  re-reading each `it(...)` against its table row, not just checking the
  suite is green.
- **Every deviation is recorded** in Implementation notes above: the
  `DATABASE_URL` placement (shared/ vs. apps/worker/, with the concrete
  reason - eager-singleton fail-closed blast radius - discovered by
  trying the originally-suggested location first), the per-test-fresh-
  agent-process fix (a test-isolation bug found via T8 failing, root-
  caused to the exec-agent's local dedup cache colliding with
  `RESTART IDENTITY`-reused execution ids, not a production concern),
  and the `stdin`-instead-of-`args` fixture-binding choice (a pre-existing
  `agent/testdata/fake-cli.sh` quoting limitation, left unmodified since
  that fixture belongs to an already-`reviewed` package).
- **No scope creep**: the "Open questions" section's three items were
  resolved exactly as planned (0009's README status fixed as a one-line
  drive-by; agent auth left genuinely unconfigured, not silently
  defaulted to anything; `stdin` left unpopulated).
- **Local code review pass**: run via `/local-review-uncommitted` (six
  parallel sub-agent tracks: security, performance, business logic,
  deploy safety, duplication, dead code). Findings and the fixes applied
  in response:
  - **CRITICAL - empty/non-JSON stdout terminally failed an otherwise-
    successful step** (`agent/internal/execrunner/execrunner.go` omits
    `Output` entirely when stdout isn't valid JSON, e.g. a `Step` with no
    `writes`). Fixed: `dispatch.ts`'s `parseInvokeOutput` now resolves an
    absent/`null` output to `{}`, reserving the malformed-output error
    for output that is PRESENT but not a plain object. Not caught by
    T1-T11 because `fake-cli.sh` always prints JSON - a new unit test
    covers the absent-output case directly.
  - **CRITICAL - argument/flag injection via unvalidated arg values**
    (only flag NAMES were validated; a resolved value starting with `-`
    would be parsed by the wrapped CLI as an unrelated flag). Fixed:
    `dispatch.ts` now rejects (`FatalError WORKER_UNSAFE_ARG_VALUE`) any
    stringified arg value starting with `-` before ever calling the
    agent. New unit tests cover string/negative-number cases.
  - **CRITICAL - a failed run's sibling executions stayed claimable, and
    a later sibling's `completeStep` could silently flip the run back to
    `done`** (`claim_execution()` has no join to `workflow_runs.status`;
    `SQL_MARK_WORKFLOW_RUN_DONE` had no status guard despite its own
    comment claiming otherwise). Fixed: new `ExecutionsRepo.
    failRemainingForRun(runId)` (+ `SQL_FAIL_REMAINING_EXECUTIONS_FOR_RUN`,
    deliberately excluding `'running'` rows - see its own comment) called
    from `worker-loop.ts`'s new `failRun` helper alongside `markFailed`;
    `SQL_MARK_WORKFLOW_RUN_DONE` gained a `status <> 'failed'` guard (a
    small, targeted fix to already-`reviewed` package 0006's query, with
    its own test). New integration test proves stepB is never dispatched
    once the run is failed.
  - **WARNING - a pre-dispatch `FatalError` (e.g. an unsupported binding
    kind) became an infinite-retry poison-pill** (rolled back instead of
    failing the run, since it was outside the classification `try`).
    Fixed: `worker-loop.ts` restructured so `findRunStepNode`/
    `resolveStepReads`/`dispatchStep` share ONE classification `try`/
    `catch`. New integration test drives this via a `session` binding
    (schema-valid, not yet resolvable by 6.2a).
  - **WARNING - a claimed non-workflow-run execution (`runId == null`)
    had its claim committed and then abandoned** (returning `false` from
    inside `withTransaction` commits). Fixed: throws `RetryableError`
    instead, rolling the claim back. New integration test proves the row
    reverts to `queued`.
  - **WARNING - `pg.Pool` created with no `error` listener** (an idle-
    connection error would crash the whole process). Fixed: `main.ts`
    attaches a logging listener.
  - **WARNING - HTTP dispatch had no client-side timeout**, so a hung
    agent held a transaction/pool-connection/lease indefinitely. Fixed:
    `agent-client.ts` now passes `AbortSignal.timeout(timeoutMs + margin)`
    to `fetch`.
  - **WARNING - no `Authorization` header sent**, forcing a real
    deployment to run the agent with auth disabled (previously an
    unaddressed "Open question"). Fixed: optional `AGENT_AUTH_TOKEN`
    threaded through `config.ts` -> `WorkerDeps` -> `dispatch.ts` ->
    `agent-client.ts`, sent as `Authorization: Bearer <token>` only when
    set (no header at all otherwise).
  - **SUGGESTION - full `stdout`/`stderr` logged verbatim on failure**
    (potential secret/PII leak into the log sink; pino's redact can't
    reach free-form subprocess output). Fixed: `worker-loop.ts` now logs
    `status`/`exitCode` plus a bounded `stderrExcerpt`
    (`STDERR_LOG_EXCERPT_LENGTH`), never the raw response object.
  - **SUGGESTION - `evict()`/`EvictResponse`/`AGENT_EVICT_PATH` were dead
    code** (no production caller). Fixed: removed, along with their
    tests, until a real demote/cleanup caller exists.
  - **SUGGESTION - `AGENT_ARG_FLAG_NAME_PATTERN` duplicated across TS,
    Go, and an error-message string** (drift risk, no parity test). NOT
    fixed - deferred rather than invent a codegen/contract mechanism
    unilaterally; noted here for a future package to address if the
    pattern ever needs to change.
  - **SUGGESTION - no backoff on transient dispatch failure** (fixed
    250ms retry). NOT fixed - this is task 6.6's explicitly agreed scope
    (see this doc's own Scope section), not an oversight; implementing
    it now would silently expand the agreed Plan without going back to
    the user first.
  - **SUGGESTION - hand-mirrored wire types with no cross-language
    contract test for the full field set** (`dataFiles`/`secrets`/
    `stdin`/the removed `evict`). NOT fixed - a real fix (codegen or a
    golden-payload contract test) is a bigger, separate effort better
    scoped as its own future package.

  Re-verified after fixes: `npm test` (44 files, 282 tests, up from 270 -
  the new fix-verification tests), `npx tsc --noEmit`, `biome check .`,
  and `agent/`'s own `go test ./...` all clean/green.

**Third pass: design.md D17b (task 2.12/4.8's re-corrected scope) - a
clean override of the "Wire types"/"Args translation" sections above,
not an additive extension.** D17b splits D17/D17a's single universal
`--data-file <path> --state-id <key>` shape into three layers so an
onboarded service never has to accept a platform-invented CLI contract.
This package's concrete changes:
  - `agent-client.ts`'s `AgentDataFile.flag`/`stateId` become optional,
    `stdinFromPath?: boolean` added; `InvokeRequest.positionalArgs?:
    string[]` added.
  - `dispatch.ts` gains a new exported `DispatchCapability` shape
    (`invocationDescriptor`, `stateReuse`, sourced from `registry/`'s
    `getPlacementFacts`, never invented per-call) and a new exported
    `renderHeavyBindings(resolvedInput, capability, contentHash?)` that
    renders each declared heavy binding per its OWN style - "flag" into
    `dataFiles` with the function's declared flag name, "positional"
    into `positionalArgs` (ordered by `positionIndex`), "stdin" into a
    flagless `dataFiles` entry with `stdinFromPath: true`. `stateId` is
    populated only when the capability declares `stateReuse:
    "stateIdKeyed"` AND a caller-supplied `contentHash` is present -
    real content-hash-to-dispatch wiring is a scheduler/placement
    concern (4.1/4.3, still not built), an explicit, stated gap rather
    than a silent one. `translateArgsToInvokeArgs` gained a second
    parameter (the function's `invocationDescriptor`) so a resolved key
    matching a heavy-binding param is excluded from ordinary light-flag
    rendering rather than double-rendered.
  - `buildInvokeRequest`'s `BuildInvokeRequestParams` gained optional
    `capability`/`contentHash` fields, defaulting to "no heavy bindings,
    no state reuse" so every existing call site (light-bindings-only,
    per this package's own original Scope) is unaffected byte-for-byte.
  - New unit tests: `renderHeavyBindings`'s three styles, the
    `stateReuse`/`contentHash` gating, the `WORKER_INVALID_HEAVY_BINDING_VALUE`
    fail-closed case, and `buildInvokeRequest`'s combined light+heavy
    rendering. `npx tsc --noEmit`, `biome check .`, and the full `npm test`
    suite (44 files, 302 tests) re-verified green after the change - see
    tasks.md 2.12/6.4 and design.md D17b for the corresponding
    onboarding-contract/design-doc updates this package's change is
    paired with.

Status: `reviewed`.
