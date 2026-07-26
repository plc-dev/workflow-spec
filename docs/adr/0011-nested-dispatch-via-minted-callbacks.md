# ADR-0011: Nested dispatch via minted, per-invocation callback references

## Status

Proposed

## Context

`docs/adr/0008` settles the **target side** of dispatch: how the engine invokes any step's target container (CLI, via the in-pod exec-agent). It does not settle the **caller side** for D9b's nesting case: how a service, while executing, actually reaches the platform's orchestrator-aware dispatch path (D9b/D9c) rather than a target's raw endpoint, and what that looks like concretely from inside the service's own code.

Working through concrete examples surfaced that a naive "generic dispatch endpoint, caller specifies the target in the request body" design (considered and rejected here) has two problems: it requires the calling service's own code to have platform-specific awareness (construct an envelope naming a target, read a generic platform URL/token), and it lets the caller assert its own identity/target rather than having the platform derive it authoritatively. A second, harder case then surfaced: a service (`X.1`) that accepts a **generic, platform-agnostic callback-URL parameter** - the ordinary "give me a URL, I'll POST my own job result to it" pattern many APIs already have, authored with zero awareness of this platform - and the question of how a workflow-writer could ever bind such a parameter to a platform-dispatched target, and how compatibility between the two would even be knowable.

## Decision

### Two nesting-call shapes, matching D9c's existing enumerable/open split

```
CASE 1 / 1b (deterministic) <-> D9c "targets: enumerable"
  The reachable target(s) are statically known at DSL-binding time - one
  target per nesting-slot parameter (1), or several independent
  nesting-slot parameters the calling service's own ordinary code chooses
  among (1b). Not a new case: 1b is 1, applied to more than one parameter.

CASE 2 (agentic/non-deterministic) <-> D9c "targets: open"
  The reachable set is bounded by an allowlist, but which member is
  called, how many times, and with what arguments is decided by the
  service's own runtime logic (e.g. an LLM tool-calling loop).
```

No third shape was found - looping, chaining, and non-agentic conditional target selection are all realized as multiple, independent applications of Case 1's mechanism, not a new mechanism.

### Case 1/1b: minted, single-purpose, per-invocation callback references

At binding-resolution time (extending `docs/adr/0004`'s resolver-per-kind model with a new resolution behavior, not a new execution plan construct), a nesting-target-shaped parameter's literal binding (D9c's existing "concrete nesting target supplied as an ordinary DSL binding") resolves **not to its literal value directly, but to a freshly minted, opaque, single-purpose callback reference** (a URL), delivered to the CLI invocation as an ordinary resolved parameter, exactly like any other binding value:

```
--enrich-target-url https://dispatch.internal/cb/f7a2b9...
```

The opaque id (`f7a2b9...`) maps **server-side only** - never asserted by the caller - to `(parentExecutionId, parentStepId, target service, target function, remaining governor budget)`. This is a direct application of the same principle D7 already established for secrets: resolve fresh, per-invocation, injected as an ordinary parameter, never a durable/reusable credential.

The callback endpoint (`dispatch-api`) behaves **synchronously** from the caller's point of view: the calling service's own code issues an ordinary blocking POST and receives the target's real result inline. Internally, `dispatch-api` resolves the callback id server-side, checks the governor's durable budget (D9c), and calls the **same internal dispatch primitive** the engine already uses for its own map/branch fan-out (D9c/task 1.9's "one dispatch primitive") - an ordinary tracked-child-execution insert, claimed and CLI-dispatched to the target's own exec-agent exactly like any top-level step. The request body contains only the target function's own native parameters - nothing identifying the target, since the URL itself is the disambiguator. This is what makes the calling service's own code indistinguishable, from its own perspective, from calling an ordinary external webhook.

**Case 1b** (multiple independent nesting slots on one function) is the same mechanism applied per parameter - each slot gets its own independently minted callback reference; there is no shared/generic dispatch endpoint and no target-identifying field is ever needed in any request body.

### The `X.1`/`c` case: reuse OpenAPI's own `callbacks`/`webhooks` object, not a platform-invented type

A parameter like `c` - a plain, generically-typed callback-URL parameter, authored with no platform awareness - carries no signal by itself that it's nesting-shaped. The fix is to make the calling function's **own OpenAPI operation** declare its outbound contract using OpenAPI's existing `callbacks` (or 3.1 `webhooks`) object - documenting exactly the request/response schema it will use when it invokes that parameter. This requires no new registry field (D12's "OpenAPI is the sole stored contract" already covers it) and works for services that were never designed with this platform in mind.

The workflow-writer binds `c` exactly like any other nesting-target parameter (`literal: { service, function }`); compile-time validation (extending the existing generic required-parameter rule, `workflow-dsl` capability) checks that the bound target function's **own native input/output schema exactly satisfies** the declared `callbacks` contract.

**Reject-only, no adapter.** If a candidate target's native schema does not exactly match the declared callback contract, the workflow-spec is rejected at compile time - deliberately, for simplicity. No `compute`-based reshaping layer and no dedicated adapter-service escape hatch bridges a mismatch. This is a real, accepted limitation: semantically-compatible services that differ superficially in field names/shape are not bindable here without first aligning their schemas upstream.

### Case 2 (open/agentic): a resolved MCP address, not a bespoke protocol

The equivalent mechanism for the open case is a per-invocation, allowlist-scoped **MCP server address plus credential**, delivered as an ordinary resolved parameter (the same delivery principle as Case 1's callback URL). The agent-runner service uses off-the-shelf MCP client tooling to reach it - genuinely agnostic, since this is identical to how it would talk to any compliant MCP server, platform-owned or not. This does not change D9c's existing MCP-gateway design (tool definitions already scoped per invocation); it only makes explicit that the gateway's address is delivered the same way any other resolved binding is.

### What remains non-agnostic, deliberately

D9b's declared-exception bypass path is unaffected by this ADR and remains the one nesting path that is not agnostic: it is a direct, raw, container-to-container call that never goes through a minted callback, and it forfeits tracking/secret-scoping/governor-accounting exactly as D9b already states. Losing agnosticism there is one more forfeited guarantee alongside the ones already named, not a new gap.

## Consequences

- `apps/dispatch-api`'s real shape is per-callback (`/v1/callbacks/{callbackId}`), not a generic dispatch endpoint accepting a caller-specified target - this is a stronger security posture (never trust caller-asserted routing/identity) than the alternative considered and rejected below.
- No bespoke SDK is needed for the enumerable case (reaffirms task 1.9) - a calling service issues one ordinary HTTP POST (or, for `via: cli`, shells out to a tiny platform-injected client performing the same POST) to a URL it was handed as a parameter.
- Compile-time validation gains a new responsibility: schema-compatibility checking between a declared `callbacks` contract and a bound target's native schema, reject-only.
- A real, accepted limitation: no adapter/transform layer exists for near-but-not-exact schema matches; this may be revisited later if it proves too restrictive in practice, but is not being solved now.

## Alternatives considered

- **A generic dispatch endpoint with a caller-specified target in the request body** (the model this ADR supersedes). Rejected: requires the calling service's own code to carry platform-specific envelope-construction logic, and lets the caller assert identity/target rather than having the platform derive it authoritatively from a credential it minted itself.
- **A platform-invented "nesting target reference" OpenAPI type as the sole compatibility signal.** Rejected in favor of reusing OpenAPI's own standard `callbacks`/`webhooks` object - more general, and works for services (like `X.1`) that were never authored with this platform in mind, not only ones deliberately built against a platform-specific type.
- **An adapter/transform layer (a `compute` binding or a dedicated utility service) bridging schema mismatches.** Rejected for now, per explicit direction, to avoid adding a new DSL usage pattern (compute as an inter-contract adapter) that wasn't designed for; revisit only if reject-only proves too restrictive in practice.
