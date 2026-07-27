# 0010: In-pod exec-agent - `agent/` Go module (`Invoke`/`Evict` RPC server, injection artifact, local idempotency)

## Status

`reviewed`

## Scope

This package covers tasks **6.12**, **6.13**, and **6.14**:

- **6.12:** Build the in-pod exec-agent (separate Go module per
  `docs/adr/0001`/`0009`): the `Invoke`/`Evict` RPC server, running as the
  container's entrypoint (PID 1, not a sidecar), fork/exec'ing the service
  author's original CLI entrypoint on request.
- **6.13:** Build the platform-controlled injection mechanism (an
  init-container copying the static agent binary onto a shared `emptyDir`,
  plus the Pod-template command override) so onboarding a service requires
  no author-side Dockerfile changes.
- **6.14:** Implement the exec-agent's local idempotency/dedup, keyed on
  `(executionId, stepId)` - the same tuple as the `checkpoints` table's
  uniqueness constraint - covering the in-pod race between "still running
  here" and a second caller retrying the same invocation after a dropped
  connection or a crashed worker.

**Explicitly NOT in scope** (each needs a real caller or infrastructure
this package deliberately does not build):

- **6.15** (`apps/worker` wiring the outer dispatch to call this agent's
  `Invoke` RPC) - `apps/worker` does not exist yet; this package produces
  the RPC contract and server `apps/worker` will call, but builds no
  caller itself. A natural next package once this one lands.
- **6.3/6.4** (step-execution handling for spawn-per-call / warm-pooled
  invocation) - these describe `apps/worker`'s dispatch *decision*
  (which Pod, warm or cold); this package only implements the Pod-side
  RPC surface that decision ultimately calls into.
- **7.1-7.4** (KEDA scaling rules, pre-warmed pool management,
  pooled-instance reuse gating, scale-in protection) - autoscaling/pooling
  policy is `apps/worker`+`scheduler/`+cluster-config territory; this
  package only ships the Pod-side binary those policies will schedule.
- **9.3/9.4** (worker-side secret resolution, per-request injection) -
  this package implements the agent's *receiving* half (accepting a
  `secrets` field on `Invoke` and delivering it to the subprocess); the
  *resolving* half (calling a secrets broker, task 9.1/9.2, and deciding
  when to push a value into the RPC) is `apps/worker`'s job and stays
  open.
- **4.8** (CLI heavy-data volume attach/detach on promote/demote) - this
  package implements `Evict` (the local-scratch-file-fallback half of
  4.8), but attach-on-promote and the scheduling cadence that decides
  when to call `Evict` are `scheduler/`+`apps/worker` territory, per
  4.8's own note.
- **A production-shaped Kubernetes cluster/CI wiring for the injection
  mechanism** - out of scope (that's cluster provisioning, not this
  package). What IS in scope, per explicit request during plan review: a
  real, local, ephemeral `kind` (Kubernetes-in-Docker) cluster used as a
  minimal-but-real dev/test target to actually exercise the injection
  mechanism end to end, rather than only checking manifest YAML validity.
  See Test design's T14.

## Sources

- **ADR-0008** (`docs/adr/0008-in-pod-exec-agent.md`): the primary source
  for this entire package - agent shape (PID 1, not sidecar), the
  `Invoke`/`Evict` contract, the init-container + `emptyDir` + command
  override injection mechanism, the `(executionId, stepId)` local dedup
  key and its three failure windows (A/B/C), the state-id-dumb posture,
  the `Evict`-only-matters-for-scratch-files framing, and the
  secrets-relocated-not-reinvented framing.
- **ADR-0001** decision 3: the one deliberate, narrow exception to the
  single-TypeScript-package decision - `agent/` is a separate Go module
  with its own toolchain, justified by its PID-1-in-every-pod footprint.
- **ADR-0007**: names `agent/` as living outside `src/`, "consumed by
  `worker/` only as a network RPC client... never as an in-process
  import," and fixes that the worker addresses a replica's agent via
  direct Pod IP or headless-service DNS (reused from D4, not a new
  mechanism this package invents).
- **ADR-0009**: names the *TypeScript*-side counterpart decisions this
  package's Go code has no direct access to (zod for RPC payload
  validation, pino/OpenTelemetry) - relevant here only as evidence that
  the RPC wire format is JSON-shaped (validated with zod on the TS side),
  not protobuf, which is the basis for this package's own wire-format
  call below.
- **design.md D17/D17a**: the CLI heavy-data transport contract
  (`--data-file`/`--state-id`) this agent's `execrunner` must translate
  `Invoke`'s `dataFiles` into, and the universal-CLI-dispatch mandate this
  agent exists to realize.

### Open questions this package must make a call on

ADR-0008 deliberately leaves several mechanism-level details unresolved
("gRPC/HTTP-internal-only," "a tmpfs-backed file, stdin, or an env var").
This package makes the following concrete calls, each stated explicitly
so it can be revisited rather than discovered later as an implicit
assumption:

1. **Wire format: HTTP/1.1 + JSON, not gRPC.** ADR-0009 already commits
   the TypeScript side to zod-validated JSON payloads for this exact RPC
   ("the ADR-0008 `Invoke`/`Evict` RPC payloads" are named as a zod use
   case) - gRPC would mean maintaining `.proto` definitions and codegen
   for both languages for no benefit ADR-0009 anticipated. Plain
   `net/http` + `encoding/json` on the Go side, no framework - consistent
   with the project's stated "smallest tool that solves the problem"
   posture (ADR-0009's own words).
2. **Secrets delivery mechanism implemented now: subprocess-scoped
   environment variables.** ADR-0008 names three OS-level options
   (tmpfs file, stdin, env var scoped to the subprocess only) without
   picking one. This package implements the env-var option only - it is
   the simplest to implement and test, and is set on the one `exec.Cmd`
   the subprocess runs as, never `os.Setenv` on the agent's own process.
   The tmpfs-file and stdin options remain available to add later (e.g.
   if a step's args are too large for env vars, or a service's CLI does
   not read secrets from its environment) - noted as a real, scoped-out
   alternative, not a rejected one.
3. **`InvokeResponse.output` is best-effort, not OpenAPI-shape-parsed.**
   ADR-0008's contract sketch shows `output: <parsed per the function's
   OpenAPI response shape>` - but the agent has no registry access (it is
   deliberately kept dumb about anything beyond its own exec/dedup
   concerns, mirroring the state-id posture ADR-0008 already states
   explicitly). This package's agent attempts a plain `json.Unmarshal` of
   the subprocess's stdout and includes it as `output` only if that
   succeeds; otherwise `output` is omitted and only `stdout`/`stderr`/
   `exitCode` are populated. Real OpenAPI-response-shape parsing/
   validation is `apps/worker`'s job (task 6.15), since only it composes
   `registry/`'s client.
4. **Evict's local-state location: a single `--state-dir` root, one
   subdirectory per state-id.** `Evict(stateId)` removes
   `<state-dir>/<stateId>` (recursively) if present, and is a no-op
   (still `ok`) if absent - idempotent by construction, matching ADR-0008's
   "only needed for the local-scratch-file fallback path" framing (the
   per-hash-CSI-volume path never calls this at all). **Narrowed further
   by design.md D17b:** the CALLER-side condition for ever invoking Evict
   at all is now also gated on the target function having declared
   `stateReuse: "stateIdKeyed"` in the registry - this package's own
   `evictHandler` needs no code change for that (it has no registry
   access and never did; the gating is `apps/worker`'s responsibility,
   per D17b's "the agent stays deliberately dumb about state-ids" framing,
   now extended to invocation styles too).
5. **Local dedup store: in-memory, process-local, TTL-bounded, no
   persistence.** ADR-0008 itself states the durable idempotency gate is
   the checkpoint-check the interpreter performs *before* calling
   `Invoke` at all - this agent's own dedup only needs to cover the
   narrower in-pod race (Window B: a second `Invoke` for the same
   `(executionId, stepId)` arrives while the first is still running).
   Losing this state on agent restart is an accepted, ADR-0008-anticipated
   gap (a restarted agent has no in-flight subprocesses to protect
   duplicate-detection for anyway).
6. **ADR-0012 (module-internal structure) does not govern `agent/`'s Go
   code.** ADR-0012's `src/shared/config.ts`/`src/shared/errors.ts`/
   barrel-only-imports rules are scoped to the single TypeScript package
   under `src/`; `agent/` is explicitly outside `src/` (ADR-0001 decision
   3). This package instead follows plain idiomatic Go conventions: one
   small `internal/config` package for flag parsing (the Go-side
   counterpart to `src/shared/config.ts`'s role, not an extension of that
   closed file), and standard Go `error` values/wrapping in place of
   `PlatformError`/`RetryableError`. This is stated explicitly so it
   reads as a deliberate, scoped call - not an oversight or a quiet
   extension of the closed best-practices doc, which binds TypeScript
   code only.
7. **Go test layout: co-located `_test.go` files, not a mirrored `test/`
   tree.** ADR-0012 point 6 fixes `test/` mirroring `src/` for Vitest;
   that convention is stated in terms of Vitest's own `include` pattern
   and does not extend to a separate Go module. `agent/`'s tests use the
   idiomatic Go convention (`foo.go` + `foo_test.go` in the same
   directory).
8. **Go toolchain version: pinned via `agent/go.mod`'s `go` directive.**
   The direct analogue of `.nvmrc` for the Node side (ADR-0009: "one pin,
   not two competing mechanisms"). Latest stable Go release at package
   time.
9. **Application-level auth: an optional shared-secret bearer token,
   sourced from an environment variable, not a flag (added during the
   post-review fix-up, not the original plan - see Implementation
   notes).** ADR-0008 assumes the agent's channel is "TLS-secured
   internal"; this package does not implement TLS termination itself
   (that's a real, separate scoping decision for a future pass, e.g.
   mTLS via a service mesh or the agent's own cert handling), but adds a
   lighter-weight, immediately-usable control: if `AGENT_AUTH_TOKEN` is
   set, every `/invoke`/`/evict` request must carry a matching
   `Authorization: Bearer <token>` header. Empty (the default) preserves
   today's "cluster network policy is the only boundary" posture -
   stated explicitly as an accepted gap for a real deployment to close,
   not assumed away.

## Plan

### Module layout (`agent/`, sibling to `src/`, own Go module)

```
agent/
  go.mod
  go.sum
  main.go                        entrypoint: parse flags, build config,
                                  wire dedup store + execrunner + server,
                                  start HTTP server, handle SIGTERM for
                                  graceful shutdown (PID 1 in a real pod
                                  gets signals directly, no init system)
  internal/
    config/
      config.go                  Config{Listen, ExecPath, StateDir,
                                  DedupTTL} from flags (--listen, --exec,
                                  --state-dir, --dedup-ttl)
      config_test.go
    api/
      types.go                   InvokeRequest/InvokeResponse/
                                  EvictRequest/EvictResponse (JSON tags),
                                  mirroring ADR-0008's contract sketch
                                  verbatim in field shape
    dedup/
      dedup.go                   Store: Attach(key) (result <-chan
                                  Result, isLeader bool), Resolve(key,
                                  Result), TTL-based sweep of completed
                                  entries
      dedup_test.go
    execrunner/
      execrunner.go               Run(ctx, req InvokeRequest) ->
                                  InvokeResponse: builds exec.Cmd from
                                  req.Args (flags) + req.DataFiles
                                  (--data-file/--state-id) + req.Secrets
                                  (subprocess-scoped env) + req.Stdin,
                                  applies req.TimeoutMs via
                                  context.WithTimeout, captures
                                  stdout/stderr/exitCode, best-effort
                                  JSON-parses stdout into Output
      execrunner_test.go
    server/
      server.go                   http.Handler wiring (mux, routes)
      invoke.go                   POST /invoke: decode -> dedup.Attach
                                  -> (leader: execrunner.Run + Resolve |
                                  follower: await channel) -> encode
      evict.go                    POST /evict: os.RemoveAll(state-dir/
                                  stateId), always 200 {ok: true}
      server_test.go               httptest-based: happy path, timeout,
                                  nonzero exit, concurrent-same-key dedup
  testdata/
    fake-cli.sh                   test fixture executable standing in
                                  for a service's real CLI: echoes its
                                  argv/stdin as JSON, supports a `--sleep
                                  Nms` flag (for timeout/concurrency
                                  tests) and a `--exit-code N` flag
  build/
    Dockerfile                    multi-stage: golang:<pinned> builder
                                  (CGO_ENABLED=0 go build, static binary)
                                  -> FROM scratch, COPY only the binary -
                                  this is the init-container image 6.13
                                  describes
  deploy/
    pod-injection-example.yaml     documented, generic example: an
                                  initContainer copying /platform/agent
                                  onto a shared emptyDir, and the target
                                  container's command overridden to
                                  `/platform/agent --listen :9464 --exec
                                  <original-entrypoint>` - the literal
                                  shape ADR-0008 names
    kind/
      kind-cluster-config.yaml     minimal single-node kind config
      fake-service.Dockerfile      the "service author's" image: ONLY
                                  testdata/fake-cli.sh baked in, no
                                  agent/platform code - proves 6.13's
                                  no-author-Dockerfile-change claim
      test-pod.yaml                the real T14 injection manifest:
                                  initContainer (build/Dockerfile's
                                  image) + emptyDir + command override
                                  targeting fake-service's image
      run-e2e.sh                   creates the kind cluster, builds/
                                  loads both images, applies test-pod,
                                  waits for Ready, curls /invoke+/evict
                                  through kubectl port-forward, tears
                                  down
```

### Interfaces

**Superseded by design.md D17b (see this file's final review pass, below)
- kept here as the shape originally planned/built against, not the
current one.** `Flag`/`StateID` are now optional (rendered per the
target function's own registry-declared `invocationDescriptor`/
`stateReuse`, never a fixed shape every service must accept), `DataFile`
gains `StdinFromPath`, and `InvokeRequest` gains `PositionalArgs`.

```go
// internal/api/types.go
type DataFile struct {
    Flag    string `json:"flag"`    // e.g. "--data-file"
    Path    string `json:"path"`    // mounted path the agent passes through
    StateID string `json:"stateId"`
}

type Secret struct {
    Name  string `json:"name"`
    Value string `json:"value"`
}

type InvokeRequest struct {
    ExecutionID string            `json:"executionId"`
    StepID      string            `json:"stepId"`
    Function    string            `json:"function"`
    Args        map[string]string `json:"args"`
    DataFiles   []DataFile        `json:"dataFiles,omitempty"`
    Secrets     []Secret          `json:"secrets,omitempty"`
    Stdin       []byte            `json:"stdin,omitempty"`
    TimeoutMs   int64             `json:"timeoutMs"`
}

type InvokeResponse struct {
    Status   string          `json:"status"` // "ok" | "error" | "timeout"
    Stdout   string          `json:"stdout"`
    Stderr   string          `json:"stderr"`
    ExitCode int              `json:"exitCode"`
    Output   json.RawMessage `json:"output,omitempty"`
}

type EvictRequest struct {
    StateID string `json:"stateId"`
}

type EvictResponse struct {
    Ack bool `json:"ack"`
}
```

```go
// internal/dedup/dedup.go
type Key struct{ ExecutionID, StepID string }

type Result struct {
    Response api.InvokeResponse
    Err      error
}

type Store struct { /* mutex-guarded map[Key]*entry */ }

func NewStore(ttl time.Duration) *Store
// Attach returns (resultCh, isLeader). The leader must call Resolve
// exactly once; every follower receives the same Result over resultCh.
func (s *Store) Attach(k Key) (resultCh <-chan Result, isLeader bool)
func (s *Store) Resolve(k Key, r Result)
```

```go
// internal/execrunner/execrunner.go
func Run(ctx context.Context, cfg config.Config, req api.InvokeRequest) api.InvokeResponse
```

```go
// internal/server/server.go
func New(cfg config.Config, dedupStore *dedup.Store) http.Handler
```

### Data flow inside `POST /invoke`

1. Decode `InvokeRequest` (JSON body) into the Go struct; reject with
   `400` on malformed JSON or a missing `executionId`/`stepId`/`function`.
2. `dedupStore.Attach(Key{ExecutionID, StepID})`:
   - **Leader** (no in-flight/cached entry for this key): proceeds to
     step 3.
   - **Follower** (an entry already exists - Window B): blocks on the
     returned channel and, once the leader resolves it, writes the same
     `InvokeResponse` back. No second subprocess is ever spawned for the
     same key while the first is in flight.
3. Leader calls `execrunner.Run(ctx, cfg, req)`, which:
   - builds `[]string` args from `req.Args` (each `flagName -> value`
     becomes `--flagName value`) plus, for each `req.DataFiles` entry,
     `<flag> <path> --state-id <stateId>` (D17/D17a's exact shape);
   - sets `cmd.Env` to the current process's environment plus one entry
     per `req.Secrets` (`NAME=value`), scoped to this one `exec.Cmd` only;
   - pipes `req.Stdin` to the subprocess's stdin if non-empty;
   - runs under `context.WithTimeout(ctx, req.TimeoutMs)`, mapping a
     context-deadline-exceeded into `status: "timeout"`;
   - captures stdout/stderr into buffers, and the exit code via
     `exec.ExitError`;
   - attempts `json.Unmarshal(stdout, &raw)`; sets `Output` to `stdout`
     verbatim as `json.RawMessage` only if that succeeds, else leaves it
     nil.
4. Leader calls `dedupStore.Resolve(key, result)`, unblocking any
   followers, then writes its own response with the same body.
5. The store's background sweep removes entries older than `cfg.DedupTTL`
   past completion (Window C: a bounded local result cache - see ADR-0008
   - not a correctness dependency, since the interpreter's own
   checkpoint-check is the real gate).

`POST /evict` is unconditional and synchronous:
`os.RemoveAll(filepath.Join(cfg.StateDir, req.StateID))`, always
responding `{ack: true}` (removing a nonexistent path is not an error).

### Sequencing rationale

**Why now.** ADR-0008 is fully decided (Status: Proposed, but with no
open questions left unresolved in its own text - see its Consequences
section) and this package has zero dependency on any other unbuilt
module: it needs no database, no `registry/` client, no `core/` schema,
and no `apps/worker` caller to be independently buildable and testable.
It is the one package in the current inventory of un-started work whose
own correctness properties (fork/exec, timeout handling, local dedup) can
be fully exercised without anything else in the system existing yet.

**What it depends on that must already exist.** Nothing beyond ADR-0008's
decision itself. This deliberately does *not* wait for `apps/worker`
(6.15) - building the RPC server first, against ADR-0008's already-fixed
contract, lets `apps/worker` be built next against a real, tested server
rather than a contract still being iterated on both ends at once.

**What it unblocks.** `apps/worker`'s outer dispatch (6.15) and, through
it, 6.3/6.4 (spawn-per-call/warm-pooled step execution), 7.2 (pre-warmed
pool management - "a Pod running the in-pod exec-agent as PID 1"), 9.3/9.4
(the worker-side secret-resolution and injection tasks, which need a real
`Invoke` RPC to push a resolved secret into), and 4.8 (attach/detach on
promote/demote, whose detach half is this package's `Evict`).

## Test design

### Test cases

| # | Case | Scope item | Correctness property verified |
|---|---|---|---|
| T1 | `POST /invoke` with a fake CLI that echoes its args as JSON returns `status: "ok"`, correct `exitCode`, and `output` parsed from stdout | 6.12 | ADR-0008's `Invoke` contract shape; the args-to-CLI-flags translation |
| T2 | `Args` map entries are translated to `--flagName value` pairs the fake CLI receives verbatim | 6.12 | D17a's "light bindings pass as ordinary CLI flags" |
| T3 | `DataFiles` entries are translated to `<flag> <path> --state-id <stateId>` | 6.12 | D17/D17a's mandated heavy-data shape |
| T4 | `Secrets` entries appear in the subprocess's environment but NOT in the agent's own process environment, and are gone once the subprocess exits | 6.12 | ADR-0008's "Secrets" section: subprocess-scoped delivery, never the container's whole lifetime (D7 rule 2) |
| T5 | A fake CLI invocation exceeding `TimeoutMs` returns `status: "timeout"` and the subprocess is killed, not left running | 6.12 | ADR-0008's `timeoutMs` field; platform-managed timeout (design.md D8d) |
| T6 | A fake CLI nonzero exit returns `status: "error"` with the real `exitCode`/`stderr` populated | 6.12 | `InvokeResponse` contract fidelity |
| T7 | Two concurrent `Invoke` calls with the identical `(executionId, stepId)` against a slow fake CLI result in exactly ONE subprocess spawn (asserted via a fake-CLI side effect, e.g. an invocation counter written to a fixture file) and both callers receive the same response | 6.14 | ADR-0008 Window B: local dedup on the in-pod race |
| T8 | A THIRD `Invoke` for the same key, issued after the first has already completed and resolved, spawns a fresh subprocess (no permanent/incorrect caching once the first request is done) | 6.14 | Dedup only covers in-flight overlap, not steady-state re-invocation - the durable checkpoint-check outside this package is what prevents that |
| T9 | A dedup entry older than `DedupTTL` is swept and no longer answered from cache | 6.14 | ADR-0008 Window C's "bounded-TTL local result cache," explicitly a latency nicety, not relied upon past its TTL |
| T10 | `POST /evict {stateId}` removes an existing `<state-dir>/<stateId>` directory and returns `{ack: true}` | 6.13 (Evict half) | ADR-0008's `Evict` contract; D17's scratch-file-fallback cleanup |
| T11 | `POST /evict` for a nonexistent `stateId` still returns `{ack: true}` (idempotent no-op) | 6.13 | ADR-0008: "only needed... on demote" - must never fail merely because nothing was there |
| T12 | Malformed JSON body / missing required field on `/invoke` returns `400`, no subprocess spawned | 6.12 | Basic contract robustness (not itself an ADR-numbered property, but required for T1-T9 to be meaningful) |
| T13 | `docker build` on `build/Dockerfile` succeeds and the resulting image contains a statically-linked, executable `/platform/agent` binary (checked via `docker run --rm <image> /platform/agent --help`-style invocation, or `docker create` + `docker cp` + `file`) | 6.13 (injection artifact half) | ADR-0008's "static agent binary" claim; the init-container's actual deliverable |
| T14 | End-to-end, against a real (ephemeral, local) `kind` cluster: an init-container copies the static agent binary onto a shared `emptyDir`; the target Pod's command is overridden to run the agent as PID 1 (`--exec` pointing at a baked-in fake-CLI image that has NO platform code and NO agent in it - simulating an unmodified service-author image); the agent, running inside the real Pod, correctly serves `/invoke` (fork/exec's the fake CLI, returns its output) and `/evict` over the cluster network | 6.13 (injection mechanism, full) | ADR-0008's actual injection claim - "invisible to the service author," requiring no author-side Dockerfile change beyond an existing CLI entrypoint - proven against a real kubelet/API-server, not asserted from YAML shape alone |

### Default-setup evaluation

The default package-wide setup (Vitest + testcontainers-node, ADR-0009)
does not apply here at all: this package has no Postgres dependency and
is not TypeScript. Its own correctness properties (fork/exec semantics,
timeout/kill behavior, concurrent-request dedup) are exercised with Go's
standard `testing` package plus `net/http/httptest`, which is sufficient:

- T1-T6, T10-T12 are ordinary Go table-driven HTTP-handler tests against
  `httptest.NewServer`, using `testdata/fake-cli.sh` as a controllable
  stand-in for a real service CLI.
- T7-T9 need real concurrency (not simulated), which Go's `testing`
  package supports natively via goroutines + channels/`sync.WaitGroup` -
  no extra tooling required, mirroring the posture the archived spikes
  established for Postgres concurrency tests but realized with Go's own
  primitives instead of testcontainers, since there is no database here.
- T13 needs `docker build`/`docker run`, run as a plain shell/Bash step
  (already how this package's local build is verified elsewhere in this
  repo, e.g. `docker-compose.dev.yml`), not a Vitest or Go test.
- **T14 needs a real Kubernetes API server/kubelet, which `go test` has
  no business spinning up itself.** Per explicit direction during plan
  review, this package adds exactly ONE piece of infrastructure beyond
  the default: a `kind` cluster, provisioned by a standalone script
  (`agent/deploy/kind/run-e2e.sh`), not wired into `go test ./...`'s
  default run. Rationale for going beyond the default here specifically:
  6.13's entire claim ("onboarding a service requires no author-side
  Dockerfile changes") is a claim about real Kubernetes injection
  mechanics (init-containers, `emptyDir`, command override, kubelet
  Pod-spec handling) that no unit test or YAML-shape check can actually
  exercise - the same reasoning the archived spikes already applied to
  justify real-Postgres testing over mocks for `core/`'s durability
  claims. `kind` is the minimal real equivalent available (a single
  Docker container running kubelet+containerd+API-server), consistent
  with this project's "smallest tool that solves the problem" posture -
  not a full cloud cluster, not `minikube`'s heavier VM-based option.
  The script: creates a single-node `kind` cluster, builds both the
  agent init image (`build/Dockerfile`) and a minimal "service-author"
  image containing only `testdata/fake-cli.sh` (deliberately with no
  agent/platform code baked in, to actually demonstrate the
  no-author-changes claim), loads both into the cluster, applies
  `deploy/kind/test-pod.yaml` (the real injection shape: initContainer +
  shared `emptyDir` + command override), waits for the Pod to be
  `Ready`, then runs the same assertions as T1/T10/T11 (`/invoke`,
  `/evict`) against the agent through a `kubectl port-forward`, and tears
  the cluster down. Run manually/in a dedicated CI job given its cost
  (cluster bring-up), not on every local `go test` invocation - mirroring
  how `docker-compose.dev.yml` is a deliberately separate, heavier thing
  from testcontainers' per-test ephemeral instances (ADR-0010).

No other test infrastructure beyond Go's stdlib `testing` plus this one
`kind` script is proposed - the package's remaining correctness
properties (fork/exec, timeout handling, in-process dedup) don't justify
anything heavier than `httptest`.

## Implementation notes

**Built as planned, with one deviation and one addition, both noted here.**

- **Deviation: the agent's runtime image base is `busybox:1.36`, not
  `scratch`.** The plan's original layout section didn't fix this
  explicitly, but the natural reading of ADR-0008's "static agent binary"
  pointed at `scratch`. In practice, `scratch` has no shell/`cp`, so the
  init-container step (6.13) - which needs to `cp` the binary onto the
  target Pod's shared `emptyDir` - has nothing to run. Switched to
  `busybox:1.36` (~2MB, still a static Go binary, still minimal) so the
  init container's overridden `command` (`sh -c "cp ... && chmod +x ..."`)
  actually works. The agent's own `ENTRYPOINT` still starts the HTTP
  server when the image is run directly (as in the plain `docker build`/
  `docker run` verification, T13). Recorded here rather than silently
  assumed, per Phase 3 instructions.
- **Addition (per explicit request during plan review, before
  implementation started): a real `kind`-based end-to-end test for T14,**
  replacing the originally-scoped "structural YAML validation only"
  ceiling. `agent/deploy/kind/` contains `run-e2e.sh`, `test-pod.yaml`,
  `fake-service.Dockerfile`, and `kind-cluster-config.yaml`. This is a
  genuinely separate script, not wired into `go test ./...`, per the
  Test design section's own rationale (cluster bring-up cost). It was run
  successfully against a real, freshly-created `kind` cluster during this
  implementation pass (see below) - not merely written and left
  unexecuted.
- One retry was needed in `run-e2e.sh` itself (not a plan deviation, a bug
  fix during implementation): immediately after `kind create cluster`,
  the `default` namespace's `default` ServiceAccount does not exist yet,
  and `kubectl apply` for a Pod without an explicit `serviceAccountName`
  fails with "serviceaccount default not found" until the built-in
  controller creates it. Added a short poll-wait for that ServiceAccount
  before applying `test-pod.yaml`.
- Toolchain setup performed as part of this implementation pass (not code,
  noted for reproducibility): Go 1.22.7, `kind` v0.24.0, and `kubectl`
  v1.36.3 were installed into the sandbox (none were present beforehand).
  `agent/go.mod` pins `go 1.22.7` per this package's own "Open questions"
  #8.

**Verification performed:**

- `gofmt -l .` - clean (no output).
- `go vet ./...` - clean.
- `go build ./...` - succeeds.
- `go test ./... -race` - all 20 test cases across
  `internal/{config,dedup,execrunner,server}` pass, including the
  concurrency-sensitive T7/T8 (dedup) cases under the race detector.
- `docker build -f build/Dockerfile .` - succeeds; the resulting image's
  `/platform/agent` was extracted and confirmed via `file` to be a
  statically-linked ELF binary (T13).
- `agent/deploy/kind/run-e2e.sh` - run end to end against a freshly
  created, then torn-down, local `kind` cluster: init-container copy,
  Pod-command-override PID-1 startup, real `/invoke` (args round-tripped
  correctly) and `/evict` (acked) through `kubectl port-forward`, plus an
  explicit assertion that `fake-service:test` contains no agent/platform
  code - all passed ("T14 PASSED" in script output). No cluster was left
  behind (the script's `trap cleanup EXIT` deleted it on success).

**Post-review fixes (local code review pass, after the initial implementation above).**
A local review (`/local-review-uncommitted`) found real correctness/security
gaps in the first pass; all were fixed in place rather than deferred, since
they affect this package's own already-agreed scope items (6.12/6.14), not
a new package:

- **Security/correctness (CRITICAL in review):**
  - `evict.go`: `stateId` is now validated against a strict path-safe
    pattern and independently re-checked to resolve to a direct child of
    `--state-dir` before removal (path traversal); genuine `RemoveAll`
    failures now return `500`, distinct from "target never existed."
  - `execrunner.go`: `Args` flag names and `DataFile.Flag` are now
    validated against a safe flag-name shape before being forwarded to
    the wrapped CLI (argument injection).
  - `server.New`/`main.go`: added an optional shared-secret bearer-token
    auth middleware (`AGENT_AUTH_TOKEN` env var, `config.AuthToken`),
    checked via `crypto/subtle.ConstantTimeCompare` - addresses the
    unauthenticated-RPC-surface finding. Read from an environment
    variable, deliberately not a `--auth-token` flag, so it never appears
    in the Pod spec's `command` field or `ps` output. Empty (unset) keeps
    today's default of no application-level auth, relying on cluster
    network policy - the platform is expected to always set this in a
    real deployment; this is recorded as this package's own explicit
    call, not left implicit.
- **Correctness (WARNING in review):**
  - `execrunner.go`: fixed the timeout/success/error classification
    order (`err == nil` is now checked first; timeout is only reported
    when `runCtx.Err()` is actually `DeadlineExceeded`).
  - `invoke.go`: the leader's subprocess now runs under
    `context.WithoutCancel(r.Context())` - a caller disconnecting no
    longer kills an in-flight subprocess or poisons the dedup cache with
    a fabricated error for the rest of `DedupTTL` (ADR-0008 Window B's
    actual intent).
  - `invoke.go`/`config.go`: `timeoutMs` is now validated as strictly
    positive and capped by a new `--max-invoke-timeout` config (default
    5m) - no more silently-unbounded execs.
  - `dedup.go`: added a `maxLease`-bounded sweep that force-resolves (with
    an error `Result`) any entry whose leader never calls `Resolve`
    (crashed/panicked leader) - previously such an entry, and every
    follower attached to it, was stuck forever. Added a background
    ticker sweep (`Store.sweepLoop`/`Close`) so reclamation doesn't
    depend on new `Attach` traffic for the same key.
  - `invoke.go`: followers now `select` on the result channel vs.
    `r.Context().Done()` instead of blocking unconditionally.
  - `main.go`/`server.go`/`invoke.go`/`evict.go`: added `http.Server`
    read/write/idle timeouts and a `MaxBytesReader` cap (16 MiB) on
    both handlers' request bodies; the shutdown drain window is now
    `cfg.MaxInvokeTimeout` + a small buffer instead of a hardcoded 10s
    that could truncate a legitimately long-running invoke.
  - `execrunner.go`: stdout/stderr capture is now bounded
    (`limitedBuffer`, 8 MiB/stream) instead of unbounded.
- **Deploy safety (WARNING in review):**
  - `run-e2e.sh`: `cleanup()` now only deletes the `kind` cluster if THIS
    run created it (tracked via `CREATED_CLUSTER`), rather than
    unconditionally deleting a cluster it merely reused; the port-forward
    log now uses `mktemp` instead of a fixed `/tmp` path.
  - `test-pod.yaml`/`pod-injection-example.yaml`: added a non-root
    `securityContext` (drop all capabilities, `readOnlyRootFilesystem`,
    `runAsNonRoot`), resource requests/limits, `tcpSocket` readiness/
    liveness probes, and an explicit `--state-dir` `emptyDir` volume
    mount - re-verified end to end against a real `kind` cluster after
    this hardening (still "T14 PASSED").
- **Duplication (WARNING in review):**
  - `run-e2e.sh` now asserts, before doing anything else, that
    `test-pod.yaml` and `pod-injection-example.yaml` declare the same set
    of agent flags - the two manifests' `command` blocks can no longer
    silently drift apart undetected.
  - `server_test.go`: extracted a shared `readInvocationCount` helper,
    fixing the divergence a review found between the two tests' ad hoc
    copies of the same parsing logic.
- **Deliberately NOT fixed - a real, named, deferred gap:** reaping
  orphaned grandchild processes as PID 1 (SUGGESTION in review). A
  `wait4(-1, ...)`-based reaper races with `os/exec`'s own internal
  `Wait()` for children `execrunner` is actively waiting on - the exact
  hazard dedicated init shims (`tini`, `dumb-init`) exist to solve
  correctly. A naive homegrown version risks introducing `ECHILD` races
  into the `Invoke` hot path, which is a worse outcome than the
  zombie-accumulation gap itself. Documented in `main.go` and here rather
  than silently left unaddressed; a real fix (a vetted subreaper
  approach, or documenting that most wrapped CLIs don't double-fork in
  practice) is left as an explicit follow-up, not assumed solved.
- Two SUGGESTION-level findings were accepted as-is without a code
  change: the unused-channel-for-leader shape in the original
  `dedup.Attach` was fixed as part of the maxLease rework above (the
  leader now gets `nil`, not an allocated closed channel); `Result.Err`
  is no longer unused - the maxLease force-expiry path is its first real
  writer/reader.

All of the above was re-verified: `gofmt -l .` clean, `go vet ./...`
clean, `go test ./... -race` passing (29 test cases, up from 20, across
`internal/{config,dedup,execrunner,server}`), `docker build` still
produces a working static binary, and `agent/deploy/kind/run-e2e.sh`
re-run end to end against a fresh `kind` cluster after the manifest
hardening - "T14 PASSED" again.

**No follow-up tasks spun off beyond the one named above (PID-1 orphan
reaping).** This package's own scope (6.12/6.13/6.14) is complete as
planned and hardened per review; 6.15 (`apps/worker` wiring this agent's
RPC into the real outer dispatch) remains open exactly as anticipated in
Scope, not as a newly-discovered gap.

## Review notes

Compared against the agreed plan (`docs/impl-plans/0010-exec-agent.md`,
`tests-agreed`) and the agreed test design, not a fresh read of the code:

- **Scope**: all three scope items (6.12, 6.13, 6.14) are covered by real,
  running code - `agent/main.go`+`internal/server`+`internal/execrunner`
  for 6.12, `build/Dockerfile`+`deploy/kind/` for 6.13, `internal/dedup`
  for 6.14. No scope item was left partially done.
- **The eight "open questions this package must make a call on"** are all
  reflected in the actual code: HTTP/JSON (not gRPC) in
  `internal/api`+`internal/server`; subprocess-scoped env-var secrets in
  `execrunner.buildEnv`; best-effort JSON `Output` parsing in
  `execrunner.Run`; `--state-dir`-rooted `Evict` in `server/evict.go`;
  in-memory TTL-bounded dedup in `internal/dedup`; no ADR-0012 TS
  conventions imported into this Go module; co-located `_test.go` files;
  `go.mod`'s `go 1.22.7` pin.
- **Test design**: all 14 planned cases (T1-T14) exist and pass -
  T1-T12 as Go unit/HTTP tests (`execrunner_test.go`, `server_test.go`,
  `dedup_test.go`), T13 as a manual `docker build`+`file` check recorded
  above, T14 as the real `kind`-cluster run recorded above. Nothing was
  silently downgraded to a weaker check than agreed.
- **Deviations**: both recorded above (the `busybox` base instead of
  `scratch`; the ServiceAccount poll-wait bugfix in the e2e script) -
  neither changes the plan's shape, both are implementation-level
  corrections of a detail the plan's prose didn't pin down precisely
  enough.
- No gaps found between what was agreed and what was built.

**Second pass: local code review (`/local-review-uncommitted`) and its
fix-up.** A local review of the uncommitted diff found real, high-
confidence issues the plan/test design above did not anticipate -
path traversal in `/evict`, argument injection in `execrunner`'s flag
translation, an unauthenticated RPC surface, a dedup-store entry that
could wedge forever if its leader died, a request-cancellation-kills-
subprocess bug, and several deploy-manifest/script hygiene gaps (see
"Post-review fixes" above for the full list and what changed). All
CRITICAL and WARNING findings were fixed; the one SUGGESTION-level
finding left unfixed (PID-1 orphan reaping) was a deliberate, reasoned
call - implementing it naively would have traded a real but bounded gap
for a worse, harder-to-diagnose one (`ECHILD` races against `os/exec`'s
own child-reaping) - and is recorded as a named follow-up rather than
silently dropped. New tests were added for every fixed CRITICAL/WARNING
item (auth enforcement, timeout validation, path-traversal rejection,
invalid-flag rejection, dead-leader force-expiry) and the full suite plus
the real `kind` e2e run were re-verified green after the fixes. This
package's Scope (6.12/6.13/6.14) is unchanged by this pass - it was a
correctness/hardening fix-up of already-in-scope code, not new scope.

**Third pass: design.md D17b (task 2.12/4.8's re-corrected scope) - a
clean override of the "Interfaces"/"Interaction with D17" sections
above, not an additive extension.** D17b splits D17/D17a's single
universal `--data-file <path> --state-id <key>` shape into three layers
(materialization mechanism, unconditional; a per-function DECLARED
`invocationDescriptor` - flag/positional/stdin; an opt-in per-function
`stateReuse` capability) so an onboarded service never needs to accept a
platform-invented CLI contract, only its own native one. This package's
concrete changes: `internal/api/types.go`'s `DataFile.Flag`/`StateID`
become optional (`json:",omitempty"`), `DataFile` gains
`StdinFromPath bool`, and `InvokeRequest` gains `PositionalArgs
[]string`. `internal/execrunner/execrunner.go`'s `buildArgs` no longer
renders `StateID` into argv AT ALL (D17b: purely platform-internal
bookkeeping, never exposed to the invoked subprocess - the concrete
difference from D17/D17a's old contract, where every service saw
`--state-id <key>` unconditionally whether it used it or not), appends
`PositionalArgs` as bare tokens after every flag, and skips a
`StdinFromPath` entry entirely when building argv; a new `stdinSource`
helper picks the subprocess's stdin (a `StdinFromPath` file's CONTENTS,
opened directly from its materialized local path, take priority over
`req.Stdin`'s raw bytes if both are somehow present). `evictHandler`
itself needed no change (see item 4 above). New tests:
`TestRun_positionalArgsAppendedBare`, `TestRun_stdinFromPathStreamsFileContents`;
`TestRun_dataFilesTranslatedToShape` was revised to assert `--state-id`
is NEVER rendered into argv, rather than asserting the old shape. Full
suite (`go test ./...`) re-verified green after the change. This
package's original Scope (6.12/6.13/6.14) is unaffected in shape - only
the wire contract these three tasks already implement changed, per the
onboarding-contract correction recorded in tasks.md 2.12/4.8 and
design.md D17b.
