# ADR-0008: In-pod exec-agent realizes step dispatch

## Status

Proposed

## Context

ADR-0005 mandates that the worker invoke every step's target container via
CLI, never REST, and named two open questions rather than resolving them:
the mechanism by which a worker actually performs that CLI invocation
against a remote pod, and how D7's per-request secret injection works once
there is no HTTP body to push a resolved secret into. This ADR resolves
both by settling on a shape for the invocation mechanism, from which an
answer to the secrets question falls out directly rather than needing a
separate decision.

Two candidates were on the table: a true `kubectl exec`-equivalent (the
Kubernetes exec subresource), or an in-pod thin agent the worker talks to
over the network. The exec-subresource path carries real per-call overhead,
RBAC-at-scale friction, and an awkward fit with KEDA's typically HTTP/
queue-shaped scaling metrics. The in-pod-agent path was explored further and
is the one this ADR adopts.

## Decision

**Shape: the agent is the container's entrypoint (PID 1), not a sidecar
container.** Kubernetes does not let one container exec into a sibling
container's process/filesystem namespace without privileged tricks
(`shareProcessNamespace`, hostPID). The agent must therefore run *in* the
same container as the CLI binary it invokes.

**Injection: an init-container + shared `emptyDir` + a Pod-template command
override, entirely platform-controlled.** A platform-authored init-container
copies a static agent binary onto a shared `emptyDir`; the platform's own
deployment templating (never the service author's Dockerfile) overrides the
Pod's command to `/platform/agent --listen :9464 --exec <original-
entrypoint>`. The agent becomes PID 1 and fork/execs the CLI binary the
service author already shipped, on request. This works regardless of a
service's base image and requires no cooperation from the service author
beyond what D12/D17 already mandate (a registered image, an OpenAPI
contract, a CLI entrypoint) - "invisible to the service author," the same
phrase D17 already uses for the heavy-data transport mechanism.

**This does not violate ADR-0005's CLI mandate.** The agent's own control
channel (worker -> Pod, over the cluster network, gRPC/HTTP-internal-only)
is plumbing, not a second business-logic REST API. The unit of work
performed is still "run the CLI binary" - ADR-0005 constrains the *logical
invocation contract*, not the wire protocol carrying the instruction to
invoke it.

### The contract: two verbs

```
Invoke(request) -> response

InvokeRequest {
  executionId, stepId          # the idempotency key - see below; the SAME
                                # tuple as checkpoints' UNIQUE(execution_id,
                                # step_id), never a separately-invented id
  function: string               # registry function name
  args: { flagName -> value }    # light bindings, already resolved (ADR-0004)
  dataFiles?: [{                 # OPTIONAL - see "Interaction with D17" below
    flag: "--data-file", path: <mounted path>, stateId: <content hash>
  }]
  secrets?: [{ name, value }]     # pushed BY VALUE over the TLS-secured
                                  # internal channel - see "Secrets" below
  stdin?: bytes
  timeoutMs: number               # platform-managed default (D8d) - never
                                  # a DSL-authored field
}
InvokeResponse {
  status: "ok" | "error" | "timeout"
  stdout, stderr, exitCode
  output: <parsed per the function's OpenAPI response shape>
}

Evict(stateId) -> ack

  Cleans up LOCALLY-held state for a state-id on demote (D4a). Only
  needed when local state lives on the container's own writable layer
  (D17's "worker-written local scratch file" option) - see "Interaction
  with D17" below for why a per-hash CSI volume needs no such call.
```

### Idempotency and crash semantics

The agent's local idempotency key is **exactly `(executionId, stepId)`** -
the same tuple that makes the `checkpoints` table's `UNIQUE` constraint work,
not a separately invented invocation id. This is enforced at two layers for
two different failure windows:

```
WINDOW A - agent finishes, worker crashes before writing the checkpoint.
  Recovery re-claims the execution, sees no checkpoint, RE-INVOKES. The
  side effect may genuinely run twice. SAFE for mutations over content-
  addressed state (D2: identical inputs -> identical resulting hash, so a
  duplicate run wastes work but cannot corrupt or diverge). NOT NEW risk
  for non-deterministic side effects (external calls using a secret) -
  D7 rule 6 already excludes exactly this class from memoization because
  it is a non-deterministic side effect; this ADR inherits that already-
  accepted risk rather than introducing a new one.

WINDOW B - worker crashes WHILE the agent is still mid-exec (no response
  sent yet). The subprocess keeps running; the agent doesn't know its
  caller died. A new worker sends a fresh Invoke for the SAME
  (executionId, stepId). The agent's LOCAL dedup (independent of
  Postgres) recognizes the in-flight invocation and attaches to / awaits
  its result rather than starting a second subprocess.

WINDOW C - the agent completed and responded, but the response was lost
  in transit and no checkpoint was written. Same recovery path as
  Window B: a bounded-TTL local result cache serves the cached response.
  This is a latency/robustness nicety only - Postgres's checkpoint
  remains the actual source of truth; if the local cache has expired
  (e.g. the pod restarted), the checkpoint-check-before-invoke rule
  below is what actually prevents re-invocation.
```

**The interpreter checks for an existing checkpoint before calling
`Invoke` at all** - checkpoint presence is the real, durable idempotency
gate (per the existing `executions`/`checkpoints` pattern); the agent's
local dedup only covers the narrower, purely-in-pod race between "still
running here" and "a second caller showed up asking for the same work."

### Interaction with D17's state-id-keyed local disk reuse

D17 already lets a CLI function persist local state keyed by `state-id` and
reuse it on a later call without re-reading `--data-file`. Tracing this
through the agent:

- **The agent stays deliberately dumb about state-ids.** Deciding whether
  a given pod already has `state-id` X warm (so `--data-file` can be
  omitted) is `@wfx/scheduler`'s job - that is what "pinned" already means
  under D4a. The agent never tracks state-ids itself; it only passes
  through whatever flags the worker sends. `dataFiles` is optional in the
  RPC precisely so the caller can omit it on a warm hit.
- **Demotion cleanup forks on where local state actually lives**, which
  determines whether `Evict` is ever called:
```
  (a) A per-hash CSI volume, attached/detached by Kubernetes itself at
      promote/demote (D17's first-named mechanism). The agent is
      entirely oblivious; Evict is never invoked for this path.
  (b) A worker-written local scratch file on the container's own writable
      layer (D17's fallback option). Only the agent, running inside that
      container, can remove it - this is exactly what Evict(stateId) is
      for, called on demote.
```

### Secrets: resolved by relocating "the request," not by a new rule

D7 rule 3 already permits push-by-value "into the request payload (over
in-cluster TLS)" because services are trusted and non-caching. The agent's
`Invoke` RPC **is** that request now, in place of an HTTP body. The worker
pushes the resolved secret value into the RPC's `secrets` field over the
TLS-secured internal channel; the agent - itself platform-authored, trusted,
non-caching, arguably more trusted than the service it wraps - is
responsible for the actual OS-level delivery for the lifetime of that one
`exec()` call (a tmpfs-backed file, stdin, or an env var scoped to the
subprocess only, never the container's whole lifetime, which D7 rule 2
forbids) and discards it once the subprocess exits. No new secrets policy
is introduced; D7's existing rules apply unchanged at a relocated boundary.

### Autoscaling metrics fall out of D6's consolidation, not the agent

KEDA ships a native PostgreSQL scaler. `@wfx/core`'s `executions` table
(ADR-0002) already carries the queue-depth signal KEDA needs (count of
`queued`/`blocked` executions per service digest) - autoscaling reads
Postgres directly and needs no in-pod metrics endpoint from the agent at
all. This is a direct consequence of the D6 consolidation decision, not an
extra mechanism this ADR has to add.

### Placement/affinity routing reuses D4 as-is

The worker addresses a *specific pinned replica's* agent using the content-
hash -> replica-id mapping `@wfx/core`'s placement table already tracks
(D4), via direct Pod IP or a headless Service's per-pod DNS name, falling
back to any replica behind a normal Service on a miss - exactly D4's
existing "affinity is an optimization; rehydrate anywhere on fallback" rule.
No new routing mechanism is introduced.

## Consequences

- `apps/worker` depends on this agent's RPC contract to perform ADR-0005's
  outer dispatch; the agent itself ships as a small, platform-owned static
  binary plus an init-container image, not a per-service artifact.
- The two ADR-0005 open questions (exec mechanism, secrets injection) are
  resolved by this ADR rather than left open.
- `Evict` only matters for the local-scratch-file fallback path; if the
  platform standardizes on per-hash CSI volumes for all promoted state,
  `Evict` may end up unused in practice - it is kept in the contract because
  D17 names the scratch-file fallback as a real, not merely hypothetical,
  option.
- Window A's inherited at-least-once risk for non-deterministic side
  effects is not solved here and is not this ADR's job to solve - it is
  named explicitly so it is not mistaken for a gap introduced by the agent
  shape itself.

## Alternatives considered

- **K8s exec subresource (`kubectl exec`-equivalent).** Rejected: real
  per-call overhead, RBAC-at-scale friction, and no natural fit with a
  Postgres-backed KEDA scaler the way the agent's existence has none of
  those costs.
- **Sidecar container instead of entrypoint.** Rejected: Kubernetes does
  not permit one container to exec into a sibling container's namespace
  without privileged Pod-level settings; running as the entrypoint avoids
  that entirely.
- **A shared base image every service must derive from, instead of
  init-container injection.** Rejected: would impose a real onboarding
  requirement beyond what D12/D17 already mandate, and would fail for any
  service whose Dockerfile doesn't derive from the platform's base image.
- **A separate invented invocation id for agent-level dedup, distinct from
  `(executionId, stepId)`.** Rejected: the checkpoints table already
  defines the correct uniqueness boundary; reusing it keeps the durable and
  local dedup layers conceptually identical instead of two parallel ideas
  that could drift.
