## 1. Foundations & spikes

- [ ] 1.1 Confirm COW/incremental-snapshot capability for the SQL-execution service end to end (proof of concept)
- [ ] 1.2 PRIMARY, DEEPEST SPIKE: the SQL-session scenario against a Postgres-native path (Hatchet, or adopting/forking a documented pattern such as resonate-pg), explicitly testing whether the placement-resolver (1.10) and session log (3.1) can genuinely share one Postgres instance with the durability layer - i.e. testing the 4-way infra-consolidation claim itself, not just baseline durability (path f, design.md D6) - per D6's narrowed recommended next step (spike this first)
- [ ] 1.2a NARROW, TARGETED SPIKE: Restate, scoped ONLY to validating per-key serialized access against D3's linear-per-session-mutation requirement - not a full parallel build-out of the SQL-session scenario - per design.md D6's narrowed recommendation
- [ ] 1.2b Spike a Temporal-shaped engine + a hand-built placement-resolver for R11 as the fallback/baseline comparison (path a, design.md D6), deprioritized relative to 1.2/1.2a per D6's narrowed recommendation
- [ ] 1.2c (Deferred, not actively spiked) Dapr (Workflows + Actors) in placement-bookkeeping-only mode - documented as a fallback per design.md D6; only spike if 1.2 and 1.2a together surface a blocker neither resolves. Its main differentiator (a native Secrets API) is a nice-to-have against an already-decided, broker-agnostic D7, not something a spike needs to validate to make progress
- [ ] 1.2d Lightweight evaluation of Conductor (Orkes): how directly its native MCP gateway (Agentspan) and declarative workflow format could serve D9c and the IR-to-engine compilation step (5.10), before committing to a full spike (path e, design.md D6)
- [ ] 1.4 Decide the execution engine (design.md D6, open question) - resolve alongside 1.6 (secrets-broker fit, e.g. Dapr's native Secrets API) and 1.9 (composability cost), since both depend on the engine chosen
- [ ] 1.5 Spike compiling a trivial hand-written workflow-spec into a generic, engine-agnostic IR interpreter targeting whichever engine is selected in 1.4
- [ ] 1.6 Select a secrets-broker product against the broker-agnostic model in design.md D7 (open question)
- [ ] 1.7 Produce the formal JSON Schema for the authoring-surface grammar decided in design.md D8a/D8c (step invocation, secrets, `literal` bindings, and `branch`/`map`'s `yields` mechanism) - no further open syntax decisions remain, this is transcription/tooling work
- [ ] 1.8 Spike a dynamic map/forEach construct against the engine selected in 1.4 (design.md D8/D9)
- [ ] 1.9 Decide the service-nesting policy (deferred, design.md D9): SDK-mediated only vs. permitting direct HTTP/CLI/MCP transports - resolve alongside 1.4
- [ ] 1.10 Design the placement-resolver/routing mechanism (design.md D4/D6 Open Questions): bespoke resolver, service-mesh consistent-hash policy, or a native engine primitive, depending on the outcome of 1.4

## 2. Service registry

- [ ] 2.1 Design and build the service-registry metadata index (design.md D12): per-image-digest OpenAPI contract as the sole stored contract (CLI/MCP surfaces projected from it, never stored separately), `oci_ref` pointer into a standard OCI-compliant registry (byte storage itself deferred)
- [ ] 2.1a Extend the entry schema to carry per-function capability metadata: mutates, materialization-cost-class, COW-support, change-detection-support (design.md D5)
- [ ] 2.1b Extend the entry schema to carry per-image hardware requirements (cpu/mem/gpu/node-class), explicitly outside the capability trust-tier model (design.md D12)
- [ ] 2.1c Extend the entry schema to carry a per-function `nesting_declaration` (transport + enumerable/open targets) recording only the possibility of nesting, not the concrete bound target (design.md D9b/D12)
- [ ] 2.2 Add registry validation for capability/hardware/nesting metadata (schema-level checks)
- [ ] 2.3 Backfill capability, hardware, and nesting metadata for existing service images
- [ ] 2.4 Define conformance checks/tests to validate declared capabilities against actual service behavior (trust boundary from design.md)
- [ ] 2.5 Implement capability declaration trust tiers keyed to image digest (unverified / conformance-passed / production-proven, design.md D5a)
- [ ] 2.6 Gate conformance re-checks into CI/CD on every service redeploy, not just first registration (design.md D5a)
- [ ] 2.7 Implement a continuous runtime invariant checker sampling shared/immutable bindings for cross-caller divergence, with auto-demotion + alerting on violation (design.md D5a)
- [ ] 2.8 Implement an atomic `getPlacementFacts(digest, function)` read returning capability metadata, trust tier, and hardware requirements together, so callers never observe them skewed relative to one another (design.md D12)
- [ ] 2.9 Implement digest-pinned resolution for workflow-spec step bindings at authoring time (design.md D12)
- [ ] 2.10 Implement privilege-split write paths: `registerImage` reachable only by platform developers; `recordTrustTier` reachable by the workflow platform's own conformance pipeline, not requiring developer involvement per update (design.md D12)
- [ ] 2.11 Design the deferred re-pin/upgrade flow for moving an already-authored binding to a newer image digest (design.md D12, noted as a real but not-yet-designed affordance)

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
- [ ] 5.6d Implement the dataset URN parser/resolver (namespace/name, tag-or-digest) and stand up the dataset resource catalog: a thin tag→digest→object-key index backed by dedicated object storage (design.md D8b) - distinct from the container/OCI registry, and not itself an artifact-registry client
- [ ] 5.6d-i Select the specific object storage product (S3/GCS/MinIO-compatible) for dataset bytes (open question, design.md D8b)
- [ ] 5.6e Implement OCI reference validation for pinned service-version calls, rejecting dataset URNs used in that position and vice versa
- [ ] 5.7 Implement `branch` construct (statically enumerated cases, dynamically selected), including per-case `yields` resolution and rejection of direct references to a case's internal step ids (design.md D8c)
- [ ] 5.8 Implement `map`/`forEach` construct (statically shaped body, dynamically sized cardinality), including `yields` collection into parallel arrays and rejection of direct references to body-internal step ids (design.md D8c)
- [ ] 5.9 Implement derived workflow-signature generation and publish it through the workflow-spec store's discovery mechanism (see 11.2) - not the service registry, which indexes service images only
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

## 10. Service nesting

- [ ] 10.2 Wire the registry's `nesting_declaration: { via: sdk|http|cli|mcp, targets: [...] | open }` field (2.1c) into the nesting-enforcement layer (design.md D9b)
- [ ] 10.3 Implement the mandatory-by-default orchestrator-aware nesting path for services that declare `nesting_declaration`
- [ ] 10.4 Implement the declared-exception path for services that bypass the orchestrator-aware path, wired into trust-tier review (2.5-2.7, design.md D5a/D9b)
- [ ] 10.5 Implement dispatch-time allowlist enforcement and secret withholding for open-target nesting services (design.md D9c)
- [ ] 10.6 Implement the durable governor counter (count/cost/timeout), checked before each dispatch, surviving crash-and-resume (design.md D9c)
- [ ] 10.7 Exempt pure `compute`-backed tools from allowlist review (design.md D9c)
- [ ] 10.8 Implement the MCP gateway: translate an invocation's allowlisted OpenAPI operations into scoped MCP tool definitions, routing calls through 10.5/10.6 (design.md D9c)
- [ ] 10.10 End-to-end test: an agent-runner service (`nesting_declaration: {via: mcp, targets: open}`) refuses an out-of-allowlist call and halts at its governor limit, surviving a mid-loop crash without resetting the counter
- [ ] 10.11 End-to-end test: an undeclared direct-transport bypass is detected and treated as a capability-declaration violation (design.md D5a)

## 11. Workflow-spec store

- [ ] 11.1 Implement the workflow-spec store: URN identity (`urn:workflow-platform:workflow:ns/name[:tag|@digest]`) + immutable-version keying, storing a workflow-spec's IR + authoring doc (design.md D13)
- [ ] 11.2 Implement derived-signature discovery/query surface for published workflow-specs (design.md D13; consumed by 5.9)
- [ ] 11.3 Implement the fork operation: copy a source workflow-spec's shape/steps into a new, self-contained workflow-spec under the forking writer's namespace (design.md D9a/D13)
- [ ] 11.4 Implement the immutable, transitive fork-lineage pin (`forkedFrom: urn:...@version`), inspectable through chained forks, never a run-time resolution dependency (design.md D13)
- [ ] 11.5 Implement the hard platform invariant: writer-scoped secret references inherited from a source workflow-spec do not resolve under the forking writer's identity; treat as an unsatisfied binding until re-bound (design.md D7/D13)
- [ ] 11.6 Confirm static-dataset references carry over unchanged on fork by default, with no platform-level namespace/visibility gating (design.md D13)
- [ ] 11.7 Confirm dynamic `map`/`forEach` fan-out continues to use tracked child executions, unrelated to and unaffected by forking (design.md D8/D9a/D13)
- [ ] 11.8 Document fork-lineage-cycle handling as a known, deferred, non-execution-affecting limitation (design.md D13)
- [ ] 11.9 Define how the (external) authoring tool surfaces an IR-version mismatch between a source workflow-spec and a forking writer's own work, rather than the platform silently migrating or rejecting (design.md D11/D13)
- [ ] 11.10 Document that visibility/tenancy/publish-authority are explicitly delegated to the external authoring tool and are not enforced by the platform (design.md D13)
- [ ] 11.11 End-to-end test: a fork is self-contained and executes correctly with no run-time dependency on its source workflow-spec, even after the source publishes a new version
- [ ] 11.12 End-to-end test: a fork containing an unresolved inherited writer-scoped secret reference is treated as an unsatisfied binding; re-binding it to the forking writer's own secret makes the fork valid
- [ ] 11.13 End-to-end test: fork lineage remains inspectable and transitive across a chain of forks
