# ADR-0005: Step dispatch is CLI-only; nested calls stay transport-flexible

## Status

Proposed

## Context

Two different axes were previously conflated under "dispatch":

- **Outer dispatch**: how the worker invokes the target container for a
  step the DSL actually declared. The original proposal states every
  service is dockerized with "REST API + CLI", but no prior decision fixed
  which of the two the *engine itself* uses for ordinary step execution -
  D17 only mandated CLI for functions specifically accepting heavy
  (dataset-scoped) bindings, as a named departure from D5's otherwise
  discover-don't-assume posture.
- **Inner dispatch (nesting)**: how a service, while executing, calls
  *other* registered services on its own initiative (D9b). This is already
  decided: `nesting_declaration: { via: sdk | http | cli | mcp, targets:
  enumerable | open }`, declared by the target's registry entry (D12),
  concretely bound at the calling DSL step. Task 1.9 already settled that no
  bespoke SDK is required - HTTP, CLI, and MCP are three thin projections of
  one platform-owned dispatch primitive that performs the tracked-child-
  execution insert.

## Decision

**Outer dispatch (this ADR's change): CLI, for every step, unconditionally.**
The worker invokes every step's target container via CLI - never REST -
regardless of whether that step's bindings are heavy or light. D17's
`--data-file <path> --state-id <key>` convention, previously scoped only to
functions declared to accept heavy CLI bindings, generalizes to **the
uniform binding-injection mechanism for every step**: light bindings pass as
ordinary CLI flags/arguments; heavy/dataset-scoped bindings (resolved to a
`Handle` per ADR-0004) pass via `--data-file`/`--state-id`. A registered
function's REST surface, if it has one, may still exist (e.g. for
Item-Pool-style external callers) but the engine never uses it to dispatch a
step.

**Inner dispatch (nesting): unchanged.** A service's own outbound calls to
other registered services remain governed entirely by D9b/D9c's existing
`nesting_declaration.via` model and the calling DSL step's own binding
(the user's `{ nested: http, ... }` shape) - this ADR does not touch that
axis at all, and no new IR construct is introduced for it.

```
   OUTER (this ADR)                    INNER (D9b/D9c, unchanged)
   worker -> step's own container      container -> another registered
   ALWAYS: CLI, --data-file/--state-id service, per nesting_declaration.via
                                        (sdk|http|cli|mcp), DSL-bound
```

## Rationale

Unifies materialization/injection at one physical layer (local filesystem
via volume/scratch path, not two parallel paths - REST-body injection for
some steps, CLI-file injection for others). This directly serves D1/D2/D4's
placement model: every pooled/warm container becomes uniformly addressable
as "a long-lived process the platform execs into," rather than half the
fleet being REST-warm (in-memory state) and half CLI-warm (on-disk state per
D17), which would have forced the placement/scheduler layer to carry two
materialization strategies indefinitely.

## Consequences and open sub-questions

**1. Pooling/preheating changes shape.** A pooled container can no longer be
modeled as "a Pod behind a Service answering HTTP requests" - it must be
modeled as "a long-lived Pod the platform execs into." D4a's promote/demote
(already anticipated by task 4.8) becomes: promote = start Pod + attach the
per-hash volume/scratch path *before* any invocation; demote = detach +
allow scale-to-zero. This applies to every step now, not only previously-
CLI-mandated ones.

**2. RESOLVED by ADR-0008 - the exec transport mechanism.** The worker
invokes a step's target container through an in-pod exec-agent (the
container's own entrypoint, injected by the platform, never a per-service
artifact) over an internal network RPC - not a `kubectl exec`-equivalent.
See ADR-0008 for the agent's contract (`Invoke`/`Evict`), its idempotency
model, and why this choice also resolves the KEDA-metrics concern (via
`@wfx/core`'s own queue depth, per ADR-0002) without needing anything from
the agent itself.

**3. RESOLVED by ADR-0008 - secrets injection.** The agent's `Invoke` RPC
*is* "the request" D7 rule 3 already describes (push-by-value, over
in-cluster TLS) - it simply replaced the HTTP body. The agent, not this
ADR, decides the OS-level delivery detail (tmpfs file, stdin, or a
per-exec-call-scoped env var) for the lifetime of one subprocess call. See
ADR-0008's "Secrets" section.

**4. D17's capability metadata is now moot as a discovered axis, in exactly
the way D17 already anticipated.** D17 already states that because the CLI
heavy-data convention is *mandated*, not discovered, D5's per-function
capability metadata is unaffected - it never needed to capture "transport
shape" as a new discovered-capability axis. This ADR extends the mandate
from "CLI-invoked heavy-data functions" to "every step," which is a wider
mandate of the same already-accepted shape, not a new kind of exception.

## Alternatives considered

- **Keep REST as the outer-dispatch default, CLI only for declared-heavy
  functions (status quo per D17).** Rejected per this change: it leaves two
  parallel materialization/pooling strategies live indefinitely, and the
  heavy-data injection pattern (which already has to exist per D17) is a
  strictly more general mechanism than REST-body injection, so maintaining
  both is unjustified duplication once the more general one is mandatory
  anyway.
- **Make the outer-dispatch transport itself a per-function discovered or
  declared capability (mirroring `nesting_declaration.via`).** Rejected:
  this is exactly the "transport shape as a new discovered-capability axis"
  that D17 already argued against for the heavy-data case specifically to
  avoid per-service inconsistency in how pooling/preheating behaves; fixing
  it platform-wide removes an entire axis of variation the scheduler would
  otherwise have to account for.
