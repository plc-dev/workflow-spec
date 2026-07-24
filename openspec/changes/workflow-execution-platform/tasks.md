## 1. Foundations & spikes

- [ ] 1.1 Confirm COW/incremental-snapshot capability for the SQL-execution service end to end (proof of concept)
- [ ] 1.2 Spike the SQL-session scenario against Restate, using its Virtual Objects in placement-bookkeeping-only mode (no service rewrites), per design.md D6's revised recommended next step (spike this first)
- [ ] 1.2a Spike the same scenario against Dapr (Workflows + Actors), likewise in placement-bookkeeping-only mode; treat full actor-hosting (rewriting a service to embed the Dapr Actor SDK) as a stretch comparison, not a requirement
- [ ] 1.2b Spike a Temporal-shaped engine + a hand-built placement-resolver for R11 as the fallback/baseline comparison (path a, design.md D6), deprioritized relative to 1.2/1.2a per D6's revised recommendation
- [ ] 1.2c Spike a Postgres-native path (Hatchet, or adopting/forking a documented pattern such as resonate-pg) against the same scenario, specifically testing whether the placement-resolver (1.10) and session log (3.1) can share one Postgres instance with the durability layer (path f, design.md D6)
- [ ] 1.2d Lightweight evaluation of Conductor (Orkes): how directly its native MCP gateway (Agentspan) and declarative workflow format could serve D9c and the IR-to-engine compilation step (5.10), before committing to a full spike (path e, design.md D6)
- [ ] 1.4 Decide the execution engine (design.md D6, open question) - resolve alongside 1.6 (secrets-broker fit, e.g. Dapr's native Secrets API) and 1.9 (composability cost), since both depend on the engine chosen
- [ ] 1.5 Spike compiling a trivial hand-written workflow-spec into a generic, engine-agnostic IR interpreter targeting whichever engine is selected in 1.4
- [ ] 1.6 Select a secrets-broker product against the broker-agnostic model in design.md D7 (open question)
- [ ] 1.7 Decide and document the concrete authoring-surface syntax/grammar (open question from design.md D8)
- [ ] 1.8 Spike a dynamic map/forEach construct against the engine selected in 1.4 (design.md D8/D9)
- [ ] 1.9 Decide the service-composability policy (deferred, design.md D9): SDK-mediated only vs. permitting direct HTTP/CLI/MCP transports - resolve alongside 1.4
- [ ] 1.10 Design the placement-resolver/routing mechanism (design.md D4/D6 Open Questions): bespoke resolver, service-mesh consistent-hash policy, or a native engine primitive, depending on the outcome of 1.4

## 2. Registry & service capability metadata

- [ ] 2.1 Extend the OpenAPI/registry schema to carry per-function capability metadata: mutates, materialization-cost-class, COW-support, change-detection-support
- [ ] 2.2 Add registry validation for capability metadata (schema-level checks)
- [ ] 2.3 Backfill capability metadata for existing service images
- [ ] 2.4 Define conformance checks/tests to validate declared capabilities against actual service behavior (trust boundary from design.md)
- [ ] 2.5 Implement capability declaration trust tiers keyed to image digest (unverified / conformance-passed / production-proven, design.md D5a)
- [ ] 2.6 Gate conformance re-checks into CI/CD on every service redeploy, not just first registration (design.md D5a)
- [ ] 2.7 Implement a continuous runtime invariant checker sampling shared/immutable bindings for cross-caller divergence, with auto-demotion + alerting on violation (design.md D5a)

## 3. Session & state layer

- [ ] 3.1 Implement durable session input-history log (append-only, per session) - evaluate whether this can be built directly on the selected engine's own durable execution history (design.md D3 note) rather than as separate infrastructure
- [ ] 3.2 Implement content-addressed snapshot store (hash of base + operations -> snapshot)
- [ ] 3.3 Implement linear snapshot chain construction per session
- [ ] 3.4 Implement copy-on-write materialization path for COW-capable services
- [ ] 3.5 Implement full-copy fallback materialization path for non-COW services
- [ ] 3.6 Implement TTL-based snapshot garbage collection
- [ ] 3.7 Implement snapshot rebuild-from-history path (for GC'd snapshots)
- [ ] 3.8 Implement (base, operation) -> output memoization cache and lookup path
- [ ] 3.9 Wire change-detection signal from service responses into chain-advancement logic
- [ ] 3.10 Implement session rewind (pointer movement) with truncation-on-new-mutation (design.md D3a)
- [ ] 3.11 Implement configurable checkpoint interval for intermediate snapshot retention, defaulting to full-chain-for-session-lifetime (design.md D3a)

## 4. Scheduler / placement layer

- [ ] 4.1 Implement placement decision service that fuses capability metadata, DSL intent, and runtime observations
- [ ] 4.2 Implement shared read-only placement path for static/immutable bindings
- [ ] 4.3 Implement affinity hinting (prefer a warm replica) with fallback-to-any-replica rehydration, using the routing mechanism from 1.10
- [ ] 4.4 Implement adaptive residency promotion (unpinned -> pinned) based on observed size/frequency
- [ ] 4.5 Implement promotion/demotion thresholds per design.md D4a's cache-admission model, exposed as tunable scheduler parameters (starting defaults, not fixed constants)
- [ ] 4.6 Implement capacity-aware LRU eviction among pinned entries when the pinned-residency budget is exceeded (design.md D4a)
- [ ] 4.7 Wire trust-tier gating (2.5) into placement decisions - never share/pool/COW-reuse below production-proven (design.md D5a)

## 5. Workflow DSL

- [ ] 5.1 Define the IR schema (steps, bindings, write targets, secret refs, outputs) per design.md D8 - engine-agnostic
- [ ] 5.2 Implement an authoring-surface-to-IR compiler for the syntax chosen in 1.7
- [ ] 5.3 Implement validation against the registry (reject unknown service/function references) at IR-compile time
- [ ] 5.4 Implement data-binding syntax for user/static/session source references
- [ ] 5.4a Implement the `sessionState` declaration block (interactivity + fallback, declared once per key, resolved by every binding referencing that key) per design.md D8a
- [ ] 5.5 Implement scope/mutable declaration syntax per binding, and `writes` declarations gated by change-detection
- [ ] 5.6 Implement dependency-graph inference from step-output bindings, plus an explicit `dependsOn` ordering escape hatch
- [ ] 5.6a Implement the restricted-YAML/JSON parser + JSON Schema validation (no anchors/aliases/merge keys/custom tags; camelCase fields) per design.md D8a
- [ ] 5.6b Implement the `{from: item}` binding source for map/forEach bodies
- [ ] 5.6c Implement flat request-parameter binding validation (reject any dotted/nested path at the binding-source level)
- [ ] 5.6d Implement the dataset URN parser/resolver (namespace/name, tag-or-digest) and stand up the dataset resource catalog (tag → digest → storage location), distinct from the container/OCI registry
- [ ] 5.6e Implement OCI reference validation for pinned service-version calls, rejecting dataset URNs used in that position and vice versa
- [ ] 5.7 Implement `branch` construct (statically enumerated cases, dynamically selected)
- [ ] 5.8 Implement `map`/`forEach` construct (statically shaped body, dynamically sized cardinality)
- [ ] 5.9 Implement derived workflow-signature generation and publish it through the registry/discovery mechanism
- [ ] 5.10 Implement IR-to-execution-engine compilation targeting the generic interpreter from 1.5, once the engine is selected (1.4)
- [ ] 5.11 Choose JSON-Logic vs. CEL against real branch/map cases (open question, design.md D10)
- [ ] 5.12 Implement `compute` binding evaluation (in-interpreter, no step-execution scheduling, no secret inputs permitted)
- [ ] 5.13 Implement the IR version tag and lazy forward-only migration chain per design.md D11
- [ ] 5.13a Implement fail-closed handling for documents newer than the reader understands (design.md D11)
- [ ] 5.13b Define the minimum supported version window and the migration-sweep process required before retiring an old migrator (design.md D11)
- [ ] 5.14 Implement the generic "step binding satisfies every required parameter" validation rule (design.md D9c relies on this instead of an agent-specific construct)

## 6. Execution engine

- [ ] 6.1 Stand up the selected execution engine's runtime environment for development, once decided (1.4)
- [ ] 6.2 Implement a generic execution-engine interpreter that executes a compiled workflow-spec (IR)
- [ ] 6.3 Implement step-execution handling for spawn-per-call (World 1) execution
- [ ] 6.4 Implement step-execution handling for warm-pooled-service (World 2) invocation
- [ ] 6.5 Implement session-as-long-running-execution pattern with event/signal-driven user actions
- [ ] 6.6 Configure native retry/backoff/timeout policies per step
- [ ] 6.7 Implement step-level memoization skip using the cache from 3.8
- [ ] 6.8 Implement a narrow "run as a spawned job" step type for delegating select World-1 steps to a secondary backend (e.g. Kubernetes Jobs), if the selected engine benefits from this delegation
- [ ] 6.9 Implement dynamic child/step execution for `map` constructs (parent continues without terminating; independent per-child retry)
- [ ] 6.10 Implement scheduler pre-analysis of all statically declared branch cases and map-iteration shapes ahead of execution
- [ ] 6.11 Implement bounded agent-directed step execution: allowlist enforcement, governor enforcement, durable/resumable multi-round tool-calling loop

## 7. Autoscaling & pooling

- [ ] 7.1 Define KEDA scaling rules per service based on invocation/queue metrics
- [ ] 7.2 Implement pre-warmed pool management per service
- [ ] 7.3 Implement pooled-instance reuse gating (provably stateless OR scoped to a content hash before reuse)
- [ ] 7.4 Implement scale-in protection for instances pinned to actively-used session state

## 8. Integration & validation

- [ ] 8.1 End-to-end test: static, immutable dataset shared and pooled across concurrent workflow instances
- [ ] 8.2 End-to-end test: session mutates data, chain advances, isolation from other sessions verified
- [ ] 8.3 End-to-end test: worker failure mid-workflow, resume without duplicate side effects
- [ ] 8.4 End-to-end test: warm replica unavailable, rehydration path serves the request correctly
- [ ] 8.5 End-to-end test: snapshot GC'd then rebuilt from session history on demand
- [ ] 8.6 Load test: demand spike triggers autoscaling without violating isolation guarantees
- [ ] 8.7 End-to-end test: map construct over a runtime-sized collection, with one iteration failing and retrying independently
- [ ] 8.8 End-to-end test: branch construct selects correct case at runtime; scheduler pre-analysis covers all declared cases
- [ ] 8.9 End-to-end test: agent-directed step refuses a call outside its allowlist and stops at its governor limit
- [ ] 8.10 End-to-end test: session rewind followed by a new mutation discards the abandoned forward tail (design.md D3a)
- [ ] 8.11 End-to-end test: an unverified service build is never shared/pooled even when it declares COW support; promotion after conformance passes (design.md D5a)
- [ ] 8.12 End-to-end test: an older IR document migrates on open; a too-new document fails closed (design.md D11)

## 9. Secrets management

- [ ] 9.1 Define secret scope model (writer / user) and reference syntax in the DSL
- [ ] 9.2 Integrate a broker-agnostic secrets store interface (concrete product from 1.6)
- [ ] 9.3 Implement worker-side, in-step-execution secret resolution (references only in durable history)
- [ ] 9.4 Implement per-request injection into service invocations (no env-var binding)
- [ ] 9.5 Bind user-secret lifetime to session TTL with reference re-resolution on replay
- [ ] 9.6 Add payload-at-rest encryption (if the selected engine offers a codec hook) and log redaction
- [ ] 9.7 Exclude secret-consuming external calls (including LLM/agent API calls) from the memoization cache (wire into 3.8)
- [ ] 9.8 End-to-end test: pooled container serving different workflows never observes a foreign secret

## 10. Service composability

- [ ] 10.1 Implement composite registry entries: publish a workflow-spec's derived signature as an invocable entry alongside leaf services (design.md D9a)
- [ ] 10.2 Extend capability metadata (2.1) with a `composes: { via: sdk|http|cli|mcp, targets: [...] | open }` field (design.md D9b)
- [ ] 10.3 Implement the mandatory-by-default orchestrator-aware composition path for services that declare `composes`
- [ ] 10.4 Implement the declared-exception path for services that bypass the orchestrator-aware path, wired into trust-tier review (2.5-2.7, design.md D5a/D9b)
- [ ] 10.5 Implement dispatch-time allowlist enforcement and secret withholding for open-target composing services (design.md D9c)
- [ ] 10.6 Implement the durable governor counter (count/cost/timeout), checked before each dispatch, surviving crash-and-resume (design.md D9c)
- [ ] 10.7 Exempt pure `compute`-backed tools from allowlist review (design.md D9c)
- [ ] 10.8 Implement the MCP gateway: translate an invocation's allowlisted OpenAPI operations into scoped MCP tool definitions, routing calls through 10.5/10.6 (design.md D9c)
- [ ] 10.9 End-to-end test: a composite registry entry invoked as a step executes as a tracked child execution with full guarantee coverage
- [ ] 10.10 End-to-end test: an agent-runner service (`composes: {via: mcp, targets: open}`) refuses an out-of-allowlist call and halts at its governor limit, surviving a mid-loop crash without resetting the counter
- [ ] 10.11 End-to-end test: an undeclared direct-transport bypass is detected and treated as a capability-declaration violation (design.md D5a)
