## Context

The platform runs a growing catalog of dockerized, stateless-function services (REST API + CLI, discoverable via OpenAPI through a registry). An external frontend triggers workflows composed of these services, injecting user-provided runtime data. Some data is static and referenceable, but users may manipulate it, creating session-scoped derived data that must not be baked into workflow definitions.

Initial candidate stack: Kubernetes (deployment/resources), KEDA (autoscaling), Argo Workflows (engine). This design documents why that stack was reconsidered. Kubernetes and KEDA remain well-supported as the compute substrate; the orchestration/execution-engine layer specifically is treated as an **open question** in this design (see D6) rather than a settled choice, and every other decision here is written to remain valid regardless of which engine is eventually selected.

The central tension driving this design: services span two execution shapes -

- **World 1 - truly stateless**: e.g. noise generation, edit distance. Cheap setup, no shared state. Fine to spawn-per-call or pool; isolation is trivial.
- **World 2 - setup-heavy**: e.g. a SQL-execution service that must first materialize a database dump before running a query. The materialized state may be shared (static dump) or session-private (user-manipulated dump), and is expensive enough to warrant reuse/pooling.

Both worlds exist simultaneously across the service catalog, decided per-invocation by the workflow-writer, not fixed per-service (the same SQL service can be bound to a static dump in one workflow and a session dump in another).

## Goals / Non-Goals

**Goals:**
- Support a DSL that lets workflow-writers compose docker service images into workflow-specs, referencing data by source (user/static/session) rather than embedding it.
- Guarantee data isolation between users/sessions even when execution units (containers) are pooled/reused for performance.
- Support both World 1 (spawn-per-call) and World 2 (warm, setup-heavy) services under one model, with the execution strategy chosen by placement logic rather than hardcoded per service.
- Make session state durable, reconstructable, and independent of any single worker's lifetime.
- Make affinity (routing to a worker with warm state) strictly an optimization - never a correctness requirement - so the compute substrate (K8s/KEDA) can remain stateless-worker-friendly.
- Provide native job guarantees: retries, backoff, timeouts, idempotency - as platform-managed defaults, not workflow-writer-configurable settings (see Non-Goals).
- Inject secrets into steps, scoped by ownership, without leaking across the isolation boundary or into durable execution history.
- Separate the DSL's authoring surface from a stable intermediate representation (IR), so authoring syntax can evolve or be plural without destabilizing the runtime contract, and so the underlying execution engine can be selected - or changed - independently of the DSL.
- Support real-world control-flow needs (conditional branching, dynamic-cardinality iteration, and bounded agent-directed composition) while keeping the IR as statically analyzable as possible for the scheduler.
- Leave the concrete authoring syntax/grammar, the specific secrets-broker product, the service-nesting model, and the execution engine itself as explicit follow-ups (not fully solved here).

**Non-Goals:**
- Exposing per-step retry/backoff/timeout as author-configurable DSL settings (D8d) - these are platform-managed defaults, hidden from the authoring surface entirely, not a construct with syntax to design.
- Providing an explicit per-step error-handling/fallback/compensation construct in the DSL (D8d) - a failed step propagates to native engine retry semantics; there is no DSL-level "catch" or "on failure, run this instead" construct.
- Selecting a specific secrets-broker product (the injection model is decided in D7; the store is kept agnostic and tracked as an open question).
- Selecting a specific content-addressed storage product or execution-engine deployment topology (operational choice, deferred to implementation; the engine itself is also not yet selected - see D6).
- Solving cross-session snapshot merge/branching (out of scope - sessions are modeled as linear chains only).
- Defending against untrusted/arbitrary service images (services are trusted platform code; if that ever changes, D7's threat model must be revisited).
- Selecting the specific mechanism/SDK that realizes the orchestrator-aware composition path (D9b) for whichever engine D6 selects - the policy (mandatory-by-default) is decided; the concrete mechanism cost is coupled to D6.
- Designing the general case of exposing this platform's registry *outward* to arbitrary third-party agent hosts as an MCP server (distinct from D9c, which covers an internal agent-runner service invoked as a step) - noted as a real, separate idea, not designed here.
- Selecting the execution engine itself (D6's leading paths are Temporal+resolver, Temporal+Ray hybrid, Restate, Dapr, or a DBOS-shaped self-written alternative; Argo scores weakly across D6's own evaluation and is not among the leading paths, though not formally excluded). Every requirement, IR construct, and spec in this change is written to be engine-agnostic so this decision can be resolved later without invalidating what's captured so far.

## Decisions

### D1: Classify state by scope x setup-cost, not by "stateless vs. stateful"

Rather than treating services as globally stateless or stateful, every data binding in a workflow is classified along two axes at instantiation time:

```
                SETUP COST
          negligible          heavy
        ┌───────────────┬──────────────────────────┐
none/   │ spawn or warm,│ (rare)                    │
global- │ doesn't matter│ materialize once, SHARE   │
static  │               │ read-only, pool hard      │
        ├───────────────┼──────────────────────────┤
session │ (uncommon)    │ materialize per session,  │
        │               │ ISOLATE, reuse within     │
        │               │ session                   │
        ├───────────────┼──────────────────────────┤
request │ load-per-call,│ expensive setup that can't │
        │ throw away    │ be amortized - accepted cost│
        └───────────────┴──────────────────────────┘
```

**Rationale**: The same service (e.g. the SQL service) lands in different cells depending on what it's bound to, not on its own identity. Isolation/pooling strategy must therefore be decided per-binding, at workflow-instantiation time, not hardcoded per service image.

**Alternatives considered**: Tagging services as "stateless" or "stateful" globally (rejected - doesn't capture that the same service can be bound to static or session data depending on workflow intent).

### D2: Content-address materialized state; isolation is a consequence of the cache key

Warm/materialized state (e.g. a loaded DB) is keyed by a hash of what produced it (base dump + applied operations). Identical inputs -> identical hash -> safe sharing. Divergent (e.g. user-mutated) inputs -> different hash -> naturally isolated, with no possibility of cross-session collision.

**Rationale**: This turns data isolation from an enforced discipline (every service must be manually audited to not leak state) into a structural guarantee (different hash = different state, unconditionally).

### D3: Sessions are event-sourced; snapshots are a derived, GC-able cache

The durable source of truth for a session is its **user input history** (the sequence of actions/mutations), stored outside the execution/state-cache scope. Materialized snapshots are a cache over that history:

```
SOURCE OF TRUTH:   user input history  (durable, kept)
                     |  replay
                     v
DERIVED CACHE:     snapshot chain  (TTL'd - "days" - and GC-able)
```

Session snapshot chains are strictly linear per session (mutations happen one at a time within a session). Across sessions, chains diverge from shared immutable roots (e.g. a static dump) and never need to merge:

```
                 static base 0xAAA (read-only, shared)
                        |
        +---------------+---------------+
        v               v               v
   session-A        session-B       session-C
    0xBBB             0xEEE          (still 0xAAA)
      |
    0xCCC
```

Copy-on-write is used where the underlying service/engine supports incremental snapshots, so large static bases (e.g. tens of GB) are loaded once and shared; sessions pay only for their delta. COW support is declared as a per-service capability (see D5) - it is confirmed available for at least the SQL-dump use case.

Because snapshots are always reconstructable from the input history, TTL-based garbage collection of snapshots is safe at any time; nothing depends on snapshot retention for correctness.

**Rationale**: Decouples correctness (guaranteed by the durable log) from performance (the cache), which is what allows affinity/pooling to be "just" optimizations (see D4) and allows unbounded GC of warm state.

**Note**: this session input-history log may, depending on the execution engine eventually selected (D6), be implementable directly on top of that engine's own durable execution history (several candidate engines maintain one already) rather than as wholly separate infrastructure - see D6's findings.

**D3a: Undo/time-travel is a UX surface over the existing log, not a new capability.** Because the durable input-history log is always kept independent of snapshot GC, reconstructing an arbitrary earlier point in a session is already possible via replay - "should sessions support undo" therefore narrows to two much smaller decisions rather than requiring new architecture:

1. **Product/API surface**: rewinding a session's pointer to an earlier point in its own chain, and what happens on the next new mutation after a rewind. Decision: **linear undo-with-truncation** (the same semantics as a text editor or image editor's undo stack) - a rewind moves the current pointer backward; a subsequent new mutation abandons the truncated-off forward tail and starts fresh from the rewind point. This stays fully consistent with the existing constraint that sessions are linear chains with no merge/branch (D3's diagram above) - it is pointer movement plus truncation, not Git-like branching.
2. **Retention as a performance knob, not a correctness dependency**: a tunable **checkpoint interval** controls how many intermediate snapshots stay materialized/cached (faster undo, more storage) versus how much is rebuilt via replay-from-history on demand (slower undo, less storage) - the same idea as WAL/keyframe checkpointing elsewhere in computing. Default: retain the full snapshot chain for the life of the session (cheap given content-addressed dedup of shared roots per D2), GC'd only when the session itself expires; any snapshot evicted earlier under storage pressure remains reconstructable via replay, per the TTL-is-a-cache-policy principle already established above.

**Rationale**: Keeps undo/time-travel from becoming a special case - it is the same durable-log-plus-derived-cache model already in place, exercised by a rewind verb instead of only a forward-append verb.

### D4: Placement/affinity is fused from three sources and is always an optimization

A scheduler decides execution strategy (spawn vs. warm pool, shared vs. isolated, pinned vs. rehydrate-anywhere) by fusing:

```
1. SERVICE CAPABILITIES  (owner: service author, declared in OpenAPI/registry)
     mutates? / materialization cost class / COW support / change-detection

2. WORKFLOW INTENT        (owner: workflow-writer, declared in the DSL)
     scope: static | session | request
     mutable: true | false
     interactivity: interactive | batch   <- latency-sensitivity hint

3. RUNTIME OBSERVATION    (owner: scheduler, measured)
     actual snapshot size, access frequency/recency
```

The workflow-writer never declares mechanism (volumes, affinity, pool size) or a byte-size threshold - they don't know the runtime size of user data. They declare *intent* ("this is an interactive session" vs "this is a batch step"); the runtime combines that with observed size to pick a mechanism, and can adaptively promote a session to pinned/warm if it proves large and hot. Because state is durable and content-addressed (D2/D3), getting this placement "wrong" costs performance, never correctness.

Change-detection is delegated to the service: a service call reports whether it actually mutated state, so read-only queries against a session's materialized state do not spuriously advance the snapshot chain.

**Rationale**: Keeps the DSL declarative and free of infrastructure concerns; keeps K8s/KEDA in their comfort zone (stateless, freely-scheduled workers) by making stickiness opportunistic rather than required.

**Note**: this decision establishes *that* placement is fused from three sources and *that* affinity is optional, but deliberately does not specify the concrete mechanism that turns a placement decision into an actually-routed call to a specific service replica. **Update (task 1.10): this mechanism is now formalized.** The bespoke-resolver option (`placement-resolver/`) implements D4a's cache-admission model concretely - `resolvePlacement`/`recordAccess`/`evaluatePromotion`/`evaluateDemotion`/`evictLRUIfOverCapacity` against a Postgres schema whose thresholds are tunable data (`placement_config`), not hardcoded constants - verified against a real Postgres instance (batch-never-promotes, promotion/demotion hysteresis, and pinned-only LRU eviction all hold). See `placement-resolver/FINDINGS.md` for the full design.

**D4a: Auto-promotion thresholds - a cache-admission model, not fixed constants.** Adaptive residency promotion (unpinned -> pinned) is decided by a model analogous to standard cache-admission policies (e.g. GDSF - greedy dual-size frequency), rather than an arbitrary rule:

```
PROMOTE (unpinned -> pinned) requires ALL of:
  - declared interactivity = "interactive" (never auto-promote a batch-
    scoped binding, regardless of frequency - latency isn't the concern)
  - estimated/observed rehydration cost is above a latency threshold
    (starting default: ~250-500ms, below which users likely won't
    perceive the difference)
  - recent access frequency crosses a threshold (starting default:
    >= 3 accesses within a 5-10 minute rolling window)

DEMOTE (pinned -> unpinned) uses a HIGHER idle threshold than promotion
requires (starting default: ~15-30 minutes idle) - deliberate hysteresis
(promote-quick, demote-slow) to avoid flapping.

CAPACITY-AWARE: if a pinned-pool memory/size budget is exceeded, evict
LRU among the PINNED set even if an entry would otherwise still qualify
to stay pinned - ties directly into autoscaling-pooling's capacity
planning.

COST ESTIMATION: use the service's declared materialization-cost-class
(D5) as a prior before empirical data exists; switch to an observed
rolling average (per service + size-bucket) once enough real
rehydration timings have been sampled.
```

All numeric thresholds above are explicit **starting defaults, exposed as tunable scheduler parameters** - not hardcoded constants - since real tuning is only possible once there is real traffic to observe.

### D5: Service capability metadata lives in the OpenAPI/registry, not the DSL

Per-service facts needed for placement (mutates?, materialization cost class, COW/incremental-snapshot support, change-detection support) are declared by the service author and exposed via the existing OpenAPI/registry mechanism, extended with this metadata. The workflow DSL only carries workflow-writer intent (D4), never service mechanics.

**Rationale**: Keeps the separation of concerns clean: "what a service can do" is owned by the service author; "what a workflow wants" is owned by the workflow-writer; "how to place it" is owned by the runtime.

**First real data point (task 1.1):** the actual pinned SQL-execution service (`ghcr.io/htw-aladin/sql-assessment-service:sha-23e9468`) was confirmed, by direct measurement against the real image, to have **`cowSupport: false`** - no cross-instance caching for identical seed content, same-key re-analyze fully replaces rather than incrementally updates, and no snapshot/dump/fork/clone endpoint exists in its API at all. See `spikes/1.1-cow-snapshot-poc/FINDINGS.md`. This is this design's first concrete instance of a service actually falling on the "full-copy fallback" side of D1's classification, not merely a hypothetical case the taxonomy was built to accommodate - it should be registered accordingly (materialization-cost-class set generously, not "negligible") once 2.3's backfill task is picked up.

**D5a: Capability declarations must earn scheduler trust; trust is an optimization, never a correctness default.** A false capability declaration (e.g. a service that claims non-mutating or COW-capable but isn't) breaks the isolation guarantee itself, not just performance - this is a genuine correctness stake, addressed with the same pattern already used for affinity (D4) and residency (D4a): start conservative, promote only on evidence.

```
TRUST TIERS, keyed to a specific service IMAGE DIGEST (not the service
name in the abstract - a regression in a new build does not inherit an
older build's earned trust):

  UNVERIFIED         -> scheduler is fully conservative: no sharing, no
                         pooling, no COW reuse, regardless of what is
                         declared
  CONFORMANCE-PASSED  -> passed automated conformance probes at
                         registration (e.g. call twice with identical
                         inputs and verify declared mutation/non-
                         mutation behavior holds; verify a COW claim by
                         checking the base is unaffected after a
                         claimed-isolated mutation)
  PRODUCTION-PROVEN   -> conformance re-run and passed on every redeploy
                         (CI/CD-gated), plus a soak period with no
                         detected violations

The scheduler only leans on a capability declaration (sharing, pooling,
COW reuse) once a service build has reached PRODUCTION-PROVEN.
```

A continuous **runtime invariant check** guards against drift after promotion (a later redeploy could silently regress a previously-earned claim): periodically sample a claimed-immutable/shared binding across different callers; if outputs diverge unexpectedly, that is a strong signal of a false claim - auto-demote the trust tier and alert, rather than waiting for a human to notice a leak.

**Rationale**: Extends the "optimization, never correctness requirement" pattern used throughout D2-D10 to trust itself - closes the gap flagged in the original Risk entry ("capability declarations are a trust boundary that should be validated... not yet designed") with a concrete mechanism.

### D6: Execution engine selection - DECIDED: Postgres-native path (resonate-pg-shaped fork)

**Decision (locked in via task 1.4): the execution engine is a Postgres-native path - forking a small, documented Postgres-durable-execution implementation (in the shape of resonate-pg / "THE PATTERN" below), not adopting resonate-pg's Supabase-specific transport, Hatchet, Temporal, Restate, Dapr, or Conductor.** This closes the OPEN QUESTION this section carried through D1-D5's design; D7 onward can now treat the engine's properties (durable history, step execution, child/tracked execution) as this specific implementation's properties rather than a generic placeholder, though the engine-agnostic language elsewhere in this document is left as-is since it remains accurate for what's downstream.

**Why**: of the six candidate paths evaluated below, this is the only one with its DEEP-consolidation claim (D3's session log, D4's placement-resolver, and D6's own durability layer sharing one Postgres transaction, not just one instance) *demonstrated* rather than argued - spike 1.2's mid-transaction-crash test showed the claim survives an actual failure boundary, and spike 1.2e's load/scale check found no operational showstopper at ~75x that spike's original scale. Every other path evaluated either caps out at SHALLOW consolidation on inspection (Hatchet, confirmed via spike 1.2-hatchet: a gRPC worker/Engine split makes step-completion and any of our own writes two separate commits, in any topology) or was never a DEEP-consolidation candidate to begin with (Temporal, Restate, Dapr - Virtual Objects/Actors can only provide placement *bookkeeping*, not host the heavyweight SQL service itself, confirmed via spike 1.2a for Restate specifically) or doesn't natively address R11 at all (Conductor). The organizational-risk axis (this team owns operating a durability core in production, vs. a vendor/community owning it) was weighed and accepted as the cost of the differentiated DEEP-consolidation property, rather than resolved by further spiking - no amount of additional spiking converts that judgment call into a technical answer, per D6's own framing throughout this section.

**What this decision does NOT yet settle** (tracked as their own tasks, not blocked on re-opening this decision): 1.9 (service-nesting mechanism cost, coupled to this choice), and 1.6 (secrets-broker product - independent of the engine choice per D7's broker-agnostic model). 1.10 (placement-resolver) and 1.5 (generic IR interpreter) are now both done - see `placement-resolver/FINDINGS.md` and `spikes/1.5-ir-interpreter/FINDINGS.md` respectively.

**D6a: The concrete fork target - DECIDED: clean-room, informed by resonate-pg and hatchet-dev's tutorial as design references, not as fork targets.**

Three options were weighed: forking `resonatehq/resonate-pg`'s own SQL file directly; forking/porting `hatchet-dev/durable-execution-the-hard-way`'s Go lessons; or continuing the clean-room implementation spike 1.2 already built (schema.sql + worker.js, ~210 lines total, already crash/contention/load-tested).

```
resonate-pg: feature-complete (durable sleep, human-in-the-loop pauses,
  a working agent-loop example) but immature (5 stars, 0 forks, created
  2026-07-04 - three weeks old) and structurally mismatched: its actual
  dispatch is a promise/task RPC protocol pushed via pg_net HTTP, not the
  SELECT...FOR UPDATE SKIP LOCKED polling pattern spike 1.2 validated. Its
  only maintained transport (@resonatehq/supabase) is Supabase/Deno-
  specific; no Go transport exists (open issue), and no confirmed plain-
  Postgres transport for our own Node.js stack either - adopting it outside
  Supabase means writing a new Network implementation, real integration
  work, not free adoption. Its own README admits incompleteness (list/
  search protocol calls not yet implemented).

hatchet-dev/durable-execution-the-hard-way: credible pedigree (the Hatchet
  team), MIT-licensed, 165 stars, frozen (no upstream-drift risk). But
  explicitly not meant to be adopted as-is - its own README states it
  "won't implement the typical niceties you'd see in a client SDK," and
  lists durable sleep, LISTEN/NOTIFY, and forking/branching under "ideas
  for future lessons," i.e. not yet written. Go + pgx + sqlc, a different
  stack than every spike built so far (Node.js + pg) - adopting it means
  either a language/toolchain split for the durability core or manually
  porting Go lessons into our own stack, which is clean-room work either
  way, just using the tutorial as a reference rather than a fork target.

clean-room (spike 1.2's schema.sql + worker.js): already built, and
  already the only one of the three that implements our actual
  differentiating requirement - D3's session log and D4's placement-
  resolver sharing the SAME transaction as the durability core - since
  neither reference implementation was designed around that consolidation
  claim. Already crash-tested (spike 1.2), contention-tested, and load-
  tested to ~75x its original scale (spike 1.2e). Inherits zero free
  features (no durable sleep, no LISTEN/NOTIFY, no `waits` table) - but
  neither upstream option would have handed us a working, adoptable
  version of those either (resonate-pg's is Supabase-locked; hatchet-dev's
  is unwritten), so this is not a cost unique to the clean-room choice.
```

**Decision: clean-room.** The deciding fact is that our actual requirement isn't a feature of either reference implementation - forking either would mean fighting an architecture mismatch (resonate-pg's RPC/pg_net transport) or adopting an incomplete, differently-stacked teaching tool (hatchet-dev's Go lessons) for a payoff limited to the smallest, least-risky part of THE PATTERN (the executions/checkpoints layer, already the least original ~30 lines of what we built). Both remain valuable as **design references** going forward (as they already were for D6's evaluation and for informing what a `waits`/durable-sleep table should eventually look like) - not as fork targets. Spike 1.2's existing schema/worker is the actual starting point for 6.1/6.2, not a throwaway prototype to be replaced by a fork.

The requirements and evaluation this decision was made against are preserved below for context and to support revisiting this decision if a future spike or production finding surfaces a blocker.

An execution engine must satisfy requirements derived from D1-D5, plus two more surfaced later while stress-testing this decision against still-open requirements elsewhere in this design:

```
R1  Sequence DSL-defined DAGs of steps
R2  Call BOTH warm pooled services (World 2) AND spawned jobs (World 1)
R3  Pass data BY HANDLE (content hash), never by value, for large state
R4  Honor placement hints; prefer a warm worker but fall back freely (D4)
R5  Model a SESSION: long-lived (hours-days), linear, driven by discrete
    user actions over time
R6  Durable execution: survive engine/worker restarts, resume mid-flow
R7  Native retries / backoff / timeouts / idempotency
R8  Skip/reuse steps already covered by the memoization cache (D2/D3)
R9  Inject secrets per step without leaking across isolation boundaries
R10 Distributed, load-balanced, KEDA-scalable workers
R11 Native, addressable "warm entity per key" primitive - a first-class way
    to route to the specific instance holding a given content-hash's warm
    state, without hand-building a separate resolver/router
R12 Support bounded, agent-directed dynamic composition (an unpredictable,
    non-statically-enumerable sequence of calls within a declared allowlist),
    with durability across potentially long, multi-round tool-calling loops
```

**A more fundamental axis, found while widening the candidate search, cuts across all of R1-R12**: candidate engines split into three recovery architectures, and this determines whether D8's determinism-shielding rationale even applies to the engine eventually chosen.

```
REPLAY-BASED (Temporal, Restate, Hatchet, Cadence, Dapr Workflows):
  full event history replayed on recovery; workflow-level code MUST be
  deterministic; gives a free audit trail / time-travel debugging.

CHECKPOINT-BASED (Trigger.dev v3/v4, DBOS, LangGraph-style checkpointers):
  state snapshotted at explicit await points; no replay, NO determinism
  constraint; audit trail must be built on top of explicit checkpoints.

EVENT-DRIVEN / HTTP-INVOKED (Inngest, Upstash Workflow, Cloudflare Workflows):
  steps delivered to your own app as HTTP requests; engine memoizes
  completed results; no infra of your own to run; explicitly weaker fit
  for "one agent loop touching many tools for hours" per independent
  sources, which matters directly for R12.
```

Widened candidate map (this is now a broader, family-organized survey rather than four named products):

```
FAMILY 1 - Replay-based durable execution: Temporal, Restate, Hatchet (partly), Cadence,
           Dapr Workflows, Conductor (Orkes)
FAMILY 2 - Checkpoint/event-driven durable execution: Trigger.dev, Inngest, Upstash Workflow,
           Cloudflare Workflows, DBOS
FAMILY 3 - Virtual-actor / addressable-entity frameworks (R11 specialists): Orleans (.NET-only),
           Akka/Akka.NET, Dapr Actors (polyglot), Cloudflare Durable Objects (Cloudflare-only,
           not self-hostable in our own K8s - set aside on that basis)
FAMILY 4 - K8s-native / declarative / data orchestration: Argo, Kestra, Airflow/Prefect/Dagster
           (data-pipeline shaped), Camunda 8/Zeebe (BPMN), AWS Step Functions/Azure Durable
           Functions/GCP Workflows (managed, vendor-locked) - re-confirms the original weak-fit
           finding for this family rather than overturning it, with two exceptions noted below
FAMILY 5 - Self-written / adopted-thin-library, all Postgres-centric: a full custom replay/
           checkpoint engine; a DBOS-shaped thin library that delegates durable recovery to
           Postgres transactions; or adopting/forking a small, already-working OSS
           implementation of the same pattern (see findings below) rather than designing it
           from first principles
```

Two Family-4-adjacent entries deserve elevation rather than the blanket weak-fit finding:

- **Conductor (Orkes)** - Netflix-built, Apache 2.0, Orkes-stewarded, proven at Netflix/Tesla/LinkedIn/JPMorgan scale. Ships a **native MCP gateway (Agentspan)** and 14+ built-in LLM provider task types - directly relevant to D9c. Its architecture explicitly separates declarative orchestration (JSON) from plain worker code with "zero framework constraints," and treats determinism as an architectural property of the orchestration layer rather than a discipline imposed on workflow-writers - strikingly close to what D8/D8a independently arrived at for this design. Re-classified into Family 1 above rather than left in Family 4.
- **Camunda 8 / Zeebe** - BPMN-based, explicitly marketed in 2026 for "durable multi-agent coordination" and handoff/supervisor agent patterns, distributed-by-design (not a central-DB bottleneck). A real contender, but Zeebe requires a paid enterprise license for production use since 2024, and its culture/audience (enterprise BPM, business/IT collaboration via visual BPMN diagrams) is a different fit than this platform's dockerized-function/workflow-writer audience.
- **Kestra** is philosophically the closest authoring-surface match to D8a (YAML-first, subflows resembling D9a's composite entries, namespaces resembling D8a's dataset catalog namespacing) but originated in the data-pipeline camp; its crash-durability semantics for long, agent-shaped workloads are less battle-tested than the dedicated durable-execution engines. Worth noting the convergence, not yet a leading candidate on durability grounds.
- **Golem** (WASM-based, agent-native) is the youngest and most opinionated option found - worth knowing it exists, not yet a serious candidate given its immaturity.

**"Implementing our own" is materially less risky than earlier framed.** There is now a well-documented, multiply-implemented pattern for exactly this, not just a theory:

```
THE PATTERN (independently arrived at by DBOS, a Hatchet-published tutorial,
and multiple other teams in 2026):
  - an executions table (status, step, input, context, lease/heartbeat)
  - claim via `SELECT ... FOR UPDATE SKIP LOCKED` - the entire dispatcher,
    no broker, no leader election
  - idempotent steps via a UNIQUE(execution_id, step_id) constraint on a
    checkpoints table - Postgres enforces exactly-once, not application code
  - LISTEN/NOTIFY for low-latency wakeup (a latency optimization; the rows
    ARE the queue, not NOTIFY)
  - a `waits` table with a wake_at timestamp for durable sleep/human-in-
    the-loop - a multi-week wait costs exactly one row
  - a sweeper that resets/retries executions whose lease has expired

REFERENCE IMPLEMENTATIONS THAT ALREADY EXIST (permissively licensed):
  - resonate-pg: the entire server as one ~1,350-line PL/pgSQL SQL file -
    turns any Postgres 16+ into a durable execution engine (pg_cron for
    timers, pg_net for HTTP dispatch). Demonstrated running a durable
    agent loop (think -> tool -> observe) with a human-in-the-loop pause
    and parallel fan-out, crash-tested on purpose mid-task, exactly-once
    step semantics confirmed under test.
  - hatchet-dev/durable-execution-the-hard-way - a from-scratch tutorial
    teaching this exact recipe
  - pipelines-ts, pg-workflows - smaller TypeScript-native equivalents
```

This means "build our own" no longer means designing distributed recovery semantics from first principles - it means adopting or forking a small, auditable, already-working implementation, and building D1-D11's genuinely novel logic on top of it, the same way one would on top of any bought engine.

**A new finding this round: a Postgres-centric engine choice could consolidate four separate open infrastructure items onto one system.** Four different open items in this design each independently want a durable, queryable, transactional store: D6's execution engine durability layer; D4's still-undesigned placement-resolver (fundamentally a one-table lookup with a unique index - "which replica is warm for hash X"); D8a's dataset resource catalog (tag -> digest -> storage location); and D3's session input-history log. If the engine is Postgres-native (Hatchet, DBOS, or an adopted/forked resonate-pg-style build), **all four could live in the same Postgres instance/cluster** rather than four separate pieces of infrastructure to operate - a materially different operational cost profile than Temporal (separate cluster), Restate (separate RocksDB-backed binary), or Dapr (a sidecar mesh plus whatever state store it's pointed at), none of which naturally absorb the other three items just by being chosen.

Evaluation, updated to include the newly elevated candidates and the Postgres-native/self-built path:

| Requirement | Temporal | Restate | Dapr | Hatchet | Conductor | Postgres-native (resonate-pg-shaped fork) |
|---|---|---|---|---|---|---|
| R1-R3 (DAG, warm, handle) | Good | Good | Good | Good | Strong | Good |
| R4 Affinity-as-optimization | Partial (see R11) | Strong | Strong | Partial | Absent | Strong (see R11 below) |
| R5 Long sessions | Strong | Strong | Strong | Moderate | Strong | Good (demonstrated) |
| R6 Durable execution | Strong | Strong | Strong | Strong | Strong | **Confirmed via spike 1.2** - exactly-once via `UNIQUE(execution_id, step_id)`, and crash-tested: a mid-transaction kill rolls back cleanly and a subsequent claimant resumes with no duplicate side effects |
| R7 Retries/backoff | Strong | Strong | Strong | Strong | Strong | Good (demonstrated; lease-expiry sweep confirmed via spike 1.2's crash test) |
| R9 Secrets | Good | Good | Good, plus native pluggable Secrets API | Good | Good | Good (same secret model, engine-agnostic) |
| R10 K8s/KEDA fit | Good | Good | Native | Good | Good | Good (stateless workers, same as any) |
| R11 Addressable warm entity | Absent, needs a resolver | Strong, but bookkeeping-only (see below) | Strong, but bookkeeping-only (see below) | Partial | Absent | **Confirmed via spike 1.2** - the placement table lived in the same schema and the same per-step transaction as the durability core and session log, not merely "the same DB" |
| R12 Agent composition | Strong | Strong | Good | Good | Strongest - native MCP gateway built in | Demonstrated working (resonate-pg's own agent-loop example); not independently re-exercised by spike 1.2, which scoped to the consolidation question only |
| Composability fit (D9) | Workable, SDK-adoption tax | Most natural, uniform invocation | Most natural, uniform invocation | Good | Strong, native tool-calling model | Neutral - build the same dispatch discipline either way |
| 4-way infra consolidation | No | No | No | **No (confirmed SHALLOW via spike 1.2-hatchet)** - worker/Engine gRPC split means step-completion and any of our own placement/session-log writes are always two separate commits, not one, regardless of deployment topology | No | **Yes, DEEP (confirmed via spike 1.2)** - not just same-instance locality: a mid-transaction-crash test showed the durability core, session log, and placement-resolver commit-or-rollback together as one transaction |
| D3 linear-per-session-mutation under concurrency/crash | N/A (not spiked) | N/A (not spiked; this is what 1.2a exists to check) | N/A (not spiked) | N/A - moot, since Hatchet caps at SHALLOW consolidation anyway | N/A (not spiked) | **Confirmed via spike 1.2** - holds under same-session concurrency, cross-session interleaving (no contamination), and two distinct crash/dead-worker failure shapes, via ordinary `FOR UPDATE` discipline, no surprises |
| Operational weight | Heaviest | **Light to start; Moderate-to-heavy to run as a proper multi-node cluster (revised down via spike 1.2a)** - a production Restate cluster needs a distributed replicated log, Raft/etcd/S3 metadata storage, per-partition RocksDB, object-store snapshots, and (recommended) a K8s operator; closer in kind to Temporal's profile than a single-binary sounds | Light-moderate | Light | Light-moderate | **Confirmed lightest via spike 1.2e's load/scale check** - correctness and no-showstopper behavior held at ~75x spike 1.2's original scale (6,000 executions, 60 sessions, 32 workers): peak connections stayed well under `max_connections`, and UPDATE-churn dead tuples were fully reclaimable via `VACUUM` |
| Maturity/adoption | Highest | Newer | Moderate ("SDK maturity behind" flagged) | Growing fast (YC-backed) | High (Netflix/enterprise-proven) | Newest as an adopted pattern; the underlying primitive (Postgres) is the most proven of all |

**Status at the time this evaluation was run (superseded by the DECIDED status above, preserved for context).** Tracing the SQL-session scenario concretely through Restate and Dapr produced a correction worth restating: **neither makes our existing heavyweight services "become" addressable actors for free.** Restate's Virtual Object state is small, logical K/V data, not a place to host a multi-GB loaded database engine. Dapr Actors can host true in-memory affinity, but only if the service is rewritten to embed the Dapr Actor SDK - a real authoring-cost tax structurally bigger than what Temporal or Restate ask. The fairer, more conservative use of either primitive is as durable placement *bookkeeping* (an addressable entity per content-hash tracking which plain-REST pod is currently warm), leaving the heavyweight service untouched. Restate additionally gives per-key serialized access "for free," mapping directly onto D3's linear-per-session-mutation requirement. This same bookkeeping-only pattern is exactly what a one-table lookup in a Postgres-native path provides too - which is precisely why the 4-way consolidation finding above matters: it's not a *new* capability the Postgres path adds, it's the *same* placement-bookkeeping need, satisfied by infrastructure already required for other reasons.

**Spike results (1.2, 1.2-hatchet) - what changed vs. desk research.** Two of the six candidate paths have now been tested empirically rather than evaluated on paper alone (see `spikes/1.2-resonate-pg-durable-exec/FINDINGS.md` and `spikes/1.2-hatchet-product-fit/FINDINGS.md`):

- **Path (f), Postgres-native, forked directly from THE PATTERN (not resonate-pg's Supabase-specific transport - see the spike's own scoping note)**: the DEEP-consolidation claim is no longer just structurally plausible, it is demonstrated. A worker transaction claiming an execution, appending the session log, upserting placement, and writing the completion checkpoint was crash-tested with `pg_terminate_backend` mid-transaction: zero partial writes survived, and recovery was immediate (the claim itself rolled back to `queued`, no lease wait needed) - a stronger resumability property than the lease-expiry path, which was separately confirmed for the genuinely different failure shape of a committed claim whose worker then goes dark. D3's linear-per-session-mutation guarantee held under 8-worker concurrency across two interleaved sessions with zero cross-contamination. This directly answers the technical question 1.2a (Restate) was scoped to check - see the re-scoping below. The one claim spike 1.2 did **not** test is operational weight at real scale (connection ceilings, vacuum/bloat under sustained `UPDATE` churn) - this remains the single open item before treating "lightest operational footprint" as more than a paper claim.
- **Hatchet**: ruled out as a DEEP-consolidation contender, not merely "Partial" as the desk-research-only prior evaluation had it. Its worker/Engine split is a persistent bidirectional gRPC stream to a separate control-plane process that owns its own Postgres transaction for step-completion - there is no deployment topology (even same-instance) that makes a Hatchet step-completion and our own placement/session-log write share a transaction. This closes what had been the strongest "someone else owns the durability core" contender in Family 1, and reframes Hatchet purely as a SHALLOW-consolidation buy option (ops convenience, no atomicity) against the resonate-pg-shaped fork's build option (full atomicity, we own the durability core).

A secondary, independent finding carried over: Dapr ships a native, pluggable Secrets building block, which would materially help satisfy D7's still-open secrets-broker-product question if Dapr were adopted for other reasons. D9's composability finding is reinforced across every single-system candidate examined (Restate, Dapr, and now Conductor): the primitive used to call *anything* is the same primitive used to call a *composed* service, with no separate "child-workflow ceremony" - a genuine structural improvement over Temporal's two-tier model. The DSL/IR split (D8) continues to insure against this decision being made under uncertainty regardless of which of these paths is chosen.

**Leading paths, updated:**

```
(a) A Temporal-shaped engine + a hand-built placement-resolver/router for R11.
    Proven, mature, heaviest operational footprint; most work required for
    R11; keeps services as plain, unmodified REST/CLI containers.

(b) A Temporal-shaped engine hybridized with an actor-model engine (e.g. Ray)
    for R2-R4,R11. Weakened relative to every single-system path below.

(c) Restate as a single system for R1-R12, using Virtual Objects for durable
    placement bookkeeping (not for hosting the heavyweight services). Newer,
    less proven at scale than Temporal.

(d) Dapr (Workflows + Actors) as a single polyglot, K8s-native runtime,
    defaulting to bookkeeping-only use of Actors. Also plausibly resolves
    D7's secrets-broker question via Dapr's native Secrets API. "SDK
    maturity behind" is a real, independently-flagged risk.

(e) Conductor (Orkes) as a single, Netflix/enterprise-proven system with a
    native MCP gateway (Agentspan) directly matching D9c, and a declarative
    orchestration model close to D8/D8a's own philosophy - potentially the
    lowest-effort IR-to-engine compilation target of any candidate. Does not
    natively address R11 (needs the same bookkeeping bolt-on as Temporal).

(f) A Postgres-native path, specifically adopting/forking a small OSS
    implementation of the documented Postgres-durable-execution pattern
    (e.g. resonate-pg) - now CONFIRMED (not just structurally plausible) to
    uniquely consolidate D3's session log, D4's placement-resolver, D6's
    durability layer, and D8a's dataset catalog onto one already-required
    piece of infrastructure, via spike 1.2's mid-transaction-crash test.
    Lightest operational footprint of any path on paper (pending the
    load/scale check below); newest as an adopted pattern, though built on
    the most proven underlying primitive (Postgres) of any candidate
    considered. Hatchet is explicitly NOT an equivalent instance of this
    path despite also being Postgres-backed: spike 1.2-hatchet confirmed its
    worker/Engine gRPC split caps it at SHALLOW consolidation, so it competes
    with this path as a buy-side alternative, not as another way to realize
    the same DEEP claim.
```

**Recommended next step (revised again - two of the two deep/shallow spikes below are now DONE, which lets the remaining queue be re-scoped rather than merely re-prioritized).** The evaluation table above already gave the Postgres-native path a real, differentiated edge on paper before any code was written; spikes 1.2 and 1.2-hatchet have since converted the two most consequential rows of that table from paper claims into tested results (see "Spike results" above). That empirical result - not just desk research - is what justifies re-scoping 1.2a (Restate) below: the specific technical unknown it existed to check has already been answered by spike 1.2's own contention test. The organizational-risk axis this evaluation table still has no row for is unchanged by any of this: adopting Temporal/Restate/Dapr/Hatchet means a vendor/community maintains the recovery engine indefinitely, while forking a resonate-pg-shaped implementation means **this team** owns operating and patching a durability core in production - a real, ongoing cost distinct from whether the pattern is "proven," and not something further spiking resolves either way.

The resulting plan:

```
DONE - PRIMARY, DEEPEST SPIKE: forked THE PATTERN (resonate-pg-shaped,
  not resonate-pg's Supabase-specific transport) directly against the
  SQL-session scenario. Result: DEEP consolidation confirmed (not just
  same-instance locality) via a mid-transaction-crash test, plus D3's
  linear-per-session-mutation guarantee confirmed under both concurrency
  (including cross-session interleaving) and two distinct crash/dead-
  worker failure shapes. See spikes/1.2-resonate-pg-durable-exec/.
  Remaining gap: operational weight at real scale was NOT tested (see
  the new load/scale-check item below) - the correctness claims are
  settled, the "lightest operational footprint" claim's scale half is
  not yet.

DONE - HATCHET, SHALLOW PRODUCT-FIT EVALUATION: answered by architecture
  research (gRPC worker<->Engine split; Engine owns its own Postgres
  transaction for step-completion) rather than a build-out, per its
  lightweight-evaluation scoping. Result: Hatchet is capped at SHALLOW
  consolidation - a step-completion and any of our own placement/
  session-log writes are always two separate commits, in any deployment
  topology. This closes Hatchet out as a DEEP-consolidation contender and
  reframes it purely as a build-(resonate-pg fork)-vs-buy-(Hatchet,
  SHALLOW-only) trade. See spikes/1.2-hatchet-product-fit/FINDINGS.md.

DONE - RESTATE, LIGHTWEIGHT DESK-RESEARCH EVALUATION (re-scoped from:
  NARROW, TARGETED SPIKE): the one differentiated capability claim this
  was scoped to check - whether the Postgres-native path can match
  Restate's "per-key serialized access for free" via ordinary
  `SELECT ... FOR UPDATE` discipline without surprises - was answered
  empirically by spike 1.2's own contention test before this task even
  started (same-session serialization + cross-session non-contamination,
  no surprises found). This evaluation checked for any OTHER
  differentiator instead. Result: none found - Restate's Virtual Objects
  are confirmed (via Restate's own architecture docs, not just the prior
  round's assessment) unable to host the heavyweight SQL service itself,
  matching D6's existing finding. The one correction worth carrying: a
  DOWNWARD revision of Restate's "Light" operational-weight rating for
  production topologies (see the updated evaluation table above) - a
  production Restate cluster needs a distributed replicated log,
  Raft/etcd/S3 metadata, per-partition RocksDB, and object-store snapshots,
  closer in kind to Temporal's profile than "Light" suggested. This widens,
  not narrows, the operational-weight gap in favor of the Postgres-native
  path. See spikes/1.2a-restate-lightweight-eval/FINDINGS.md.

DONE - LOAD/SCALE CHECK for the Postgres-native path (was a new item added
  this round): the one claim spike 1.2 did not test. Narrowly scoped, not
  a production-readiness project: ~75x spike 1.2's original scale (6,000
  executions, 60 sessions, 32 concurrent workers), plus a dedicated
  UPDATE-churn phase against 25 "hot" rows to test dead-tuple/bloat
  behavior directly. Result: no showstopper found - all executions
  processed exactly once, all session chains stayed contiguous at this
  larger scale, peak connections (33) stayed well under Postgres's
  `max_connections` (100), and dead tuples generated by the churn phase
  were fully reclaimable via `VACUUM`. This closes the "lightest
  operational footprint" claim's one remaining untested half. Scope
  caveat: single-instance/single-machine, seconds-scale - not a full
  production capacity-planning exercise (see the spike's own caveats
  section for specifics). See
  spikes/1.2-resonate-pg-durable-exec/FINDINGS-1.2e-load-scale.md.

DONE - LIGHT-TOUCH CONDUCTOR EVALUATION (its native MCP gateway's fit for
  D9c and D8's IR-to-engine compilation step): substantiates, rather than
  overturns, D6's existing "strongest R12 / lowest-effort compilation
  target" rating for Conductor, with concrete structural evidence -
  `SWITCH` maps closely onto `branch` (decisionCases/defaultCase plus a
  `selectedCase` output mirroring D8c's own case-selection reporting), and
  the single-task-name form of `FORK_JOIN_DYNAMIC` maps closely onto
  `map`/`forEach` (same task shape, runtime-sized cardinality). Surfaces
  three compilation-detail refinements for 5.9/5.10 to fold in if Conductor
  is ever seriously pursued as a compile target (none are blockers or new
  open questions): compile `map` specifically to the single-task-name fork
  form, not Conductor's more permissive different-task-per-fork variant;
  inline/expand forked workflow-specs rather than emit `SUB_WORKFLOW`
  references, since Conductor's native sub-workflow primitive is a live
  reference and design.md D13's fork model is explicitly not; and generate
  two separate Conductor artifacts (the `inputParameters` list and a
  companion MCP-route JSON Schema) from our own derived signature, since
  Conductor doesn't derive either natively from workflow shape. Confirms no
  native durable-governor-counter primitive exists for D9c/10.6 - same
  conclusion as every other candidate evaluated, a neutral finding. See
  spikes/1.2d-conductor-lightweight-eval/FINDINGS.md.

CLOSED, NOT REQUIRED (was: 1.2c, deferred pending a trigger) - Dapr: its
  fallback/contingency status existed specifically to cover the case where
  1.2 or the Restate evaluation (1.2a) surfaced a blocker neither resolved.
  That trigger never fired - 1.2 confirmed DEEP consolidation with real
  crash/contention/load tests, and 1.2a found no differentiator Dapr could
  plausibly offer instead (both Restate and Dapr are limited to placement-
  bookkeeping-only actors against the heavyweight SQL service, per D6's own
  finding). With D6/D6a now DECIDED and empirically confirmed rather than
  merely argued, there is no longer a contingency for Dapr to be a fallback
  *for* - closing 1.2c as confirmed-not-required, not merely re-deferring
  it again. Its one standing differentiator (a native Secrets API) remains
  a nice-to-have against the already-decided, broker-agnostic D7, not a
  reason to reopen this.

CLOSED, NOT REQUIRED (was: 1.2b, deprioritized baseline/fallback
  comparison) - Temporal: existed as a fallback/baseline comparison in case
  the Postgres-native path (1.2) didn't hold up, or as a hedge while D6 was
  still open. Neither condition applies anymore: 1.2's claims were
  empirically confirmed (not merely argued) via real crash, contention, and
  load testing (1.2/1.2e), and D6/D6a is now a locked-in decision, not an
  open question needing a baseline comparison to fall back to. Building a
  parallel Temporal-shaped engine now would cost real spike effort to
  re-confirm a comparison this design no longer needs to make a decision -
  closing 1.2b as confirmed-not-required.

ALL SPIKES IN THIS ROUND ARE NOW CLOSED (1.2, 1.2-hatchet, 1.2a, 1.2d,
  1.2e), AND 1.4 IS NOW DECIDED: the Postgres-native path (resonate-pg-
  shaped fork) is locked in - see the DECIDED status at the top of this
  section. Its DEEP-consolidation and D3-under-concurrency/crash claims are
  confirmed (spike 1.2), its scale/operational-weight claim found no
  showstopper (spike 1.2e), and neither remaining desk-research evaluation
  (1.2a Restate, 1.2d Conductor) surfaced anything that overturns this - if
  anything, 1.2a's finding widens Restate's operational-weight gap against
  it, and 1.2d's finding is orthogonal (compilation-target ergonomics, not
  an engine-selection factor). 1.2b (Temporal) and 1.2c (Dapr) are CLOSED as
  confirmed-not-required (not merely re-deferred): both existed only as
  contingencies for a blocker or an open decision that no longer exist -
  see immediately above for the closure rationale for each.
```

Run all of this alongside the D9 policy decision, since nesting-mechanism cost is coupled to whichever engine is chosen.

**Everything downstream of this decision in this design (D7-D10, and every capability spec/task in this change) is written in engine-agnostic terms** - references to "step execution," "durable history," and "child/tracked execution" describe properties that a chosen engine is expected to provide, not a commitment to any specific engine's terminology or mechanism.

### D7: Secrets travel with the request (scoped, referenced, broker-backed), never with the container

Secrets (API keys/credentials that steps need to call external services) are handled under the following model, enabled by two facts about the environment: the docker services are trusted platform-authored code, and they do not hold long-lived authenticated clients/connections. Together these eliminate the active-exfiltration and credential-caching threats, reducing the problem to avoiding accidental residue.

**Secret scope taxonomy** (a distinct axis from the data scopes in D1):

| Secret scope | Owner | Shared across | Isolation boundary |
|---|---|---|---|
| workflow-writer (main case) | the workflow-writer | every run/session of that workflow-spec | the workflow-spec / writer identity |
| user (secondary case) | the end-user | only that user's session | the session |

Writer-scoped secrets are analogous to `static` data (stable, shared across all runs, referenced by the spec, server-side, invisible to the end-user); user-scoped secrets are analogous to `session` data (per-user, session-lived, provided at runtime). Platform-shared secrets are not required.

**Rules:**

1. **Referenced, never inlined.** The DSL references a secret by name + scope; the concrete value is never embedded in the workflow-spec. This mirrors the data-binding model in D1/D4.
2. **Per-request injection, never environment variables.** Environment variables bind a secret to the container's whole lifetime, which conflicts with pooling: a pooled container reused across invocations (potentially across different workflow-writers) would retain the prior secret. Secrets are injected per-invocation into the request instead, so a pooled container stays "blank" between calls and the isolation boundary is enforced by construction.
3. **Push-by-value is acceptable here.** Because services are trusted and non-caching, the worker may resolve the secret and push it into the request payload (over in-cluster TLS). The heavier capability-token / pull-from-broker-by-the-container model is not required, since there is no active-exfiltration or credential-caching threat to defend against.
4. **Resolve inside the step's execution; keep only references in durable history.** Durable-execution engines commonly record step inputs/outputs in a durable history/log (this is a property of the class of engine under consideration in D6, not specific to any one of them). Raw secrets MUST NOT be passed as workflow/step arguments (that would persist them at rest, replayable, regardless of which engine is eventually selected). The worker resolves the secret from the broker *inside* the step's execution; only a scoped reference ever appears in recorded arguments/history. Encrypting payloads at rest via the engine's serialization/codec layer, if it offers one, is recommended as defense-in-depth.
5. **User-secret lifetime rides the session.** A user-provided secret is stored in the broker under a session-scoped path with a TTL matching the session; workflows hold only a session-scoped reference. This survives session rehydration/replay (the reference re-resolves within TTL) and is collected with the session.
6. **Secret-consuming external calls are side effects, not memoized.** Calls that use a secret to reach an external service are non-deterministic side effects and are excluded from the (input, operation) -> output memoization cache (D3). Consequently secrets never enter a content hash, and key rotation never invalidates cached results. This includes calls to external LLM/agent APIs (see D9's agent-directed composition note) - no additional secrets-model work is needed for that case, it already falls under this rule.

**Rationale**: The trusted, non-caching service environment collapses the secret-isolation problem to accidental-residue avoidance, which per-request injection + resolve-inside-step-execution handles; the remaining substantive decision is the scope/ownership model and its differing isolation boundaries (writer vs. session).

**Alternatives considered**: Environment-variable injection (rejected - incompatible with pooling, per rule 2). Capability-token / pull-from-broker-by-the-container model (deferred - stronger, but solves an active-exfiltration threat that does not exist for trusted services; revisit if untrusted service images are ever allowed). Passing secrets as workflow arguments (rejected - persists them in durable history). The specific secrets-broker product is intentionally left open (see Open Questions).

### D8: DSL splits into an authoring surface and a stable IR; the IR has static shape but dynamic cardinality/path

The DSL is deliberately split into two layers:

```
   AUTHORING SURFACE (what a writer types)  --synthesize once-->  IR (what runs)
   e.g. a declarative document, or a code-      static, versioned graph of
   based builder; MAY use non-deterministic     steps/bindings/writes/secrets/
   constructs, since it only ever runs at        outputs; THIS is what the
   author/publish time, never at workflow         scheduler and the execution
   run time                                       engine's interpreter consume
```

This mirrors the Terraform/Pulumi/CDK "synthesize a plan once, execute the plan" pattern. It resolves a potential conflict with D6: several candidate execution engines require deterministic workflow-level code, but the *authoring* language does not have to be, because the authoring step runs once, out of band, and only its static output (the IR) is ever interpreted at run time - true regardless of which engine D6 eventually selects. It also decouples "what concrete syntax do we ship" (a UX choice, could be plural - e.g. a simple declarative surface for common cases and a code-builder for power users) from "what structure must the runtime agree on" (a hard contract, decided here regardless of surface syntax or engine).

The IR is built from: a `WorkflowSpec` (metadata, `sessionState` declarations, steps, outputs); a `Step` (calls a registered service function; declares `reads` and optional `writes` bindings and secret references); a `Binding` (a discriminated source: `static` reference, `session` reference, `request` parameter, another step's output, the current item within a `forEach` body, a literal constant, or a `compute` expression - see D10); and a `WriteTarget` (a session key a step's output may be committed to, gated by the service's own change-detection signal from D4). Interactivity and seed/fallback sourcing are declared once per session key (see D8a), not repeated per binding.

Two structural properties fall out of this:

- **The dependency graph is inferred from data references**, not separately declared: a binding of `{ from: step, id: X, output: Y }` *is* the dependency edge. An explicit ordering declaration remains available as an escape hatch for steps that must be sequenced without a data dependency (e.g. side-effect-only ordering). **Validated by spike 1.5** (`spikes/1.5-ir-interpreter/`): a generic interpreter that does nothing but walk a node's own definition for `{from:"step", id}` references - with no hardcoded knowledge of any particular workflow's shape - correctly holds a node `blocked` until every dependency it references is done, and promotes it in the same transaction as the write that satisfies the last one. This included branch/map nodes' *own* dependencies (declared at the branch/map level) while keeping their *internal* case/body step ids correctly unreachable from outside - both properties fell out of walking the same binding structure, not two separate mechanisms.
- **Every workflow-spec has a derivable signature**: walking the IR for `request`-scoped bindings yields the caller-supplied parameter list; the presence of any `session`-scoped binding marks the workflow as session-requiring. This signature can be published through the same registry/discovery mechanism already used for service OpenAPI specs (D5) - workflows become discoverable to the frontend the same way services are discoverable to workflow-writers.

Real control-flow needs (conditional branching, and iteration over a collection whose size is unknown until run time) are supported without abandoning static analyzability, by keeping the **shape** of every possibility static while allowing only **cardinality** (how many map iterations) and **path** (which branch) to be dynamic:

- A **branch** construct statically declares every possible case (plus a default); only one case executes per run, but the scheduler can pre-analyze every case's service calls, secrets, and placement implications ahead of execution.
- A **map/forEach** construct statically declares the shape of a single iteration (which service it calls, its reads/writes/secrets); only the iteration count is resolved at run time, from a runtime-sized collection. Each iteration executes as an independently tracked, durable unit (see D9), so partial failure only re-runs the failed iteration.

**Rationale**: Separating authoring syntax from a stable IR avoids over-constraining the DSL's surface syntax by any one runtime engine's determinism requirements, and keeps "static, mostly-static, or dynamic" a property of specific IR constructs (branch, map) rather than an all-or-nothing property of the whole graph.

**Alternatives considered**: A single authoring-language-is-the-runtime-representation approach (rejected - would force the authoring surface to inherit a specific engine's determinism constraints directly, and would make supporting multiple authoring surfaces, or later changing the engine per D6, much harder). A fully static, fixed-shape DAG with no branch/map constructs (rejected per real workflow-writer needs identified during design - branching and per-item iteration are common, not edge cases).

### D8a: Concrete authoring surface syntax

Resolves the "authoring surface syntax" open question left by D8, worked out by writing a full example workflow-spec against every IR construct decided so far - which surfaced several refinements the abstract IR description hadn't captured.

**Format: restricted YAML, JSON-compatible, JSON-Schema-validated.** YAML is a strict superset of JSON structurally, so programmatic generation (D8's synthesize-once path) can emit plain JSON with zero translation, while hand-editing/review benefits from YAML's comments and lower punctuation noise. This also matches the Kubernetes-adjacent culture already present in this design. A **restricted profile** deliberately disallows anchors (`&`), aliases (`*`), merge keys (`<<`), and custom tags - these reintroduce non-local reference indirection that would complicate the UI's decompile requirement (D10's rationale for banning embedded code applies here too, at smaller scale). A single JSON Schema validates the parsed structure regardless of whether the source was YAML or raw JSON. Field naming is camelCase throughout, matching the OpenAPI/JSON conventions the registry already uses.

**`sessionState` is declared once per logical key, not repeated per binding.** Writing a concrete example surfaced a real redundancy risk: the same session key is often read and written by multiple steps, and repeating `interactivity`/`fallback` at every site risked inconsistency across sites for the same key. These now live in a single top-level `sessionState` declaration per key; individual `reads`/`writes` bindings reference only `{ from: session, key: ... }` / `{ to: session, key: ... }`.

```yaml
sessionState:
  sandbox_dump:
    interactivity: interactive
    fallback:
      from: static
      ref: "urn:workflow-platform:dataset:team-analytics/northwind:v2"
```

**Static-scope interactivity is not a DSL concept at all.** Unlike session state, a static dataset's interactivity is a property of the dataset itself (registered once in the static catalog, alongside D5-style capability metadata) - not something each workflow-writer redeclares per use. Only session-scoped state genuinely varies by workflow (the same service can be interactive in one workflow, batch in another), so `interactivity` only ever appears in `sessionState`.

**A new binding source, `{ from: item }`, for `forEach` bodies.** Needed for a loop body to reference its current iteration item. Deliberately minimal - it exposes the raw item value only; field extraction from a compound item reuses `compute` + JSON-Logic's `{"var": "..."}` operator rather than inventing a second path-expression syntax.

**An explicit `dependsOn: [stepId, ...]` field** realizes D8's already-required escape hatch for ordering steps with no data dependency between them.

**A workflow-spec's derived signature stays flat, named, and typed - never a path into an arbitrary nested request body.** `{ from: request, param: "query" }` means "the workflow's own declared parameter named `query`," analogous to a function argument - flattening a caller's own nested internal state into that clean parameter is the caller's responsibility, not the DSL's. Two cases remain, both already covered by existing machinery rather than new syntax: (1) a parameter's *value* may itself be a compound/nested object, passed through opaquely to whichever step's service consumes it, needing no DSL-level path syntax; (2) if the *workflow itself* needs to inspect a nested field of a parameter (e.g. for a branch selector), wrap it in a `compute` binding and use JSON-Logic's own `{"var": "a.b.c"}` operator - reusing the same mechanism as `{ from: item }`'s field extraction rather than adding a second path language.

**Static dataset references use a purpose-built URN scheme; service references correctly stay OCI-native.** A bare human-typed string (`ref: catalog/northwind`) is exactly the kind of loosely-coupled-by-convention identifier that breaks once two teams create similarly-named datasets, or someone updates one in place without any signal to existing workflows. The proven fix pattern - a mutable tag resolving to an immutable digest - is worth keeping, but OCI reference syntax is the wrong container for it: OCI refs are tied to a specific protocol and artifact type (a pullable container image), and using that syntax for a dataset would overclaim semantics that aren't true (fetchable via `docker pull`, lives in a container registry). Services correctly keep real OCI references, because they genuinely are OCI images - no overclaim there. Static datasets get a URN (RFC 8141) instead - purpose-built for a location-independent, persistent name resolved by the platform's own registry, without implying any retrieval protocol:

```
urn:<platform>:<resourceType>:<namespace>/<name>[:<tag> | @<alg>:<digest>]

urn:workflow-platform:dataset:team-analytics/northwind:v2
urn:workflow-platform:dataset:team-analytics/northwind@sha256:9f2c8e1a...
```

The `resourceType` segment (`dataset` today) keeps the scheme extensible to other globally-shared, versioned resource kinds later without cross-kind name collisions. Resolving a tag to a digest here is the same operation D2 already performs for session snapshots - the static catalog's resolved digest and D2's content-addressed snapshot key are the same kind of identifier applied to two different lifecycle stages, not a coincidence.

This implies a **dataset resource catalog** (tag → digest → storage location) as its own lightweight component, conceptually parallel to but distinct from the container/OCI registry used for services, since the underlying artifacts are genuinely different kinds of things.

**The general collision-resistance rule this surfaced**: identifiers need namespace + tag/digest treatment specifically when the referent is global and shared across an unbounded set of authors (the static catalog). Identifiers already scoped by an orthogonal identity don't need it, because collision is structurally prevented by that outer scope already - a session key is scoped by session identity, a secret reference is scoped by writer identity (D7), so plain human-chosen strings remain fine for both.

**Rationale**: Every refinement here was found by attempting to write a complete, concrete example against the already-decided abstract IR, rather than staying at the abstract level - confirming that concretizing syntax is a genuine design activity, not just a mechanical transcription of prior decisions.

**Alternatives considered**: A bespoke dotted-path syntax for `request` parameters (rejected - would create a second path-expression language alongside JSON-Logic's, for no added expressiveness). A custom URI scheme like `dataset://...` for static refs (rejected in favor of a formal URN - a custom scheme still gestures at being a fetchable location the way `http://` does, which is a smaller but similar overclaim to using OCI syntax outright). Reusing literal OCI reference syntax for datasets (rejected - see above; the pattern is worth keeping, the literal format is not). Bare UUIDs as the primary static reference form (rejected - globally unique but not human-readable, losing namespace/hierarchy context that a URN retains).

### D8b: The dataset resource catalog's byte store is dedicated object storage, not the artifact registry

Resolves the "dataset resource catalog product/implementation" open question left by D8a, by applying the same index/byte-store split D12 later formalized for the service registry: the tag→digest→storage-location **index** is a thin, bespoke, unavoidable component regardless of product choice (a small lookup table, whatever backs it), while the **byte store** underneath a resolved digest is a product choice this decision settles.

**The byte store is dedicated object storage (S3/GCS/MinIO-shaped), not the artifact registry used for D12's `oci_ref`.** Both options were considered and both are consistent with D8a (neither exposes OCI syntax to the workflow-writer, who only ever sees the URN):

```
   OPTION CONSIDERED: reuse the artifact registry
     store dataset bytes as an OCI artifact (custom media type) in the
     same registry deployment backing D12's oci_ref - one artifact-
     storage system total, plus registry-native replication/GC and
     (if supported) Cosign/Notation-style signing "for free"

   CHOSEN: dedicated object storage
     dataset bytes live in a plain object store; the index maps
     URN -> digest -> object key
```

**Rationale is the consumption path, not the registration path.** D1/D2's materialization reads a dataset's bytes into a running service - a large-blob-GET workload (D1's matrix explicitly considers "tens of GB" scale), not a `docker pull`-shaped one. An artifact registry can technically serve arbitrary-sized OCI blobs, but nothing is gained from registry-native pull tooling once the materialization path fetches the blob directly anyway - that would make the registry an expensive object-store facade bought at the cost of adapter-layer friction (mapping the URN's namespace/name onto the registry's repository-naming rules, and depending on a specific product's OCI-artifact-manifest support being solid rather than image-only). Object storage is the native fit for the workload that actually exists.

**Accepted cost.** This forgoes the "for free" integrity/signing story (Cosign/Notation-style provenance) and the operational consolidation of registering datasets and service images in one artifact-storage system, both of which the rejected option would have provided. Dataset integrity/provenance is not required by any decision so far; if a real need for it emerges, it can be layered onto object storage independently (checksums, a signing scheme) rather than requiring an artifact-registry dependency to get it.

**This does not reopen or conflict with the D6 Postgres-consolidation finding.** That finding (design.md, D6 discussion) is about the tag→digest→location **index** potentially sharing a Postgres instance with the placement-resolver, durability layer, and session log if a Postgres-native engine is chosen for D6 - a statement about where the *index* lives. This decision is only about where the resolved **bytes** live; the two are independent and this decision imposes no constraint on D6.

**The specific object storage product is deferred**, same posture as the secrets-broker product (D7) and the OCI-registry product/topology (D12): the model (dedicated object storage, index separate from bytes) is decided; which product (S3, GCS, MinIO, or another S3-compatible store) is not.

**Rationale**: Mirrors D12's own architecture (index vs. deferred byte-store) rather than treating the dataset catalog as a novel problem, and resolves the byte-store product question by the actual workload shape (large-blob materialization) rather than by superficial similarity to how service images are stored.

**Alternatives considered**: Reusing the artifact registry via OCI Artifact Manifests (rejected - see rationale above; wins on registration/integrity/ops-consolidation but loses on the consumption path, which is the workload that actually recurs). A hybrid (register in the artifact registry for integrity/audit, but resolve to a direct object-storage copy for materialization) - not rejected outright, but deferred as unjustified additional complexity unless a concrete integrity/provenance need for datasets emerges; simpler to add later than to build now speculatively.

### D8c: Concrete syntax for steps, secrets, branch, and literal bindings

Continues D8a's method (write a complete concrete example against the abstract IR, capture what falls out) for the constructs D8a's own example didn't exercise: step invocation, secret references, `branch`, and the still-unspelled "literal constant" binding kind from D8's own Binding enumeration.

**A step's secret references are a separate block from its data bindings, not a binding kind.** D8's IR summary (line 401) already describes a `Step` as declaring "`reads` and optional `writes` bindings **and secret references**" - two distinct categories, not secret-as-a-`Binding`-kind. This is confirmed by D10's rule that a `compute` binding's `using` inputs "SHALL NOT accept a secret reference" - phrased as a categorical exclusion, which only makes sense if secrets aren't a `Binding` kind that could otherwise slip in like any other source. Concretely:

```yaml
steps:
  - id: runQuery
    service: "registry.internal/sql-exec@sha256:9f2c8e1a..."   # always a digest - see below
    function: query
    dependsOn: [loadDump]
    reads:
      dump: { from: session, key: sandbox_dump }
      sql:  { from: request, param: query }
    secrets:
      apiKey: { scope: writer, name: sqlExecApiKey }
    writes:
      dump: { to: session, key: sandbox_dump }
```

**`writes` gating is automatic runtime behavior, never an authored flag.** A `WriteTarget`'s change-detection gating (D4) is implicit whenever a `writes: {to: session, ...}` binding exists - there is no separate `gated: true` field for the workflow-writer to set or forget.

**A step's `service` reference is always a full digest, typed by the author (or inserted by a tool's usability layer) at authoring time - never a mutable tag re-resolved dynamically.** This deliberately differs from how a static-dataset `ref` resolves (D8a: tag or digest, resolved dynamically at the time of resolution), and the asymmetry is intentional, not an oversight: D5a's trust tier is keyed to a specific image digest, and a redeploy under the same name produces a new digest that "starts over" at `unverified` with no inherited trust. If a service reference floated like a dataset tag, an already-authored workflow that earned `production-proven` trust (enabling pooling/sharing/COW-reuse) could have its underlying build silently swapped out from under it the moment anyone redeploys - collapsing to conservative placement without the author's knowledge, or worse, silently exposing the isolation guarantee itself to a buggy new build's false capability claim. A dataset reference carries no such stake (D13: workflows and datasets carry no trust tier), so floating under a tag is a pure convenience win there with nothing to lose. Same reference *shape*, opposite resolution rule, for a principled reason - not an inconsistency to reconcile.

**Step identifiers are human-chosen strings, validated unique within the whole workflow-spec - not auto-generated, and not scoped per branch-case or per-map-body.** This follows directly from D8a's own collision-resistance rule (design.md:455): namespace/digest treatment is needed "specifically when the referent is global and shared across an unbounded set of authors"; a step id's scope is a single workflow-spec document, authored by one party - the same bucket D8a already puts session keys and secret names in ("plain human-chosen strings remain fine"). The global (not per-case) scoping matters because `{from: step, id: X, output: Y}` and `dependsOn` resolve against one flat id-namespace regardless of which branch case or map body a step happens to sit inside.

**`branch` cases are a map keyed by the selector's stringified value, not a list, and each case carries its own `yields`.** Mirrors JSON-Logic's own value-keyed style rather than inventing a `{when, steps}` list shape. The `yields` field is explained below alongside `map`'s identical need for it - a case's internal steps are only conditionally executed, so anything after the branch needs a stable, case-independent name to read the outcome through, exactly as `map`'s body does:

```yaml
- id: classify
  kind: branch
  selector:
    compute: { ">": [{ var: "count" }, 100] }
    using:
      count: { from: step, id: runQuery, output: rowCount }
  cases:
    "true":  { steps: [ { id: vipPath, ... } ], yields: { result: { from: step, id: vipPath, output: x } } }
    "false": { steps: [ { id: stdPath, ... } ], yields: { result: { from: step, id: stdPath, output: x } } }
    default: { steps: [ { id: fallbackPath, ... } ], yields: { result: { from: step, id: fallbackPath, output: x } } }
```

**The "literal constant" binding kind (named in D8's own Binding enumeration but never spelled) is `{ literal: <value> }`.** `<value>` may be an arbitrary JSON value/structure, passed through opaquely - the same "a parameter's value may itself be a compound object" rule already governing `request`-scoped bindings applies here. This is also how a nesting target's concrete function reference or an allowlist is supplied (D9c), since no dedicated "function reference" binding kind is needed: `allowedTools: { literal: [{ service: "...@sha256:...", function: enrich }] }`.

**`yields` is the general mechanism for exposing a named result out of *any* internal step sub-graph - a `map` body, a `branch` case, or (under the existing name `outputs`) the top-level workflow itself - and it resolves the gap this decision originally deferred.** Once a body/case can contain more than one step, nothing says which step's output is "the" result: position-based inference (last step wins) breaks under reordering and under a body/case that itself contains a branch; collecting every internal step's output into one object per result breaks the "signatures stay flat, named, typed" rule (design.md:440) the top-level `outputs` block already follows. The fix generalizes that same rule inward:

```
   outputs (top-level workflow)   →  { name: Binding, ... }   pointing into the top-level graph
   yields  (a map body)            →  { name: Binding, ... }   pointing into that body's steps
   yields  (a branch case)         →  { name: Binding, ... }   pointing into that case's steps
```

```yaml
- id: enrichEach
  kind: map
  source: { from: step, id: runQuery, output: rows }
  body:
    - id: fetchDetails
      service: "registry.internal/lookup-svc@sha256:aaa..."
      function: lookupDetails
      reads:
        key: { from: item }
    - id: enrichOne
      service: "registry.internal/enrichment-svc@sha256:abc..."
      function: enrich
      reads:
        record:  { from: item }
        details: { from: step, id: fetchDetails, output: details }
  yields:
    enrichedRecord: { from: step, id: enrichOne, output: enrichedRecord }
    wasFlagged:      { from: step, id: enrichOne, output: flagged }
```
Downstream, `{ from: step, id: enrichEach, output: enrichedRecord }` resolves to the array of per-iteration `enrichedRecord` values (and `wasFlagged` to the parallel array of flags), regardless of how many steps the body contains or in what order they're declared. The same stability argument applies to `branch`: a step after a `branch` reads `{ from: step, id: <branchId>, output: <name> }`, which resolves through whichever case's `yields` actually ran - never a reference to a specific case's internal step id, which would only conditionally exist.

**`yields` is required whenever a body/case contains more than one step; with exactly one step, it defaults to that step's whole output object.** This keeps the trivial single-step case (the common one) unburdened by boilerplate, while requiring explicitness exactly where the ambiguity this decision is solving actually exists - there is no "last step wins" fragility with only one candidate step to begin with. An explicit `yields` remains legal even for a single-step body/case, e.g. to expose one field rather than the whole response object.

**A soft expectation, not a hard rule this decision enforces**: every case of a given `branch` should produce the same logical shape under the same `yields` names, so a downstream reference means the same thing regardless of which case ran. This isn't mechanically checkable at the schema level (it's a semantic-type claim, not a structural one) and is left to authoring discipline and the derived-signature layer, not a new validation requirement.

**Rationale**: Same method as D8a - concrete syntax is a genuine design activity, and secrets-as-a-separate-category, digest-only service pinning, document-scoped step ids, and `yields` all turn out to be direct consequences of rules this design already committed to elsewhere (D7/D10, D5a/D12, D8a's collision-resistance rule, and design.md:440's flat-signature rule, respectively), not fresh judgment calls.

**Alternatives considered**: Secret references as a `Binding` kind (`{ from: secret, ... }`) (rejected - would make D10's categorical exclusion of secrets from `compute` awkward to state, and blurs a distinction D8's own IR summary already draws). A dedicated "function reference" binding kind for nesting targets (rejected - `literal` already covers it with no new grammar). Auto-generated/opaque step ids with a separate display label (rejected for the grammar itself - D8a's own collision-resistance rule already classifies this as a document-scoped identifier where human strings are fine; a tool MAY still auto-suggest default id values, but the grammar doesn't need a two-field id/label split). `branch` cases as a list of `{when, steps}` objects (rejected - a value-keyed map is simpler and matches JSON-Logic's own idiom). Position-based ("last step wins") or collect-everything output inference for `map`/`branch` (rejected - see the fragility/flatness arguments above; explicit `yields` is the direct generalization of the flat-signature rule already governing top-level `outputs`). Always requiring explicit `yields` even for single-step bodies/cases (rejected as unnecessary boilerplate for the common case, where no ambiguity exists to resolve).

### D8d: Retry/timeout and per-step error-handling have no DSL surface; the IR version field name is locked; branch/map nesting depth is unrestricted

Closes out the remaining items surfaced by auditing D8's original construct list against D8a/D8c's concrete syntax: two "does this need syntax at all" questions (resolved: no), one formality (resolved: yes, lock it), and one confirmation (resolved: no restriction).

**Retries, backoff, and timeouts are platform-managed defaults, with zero DSL surface.** No step-level `retry:`/`timeout:`/`backoff:` field exists or is planned. This differs from D1's "declare intent, not mechanism" pattern (which still gives the workflow-writer an authored *intent* - `interactivity: interactive` - even though the mechanism is chosen elsewhere) - here there is no author-facing intent at all, because unlike placement (where different workflows genuinely want different affinity behavior), retry/backoff/timeout policy is treated as a uniform platform guarantee every step gets, not a per-workflow tuning knob. If a real need for per-step override emerges later, it would be new DSL surface added deliberately, not something implicitly already possible today.

**There is no DSL-level error-handling/fallback/compensation construct.** `branch` and `map` are the DSL's only control-flow constructs, and both dispatch on a runtime *value*, never on step *failure*. A failed step (after exhausting the native engine's retry policy) propagates as workflow failure; there is no "if step X fails, run step Y instead" construct. This is a deliberate scope boundary, not an oversight left implicit: compensation/fallback logic is a real, larger feature (it needs its own failure-classification and partial-rollback semantics) that this design does not attempt.

**The IR version field is `irVersion`, not merely an example name.** D11 introduced it as "e.g. `irVersion: N`"; every worked example since D8c has used it by convention. This decision locks it as the actual field name, at the top level of a `WorkflowSpec` document.

**`branch`/`map` nesting depth is unrestricted.** A `branch` case's steps may contain another `branch` or `map`; a `map` body may contain another `branch` or `map`; recursively, to any depth. This requires no new syntax - it falls directly out of a case/body being "a list of steps," which recursively may itself contain a `branch`/`map` step - and no depth limit is imposed by this decision. (Whether pathologically deep nesting has a real pre-analysis cost worth bounding is left to implementation/observation, not pre-emptively restricted here.)

**Rationale**: All four follow the same shape as this session's other syntax-audit findings - checking whether a candidate construct needs new grammar, and finding either that it structurally doesn't (nesting depth, error-handling scope), that it's explicitly excluded as a scope boundary (retry/timeout, error-handling), or that it merely needed a "e.g." upgraded to a decision (`irVersion`).

**Alternatives considered**: Author-configurable per-step retry/timeout (rejected for now - no concrete need identified; platform-uniform defaults are simpler and can be relaxed later without breaking existing workflow-specs, since adding an optional field is backward-compatible under D11's migration model). A DSL-level catch/compensation construct (rejected as out of scope - a real feature, but a substantially larger one than this design set out to cover; native engine retry is deemed sufficient for this design's scope). Leaving `irVersion` as a non-binding example rather than locking it (rejected - every artifact captured since D8c already uses it as if decided; leaving it formally open served no purpose). A fixed nesting-depth limit (rejected - no evidence yet that deep nesting causes a real problem; premature to constrain without one).

### D9: Compose vs. nest - workflows are *composed* (in the workflow-spec store), services *nest* other services (a mandatory-by-default policy), and agent-directed nesting is one case of it

**Terminology, disentangled.** Two things earlier drafts of this decision conflated under "composability" are now split into distinct words, because they are distinct activities with distinct owners and distinct storage:

- **Compose** = building a *workflow* out of steps over service functionality. The workflow *is* the composite. This is a workflow-writer activity, expressed in the DSL, and a workflow-spec is a first-class entity stored in the **workflow-spec store** (D13) - *never* a registry entry.
- **Nest** = a *service function*, while executing, invoking *other* registered services' functionality from inside its own container code. This is a service-author-declared *possibility* (recorded in the registry as D12's `nesting_declaration`) whose *concrete* target is bound at the workflow-spec/DSL level.

D9a below is revised accordingly (workflows are not "composite registry entries"); D9b/D9c concern *nesting* specifically and are framed in that vocabulary. The forward-note in D12 flagging this reconciliation as pending is resolved by this rework together with D13.

A durable-execution engine's child/step-execution primitive - a running workflow can start one or many additional tracked executions, including dynamically and in a loop, without the parent terminating, with each getting its own durable tracking, retries, and secret/placement resolution - is the general mechanism behind D8's map construct, and is available generally wherever a unit of work needs to fan out dynamically without leaving the orchestrator's visibility. (The concrete shape of this primitive is engine-dependent - see D6 R11/R12 - native child-workflow-style constructs, actor-to-actor calls, and uniform durable invocations are the three shapes considered.)

This surfaced a broader question during design: what happens when a trusted service, while executing a single step, itself needs to call *other* registered services (e.g. a "batch enrichment" service iterating internally and calling an enrichment service per item)? Two shapes were identified:

```
   (a) HIDDEN LOOP: the service calls other services' raw endpoints directly
       from inside its own container code. Simple to write, but invisible
       to the orchestrator - forfeits per-item retry, secret scoping (D7),
       and placement (D4) for every call it makes, and a crash mid-loop
       can cause the engine to retry the WHOLE step, double-processing
       already-completed inner calls.

   (b) ORCHESTRATED LOOP: the service's internal calls to other services
       are themselves tracked as child/step executions, preserving every
       guarantee (D2,D3,D4,D5,D7 - D6 is the open engine choice itself,
       not a guarantee to preserve) per inner call, at the cost of the
       calling service needing to act as an orchestration client rather than a
       plain HTTP service.
```

This has since resolved into three concrete decisions, unresolved only in the mechanism's engine-dependent cost (D6).

**D9a: Workflows are workflow-store entities, reused by fork - not registry entries.** A workflow-spec that another workflow-writer wants to reuse is *not* published as a registry entry (the registry holds service images only, D12). It lives in the **workflow-spec store** (D13) under a URN identity + immutable version, exposing its derived signature (D8) exactly as a service exposes its OpenAPI signature. Reuse works by **fork**, not by a live reference: the source workflow-spec's shape and steps are copied into the forker's own namespace at authoring time, producing a self-contained workflow-spec with an immutable lineage pin back to the exact source version - never a runtime dependency on the source, and never an inherited writer-scoped secret (D13 explains why: D7's secret-scoping boundary cannot be honored by a live reference without either crossing a writer-identity boundary or complicating every consumer's signature). *Dynamic* fan-out (D8's map/forEach, whose cardinality is unknown until run time) is unrelated to this and continues to use the child/step-execution primitive described above - forking is purely about workflow-to-workflow reuse, not about fan-out. This reverses the earlier "composite registry entry" framing entirely: there is no runtime resolution of one workflow-spec by another at all now, only an authoring-time copy with a lineage pin (see D13 for the full model, including the deferred visibility/tenancy, lineage-cycle, and IR-version-mismatch-on-fork questions).

**D9b: Inter-service nesting is mandatory-by-default; bypass requires a declared, reviewed exception.** For the harder case - a leaf service's own container code wanting to call *other* registered services on its own initiative (shape (a)/(b) above) - the default is orchestrated (b), not hidden (a). This extends a pattern already used repeatedly in this design (D4/D4a: affinity is optional but never silent; D5a: trust is earned, not assumed): the safe path is the default; the risky path is never a silent per-container choice. A service that wants to bypass the orchestrator-aware path must declare it explicitly (transport + forfeited guarantees named), and that declaration is subject to the same trust-tier review as any other capability claim (D5a) - it is not trusted on assertion alone. This is a **policy** decision, decidable now; only the **mechanism cost** of compliance (how expensive the orchestrator-aware SDK is to adopt) stays coupled to D6, since that varies materially by engine family (Temporal's separate child-workflow SDK vs. Restate/Dapr's "same primitive as any other call").

A nesting service's capability declaration (D12's `nesting_declaration`, extending D5) records whether its reachable target set is **enumerable** (a fixed list, known at registration) or **open** (determined per-invocation by an external decision process), plus the transport: `nesting_declaration: { via: sdk | http | cli | mcp, targets: [...] | open }`.

**D9c: Agent-directed nesting is the `targets: open, via: mcp` case of D9b - not a separate IR construct.** An "agent-directed step" is not a distinct kind of step. It is an ordinary step invoking an ordinary registered service (an "agent-runner") whose own capability declaration is `nesting_declaration: { via: mcp, targets: open }`. This collapses what earlier looked like bespoke agent machinery into the generic model:

```
   ALLOWLIST AND GOVERNOR ARE ORDINARY REQUIRED PARAMETERS, not new IR:
   the agent-runner service's own OpenAPI signature declares `allowedTools`
   and `governor` as required inputs, exactly like any other function
   parameter. The DSL's already-generic "a step's binding must satisfy
   every required parameter" rule (workflow-dsl) enforces "you must
   supply an allowlist and a governor" with no agent-specific validation.

   ENFORCEMENT happens in the nesting-enforcement layer (D9b), not the
   DSL: the layer refuses out-of-allowlist calls and withholds secrets
   for them at DISPATCH TIME, regardless of the agent-runner's own
   behavior - the same dispatch-time enforcement any open-target
   nesting service needs, not something bespoke to agents.

   THE GOVERNOR MUST BE DURABLE: its accumulated count/cost is checked
   before each dispatch and persists across a crash-and-resume, or
   durability (the very thing R6/R12 exist to provide) becomes an
   accidental way to bypass the cap it's supposed to enforce.

   PURE COMPUTE-BACKED TOOLS (D10) ARE EXEMPT from allowlist review:
   a computed binding cannot invoke a service, touch a secret, or
   produce a side effect by construction, so it can be offered to an
   agent-runner invocation for free, without review.

   MCP IS ONE TRANSPORT VALUE, not a separate subsystem: it sits
   alongside sdk/http/cli in the SAME `via` enumeration. Its concrete
   realization is a gateway that translates allowlisted OpenAPI
   operations into MCP tool definitions dynamically, scoped per
   invocation to that invocation's allowlist, and routes every tool
   call back through the same dispatch/secret/governor path as any
   other nested call - never a parallel bypass path. This also means
   REST, CLI, and MCP become three projections of the same registry
   entry + OpenAPI contract, not three independently maintained surfaces.
```

**Who drives the agent loop, resolved**: because the agent-runner is *a service*, invoked as *a step*, its execution lifecycle is ours end-to-end by construction, the same as any nesting service - this settles in favor of the platform hosting the loop as part of step execution, not an externally-hosted agent driving it from outside. A genuinely different idea - exposing the registry *outward* as an MCP server to arbitrary third-party agent hosts (not a step inside any of our workflows at all) - remains a distinct, not-currently-in-scope product surface, noted here so it isn't confused with what D9c actually decides.

**The allowlist binding is required to be a `literal` (D8c), not dynamically bound - which is what makes pre-warming its targets meaningful.** Even though an agent-directed step's *inner call sequence* is genuinely unbounded and unanalyzable ahead of time (see the Risks/Trade-offs entry below), the *reachable set* the allowlist names is fully known the moment the step's inputs resolve - literal-only binding makes that true at the same static-analysis point branch/map already enjoy, not merely at dispatch time. That set is a natural input to placement, but it is **not** grounds for unconditionally pre-warming every listed target regardless of how many are actually likely to be called: doing so would risk starving other pinned/warm state under D4a's shared capacity budget for tools that may never be invoked. Instead, allowlist resolution SHOULD feed D4a's existing cache-admission model as **candidates** - promoted to warm/pooled only if they clear the same size/frequency/capacity bar as any other binding, never as an automatic, unconditional pre-warm-all action. This needs no new mechanism: it is D4's "affinity is always an optimization, never a correctness requirement" applied to a source of candidates D4a didn't previously have a name for.

A further, non-engine implication carried over from the original agent-composition finding: services reachable by an agent-directed (or any open-target) invocation cannot assume they are only ever invoked downstream of validation performed earlier in an authored DAG - such services need to validate their own inputs defensively, similar to a public API, rather than trusting pipeline context.

**Rationale**: The technical mechanism for dynamic, non-terminating fan-out (a child/step-execution primitive) is already required for D8's map construct. Splitting "how a workflow is reused" (D9a: a workflow-store entity, reused by fork, unrelated to fan-out), "is nesting orchestrator-aware by default" (D9b, a policy decidable now), and "how is agent-directed nesting expressed" (D9c, a specific case of D9b rather than a fourth thing) avoids inventing separate machinery for what turns out to be, for D9b/D9c, the same underlying model applied twice - while D9a is deliberately a *different* mechanism (fork, not the child-execution primitive), because workflow-to-workflow reuse and dynamic fan-out are genuinely different problems.

**Alternatives considered**: Treating agent-directed nesting as a distinct IR construct with its own allowlist/governor validation (rejected - fully subsumed by D9b's generic nesting model plus the DSL's already-generic required-parameter rule, with nothing lost). Treating nesting as purely a service-author concern outside the platform's model (rejected as a permanent stance - D9b's mandatory-by-default policy, backed by D5a's trust tiers, closes this). Allowing agent-directed steps unrestricted registry access (rejected - the allowlist requirement keeps D7's secret-scoping model intact). Exposing the registry outward to third-party agent hosts as an alternative to D9c (not rejected, but explicitly out of scope here - a distinct product surface, not a variant of this decision). Publishing a workflow-spec as a registry entry, as originally framed in D9a (rejected on reflection - conflated two different kinds of thing, a service image and a workflow-spec, under one storage model; see the terminology split above and D13).

### D10: Pure, bounded computation is a `compute` binding evaluating a serializable logic expression - never embedded imperative code

The funded UI authoring tool (see D8 background) must be able to open and *edit* arbitrary existing workflow-specs, not merely view them. This rules out embedding opaque imperative code as runtime content anywhere in a spec: arbitrary code is not decomposable into a visual model the way branch/map already are, so a spec containing it could never be fully edited by the UI. Code remains usable only as a *build-time generator* that emits ordinary IR (D8's synthesize-once pattern) - never as a construct interpreted at workflow run time.

This still leaves a real need: branch selectors, map source collections, and simple derived values often require a small comparison or transform (e.g. "is this value above a threshold", "extract a field"). Rather than requiring a dedicated registered utility service for every such case, the IR gains a new binding kind:

```
Binding (extended further)
  └── { compute: <logic-expression>, using: { varName -> Binding, ... } }
```

`compute` evaluates a bounded, serializable, side-effect-free logic expression against a data context built from its already-resolved `using` bindings. This is not "code" in the sense D9's discussion ruled out: it is total (no loops/recursion beyond bounded, pure array operators), side-effect-free, deterministic, and - critically - structurally decomposable into the same kind of nested operator/argument tree that visual rule-builder UIs already target natively, so it satisfies the UI's arbitrary-edit requirement rather than straining it.

**JSON-Logic is selected over CEL.** Both were considered; JSON-Logic wins because it follows directly from this decision's own central requirement:

```
JSON-Logic is a JSON tree ({"==": [{"var":"category"}, "flagged"]}).
Existing visual rule-builder components (e.g. react-querybuilder and
similar) already emit/consume this shape natively - lower UI-build risk
for the funded UI project than any alternative here.

CEL is a compact STRING expression - richer typing, better fit with the
Kubernetes-adjacent ecosystem already in play (admission policies,
Envoy), but embedding it means either a text/code editor widget (which
strains the "structurally decomposable" property that ruled out
embedded code in D9 in the first place) or a bespoke CEL-AST-to-visual-
tree mapping with no off-the-shelf equivalent to JSON-Logic's query
builders.
```

CEL's advantages (richer typing, K8s-ecosystem familiarity) matter most for validating complex typed API objects, which is not this decision's use case - `compute` bindings operate over already-resolved, already-typed binding values. JSON-Logic's narrower operator set is a feature here, not a limitation, consistent with keeping this construct deliberately bounded.

**Consequences:**

- **Free to evaluate.** Because it is pure and deterministic, a `compute` binding evaluates inline within the execution engine's interpreter itself, whichever engine is eventually selected (D6) - no step/activity scheduling, no registry lookup, no placement decision (D4), no capability declaration (D5). It is structurally out of scope for the scheduler, not merely cheap.
- **Secrets are structurally excluded.** A `compute` binding's `using` inputs SHALL NOT accept a secret reference. Combined with D7's rule that secrets resolve only inside a step's execution, this means a workflow-spec cannot leak a secret through a logic expression by omission rather than by enforced policy.
- **Disambiguated from D8's dynamic map/forEach.** A logic language's own bounded array operators (e.g. map/filter/reduce over an already-resolved, finite array) are pure in-memory computation and must not be conflated with the DSL-level `map`/`forEach` construct, which fans out to services as tracked, durable child executions (D9).
- **Narrows, rather than eliminates, the utility-leaf-service idea.** Utility services remain appropriate for transforms that are not pure/bounded (real I/O, heavier processing, domain-specific logic); `compute` bindings are preferred whenever a transform is pure and bounded, avoiding an ever-growing library of trivial registered services (compare, extract-field, threshold-classify, ...) each carrying a full registry entry and container.

**Rationale**: Reuses a principle already present elsewhere in this design (D4 pushes mechanism into the scheduler, D5 pushes capability facts into the registry) - here, pure computation is pushed into a bounded expression rather than into either the IR's control-flow grammar (which stays free of a general expression language) or a proliferation of trivial services.

**Alternatives considered**: A general expression/scripting language embedded in the IR (rejected - reintroduces the decomposability problem D9's code prohibition was meant to avoid, just with a friendlier syntax). A mandatory registered "utility service" for every simple comparison/transform (rejected as the default - unnecessary operational overhead and a step-execution round-trip for what is often a single comparison; remains available for the non-pure cases it's actually suited to). CEL (rejected in favor of JSON-Logic per the comparison above, primarily on UI-decomposability grounds).

### D11: IR schema versioning is a whole-document tag, migrated lazily and forward-only

The funded UI project has its own, independently-timed release cadence, separate from the platform backend - meaning the UI could plausibly lag behind whatever IR version the backend is producing at any given moment. This is a structural consequence of two funded workstreams moving independently, not a hypothetical edge case, and it is why versioning needs an explicit answer now rather than being deferred until the UI project starts.

```
VERSION TAG: a single, whole-document version field, `irVersion: N`
(locked as the actual field name by D8d, not merely an example),
bumped only on BREAKING changes. Additive constructs (a new binding
kind, a new step field with a sensible default) do NOT bump it.

MIGRATION: forward-only, lazy-on-open. An old document is passed through
a chain of pure migrator functions (v(n) -> v(n+1) -> ... -> current) the
first time it is opened, then re-saved in canonical current-version form.
This composes with the already-established behavior that a UI-driven
save normalizes the document (comments/formatting may not survive a
round-trip) - migration-on-open is one more reason a save might differ
from what was loaded, not a new kind of behavior.

VERSION-TOO-NEW CASE (the one the UI's independent cadence makes real):
FAIL CLOSED with a clear "unsupported version" error. Never guess or
best-effort-parse a version newer than what the reader understands.

DEPRECATION: define a minimum supported window (e.g. current minus 2
versions); require a batch migration sweep over stored specs before
retiring old migrator code, rather than keeping every migrator forever.
```

Deliberately simpler than Kubernetes' storage-version/served-version split: that machinery exists to serve a public, multi-client API surface, whereas this is a closed, single-organization document format. A single stored version plus migrate-on-read is proportionate; multi-version serving can be revisited if a real need for it emerges later.

**Rationale**: Answers the "IR schema versioning/migration" open question left by D8, specifically motivated by the UI project's independent timeline rather than treated as a generic best practice to defer indefinitely.

**Alternatives considered**: Per-construct versioning (rejected for now - adds complexity with no clear benefit while the IR is authored/synthesized as a whole document per workflow-spec, not assembled from independently-versioned fragments). Kubernetes-style multi-version serving (rejected as premature - the operational cost isn't justified until there's a concrete need for the runtime to serve more than one IR version at a time).

### D12: The service registry is a first-party metadata index, not an image byte store

Every prior decision that touches "the registry" (D5's capability metadata, D5a's trust tiers, D9's composition declarations, `workflow-dsl`'s function/parameter validation, `execution-scheduling`'s placement inputs) has treated it as an existing, external, unspecified dependency. It has no owner and no defined schema or query contract anywhere in this change, despite being the single most-depended-on component in the whole design. This decision brings it into scope as a first-party capability, `service-registry` (see `specs/service-registry/spec.md`), rather than continuing to assume it.

**Update (tasks 2.1/2.1a-c/2.2/2.5/2.8/2.10): this design is now a working implementation, not just a schema description.** See `registry/` - a Postgres-backed `service_images`/`function_capabilities` schema implementing every entry field described below, `getPlacementFacts` as a single atomic query (2.8), and the privilege split (2.10) enforced structurally (two modules with disjoint exports: `registry/src/admin.js` for `registerImage`, `registry/src/conformance.js` for `recordTrustTier` - nothing in a runtime-facing module can import the former), verified against a real Postgres instance (27/27 assertions passing, including a referential check that capability metadata's function keys actually exist in the entry's own `openapi_spec`). Conformance probing itself (2.4/2.6/2.7) and backfilling real images (2.3) remain deferred - this implements the tier *storage* and *metadata index*, not the pipeline that populates trust tiers from real service behavior.

**Scope: a metadata index, not an image store.** The registry owns facts *about* a service image, keyed by that image's digest; it does not own the image bytes themselves. Each entry carries an `oci_ref` pointer into a standard OCI-compliant registry (product/deployment topology deferred, same posture as D7's secrets-broker-product deferral) - byte storage, pull auth, replication, and image GC stay out of scope for this component, exactly as D6's engine selection and D7's secrets-broker product are deferred elsewhere in this design.

```
   ENTRY (per-image build, keyed by digest)
   ├─ openapi_spec         SOLE STORED CONTRACT. CLI and MCP tool
   │                       surfaces are projected from it at read time
   │                       (per D9c/design line ~524) - never stored
   │                       separately, so the three surfaces cannot drift.
   ├─ capability_metadata  per-FUNCTION (D5): mutates?, materialization-
   │                       cost-class, COW-support, change-detection
   ├─ trust_tier           per-DIGEST (D5a): unverified / conformance-
   │                       passed / production-proven
   ├─ hardware_requirements per-IMAGE (cpu/mem/gpu/node-class) - a
   │                       performance/placement fact, deliberately
   │                       OUTSIDE the D5a trust-tier model: a false
   │                       declaration here is a bin-packing/OOM problem,
   │                       not an isolation-correctness one, so it is
   │                       corrected by observation (D4's runtime-
   │                       observed characteristics), not by conformance
   │                       probes
   ├─ nesting_declaration  per-FUNCTION: does this function's own
   │                       container code call other registered
   │                       services' functionality? If so: transport
   │                       (`sdk|http|cli|mcp`) and target shape
   │                       (`enumerable: [...]` | `open`). This is the
   │                       *possibility* only, declared by the service
   │                       author - the schema-level home for what D9b
   │                       currently names `composes:` (naming to be
   │                       reconciled - see note below). The *concrete*
   │                       nested function a given workflow wires in is
   │                       a DSL-level binding, not a registry fact.
   └─ oci_ref              pointer to the image in a standard OCI
                           registry; byte storage itself is deferred
```

**Resolution pins a digest at authoring time.** A workflow-spec step binds to a specific image digest when authored, not a mutable tag. This keeps a workflow's earned trust tier (D5a) stable and predictable for its lifetime - a later redeploy produces a new digest that starts over at `unverified` (per D5a's existing rule) without silently affecting any workflow-spec authored against the prior build. The direct consequence - a pinned workflow never automatically inherits a newer build's fixes - is accepted here; an explicit re-pin/upgrade flow (an author deliberately moving a binding to a new digest) is a real, deferred affordance, not yet designed.

**Reads are split by consistency need.** Authoring-time reads (existence/signature lookups for DSL validation and discovery) are interactive and cacheable. Dispatch-time reads are hot-path and correctness-critical: `getPlacementFacts(digest, function)` returns capability metadata, trust tier, and hardware requirements as **one atomic read**, so the scheduler never sees these three facts skewed relative to one another (e.g. a trust demotion landing between two separate reads).

**Writes are split by privilege, not merely by operation.** Two distinct write paths, deliberately gated to different actors:

```
registerImage(digest, openapi_spec, capability_metadata,
              hardware_requirements, nesting_declaration, oci_ref)
    -> PLATFORM DEVELOPERS ONLY. The workflow-platform runtime has
       no path to call this - it can never introduce a new image.

recordTrustTier(digest, tier)
    -> the WORKFLOW PLATFORM (its conformance/CI pipeline, D5a/
       tasks 2.4-2.7) - the runtime can promote/demote trust on an
       already-registered image, never register one.
```

This makes an important invariant structural rather than a policy convention: the set of images that can ever be invoked is entirely developer-curated; the runtime's only authority over that set is annotating trust on top of it.

**Registry entries are service images only.** A registry entry never contains a workflow-spec. What D9a originally called a "composite registry entry" is superseded: workflows are a distinct kind of thing from services (see the compose/nest terminology note below), stored and reused entirely through the separate workflow-spec store (D13, via forking, not a live reference) - never through this registry. This decision fixes that *this* component, the service registry, is scoped to service images; D13 specifies the workflow-spec store itself.

**Rationale**: Splitting by consistency need (authoring vs. dispatch reads) and by privilege (register vs. trust-tier writes) follows the same pattern already used repeatedly in this design (D4/D4a: affinity is optional but never silent; D5a: trust is earned, not assumed; D9b: the safe path is the default) - draw the boundary where the actual risk or cost differs, rather than exposing one undifferentiated read/write surface.

**Alternatives considered**: Storing image bytes as part of this component (rejected - byte storage, pull auth, and replication are a solved, product-agnostic problem, same posture as deferring the secrets-broker product in D7; only the metadata/index layer is genuinely specific to this platform). A separately-authored MCP spec alongside OpenAPI (rejected - see D9c/design line ~524; a second stored contract can drift from the OpenAPI source of truth, which is exactly the risk D9c's "three projections" framing was written to avoid). Per-function hardware requirements (rejected for now as unnecessarily fine-grained relative to actual need; revisit if a service's functions turn out to have materially different resource profiles in practice). Tag-based (rather than digest-based) step resolution (rejected - would let a redeploy silently change a workflow's effective trust tier underneath an already-authored spec, undermining D5a's per-build trust model).

**Resolved by D9/D13**: the compose/nest terminology split flagged here as pending is now resolved - D9 has been reworked to use "compose" only for workflows (stored and reused-by-fork in the workflow-spec store, D13) and "nest" only for a service function invoking other services, matching this decision's `nesting_declaration` field name. The `service-composability` capability spec has likewise been renamed to `service-nesting` and aligned with this vocabulary.

### D13: The workflow-spec store is a first-party component; reuse is by fork, not by live reference

D9a originally treated a workflow-spec, published under an invocable identity, as a kind of registry entry (a "composite"). Splitting compose from nest (D9's terminology rework, above) means a workflow-spec is never a registry entry - it needs its own first-party home. This decision specifies that home: the **workflow-spec store** (see `specs/workflow-spec-store/spec.md`), and the model by which one workflow reuses another.

> **Supersession note.** An earlier form of this decision (and its Q1-era framing) had reuse work by *live reference + runtime flattening*: a parent held a version-pinned reference to a child workflow-spec, and the child's IR was macro-expanded into the parent at execution time. That model is **superseded** by the fork model below. The motivation is D7's secret-scoping boundary (see "Reuse is by fork" below): live-referencing a workflow with writer-scoped secrets would either carry the author's secret authority across a writer-identity boundary (a D7 violation) or require per-consumer signature holes; forking avoids both. Consequences of the supersession: there is no runtime flattening of an external reference, no transitive *resolution* pin, and no provenance-on-flattened-steps mechanism. The `map`/`forEach` child-execution primitive (D8/D9) is unaffected - it was never about workflow-to-workflow reuse.

**Scope and shape, deliberately asymmetric with the registry (D12).** The store is not a parallel registry for a different artifact type; it differs from D12 in exactly the ways the underlying things differ:

```
                          REGISTRY (D12)              WORKFLOW-SPEC STORE (D13)
   contents               service-image metadata      workflow-specs (IR + doc)
   identity                image digest                URN: workflow / ns/name @ ver
   contract exposed        OpenAPI (CLI/MCP projected)  derived signature (D8)
   who writes               platform developers only    workflow-writers (broad)
   trust model               trust tiers (D5a)            NONE - see below
   reuse mechanism           invoked as a step            FORK (copy + lineage pin)
```

**Identity reuses the dataset URN scheme (D8a), one new `resourceType`.** A workflow-spec is identified by `urn:workflow-platform:workflow:<namespace>/<name>[:<tag> | @<version-digest>]`, exactly the pattern D8a established for datasets and explicitly designed to extend to "other globally-shared, versioned resource kinds." A published version is **immutable** (content-addressed under a resolvable tag), the same tag→digest discipline used for images (D12) and datasets (D8a). There is therefore no "overwrite" operation - only publishing a new version. Immutability is not optional here: the fork lineage pin below depends on a source version resolving to identical content forever.

**No trust model.** A workflow is built entirely from already-registered, already-trust-tiered service steps (every leaf step's placement facts come from the registry per D12). There is nothing new to conformance-probe at the workflow level, so this decision deliberately does not introduce a workflow-level analog of D5a.

**Reuse is by fork, not by live reference.** When workflow-writer A wants to reuse workflow B, A **forks** B: B's shape and steps are copied into A's namespace at authoring time, producing a self-contained workflow-spec that A then edits. The fork retains an **immutable lineage pin** to the exact source version (`forkedFrom: urn:...:workflow:ns/B@<version>`), and that lineage is transitive (B's own fork lineage, if any, is itself pinned). The lineage pin exists for provenance/audit and for *upstream-awareness* ("B has a newer version") - it is **not** a live resolution dependency and never auto-propagates B's later edits; picking up upstream changes is a deliberate re-fork, not automatic. Because the fork is self-contained, execution needs no runtime resolution or flattening of any external workflow-spec - the parent's IR already contains everything it runs.

**Why fork rather than live reference: D7's secret boundary makes it the correct model, not merely the simple one.** D7 scopes writer-owned secrets to "the workflow-spec / writer identity." Reusing B therefore cannot silently carry B's writer-scoped secret *authority* into A's execution - that would resolve B's author's secrets under A's identity, breaking D7's isolation boundary. Forking makes this structural: the copy lands in A's namespace under A's writer identity, and any writer-scoped secret reference inherited from B **does not carry** - A must re-bind it with A's own secret reference (or the fork is invalid). This is a **hard platform invariant**, enforced by the platform independently of any tooling: the platform SHALL NOT resolve a writer-scoped secret under a writer identity other than the one that owns the workflow-spec declaring it. See "layering" below for what is *not* the platform's job.

**Layering: the platform enforces invariants; the external authoring tool owns policy and UX.** This mirrors how D8/D10/D11 already delegate authoring-surface concerns to the (funded, external) authoring tool.

```
PLATFORM (workflow-spec store) enforces INVARIANTS:
  - immutable, URN-identified, versioned storage
  - deterministic fork lineage (immutable source-version pin)
  - HARD: writer-scoped secrets never resolve across writer identity;
    inherited writer-secret references do not carry through a fork and
    must be re-bound (a security/correctness boundary, D7)

AUTHORING TOOL (external) owns POLICY + UX:
  - visibility / tenancy: who may see, fork, or publish into a namespace
  - the "this shape is reusable; adapt its secrets (and possibly its
    static-data references), maybe into a new namespace" fork flow
  - static-DATA visibility preferences (a softer concern than secrets)
```

**Secrets are a hard boundary; static-data visibility is a softer, tool-owned concern.** Only writer-scoped secrets are an author-identity-bound *authority* the platform must refuse to carry (leaking one is a security breach). Static datasets are content-addressed, immutable, and globally shared across an unbounded author set *by design* (D8a); a reference to one is safe for the platform to carry through a fork. Whether an author nonetheless wants to restrict who may use their dataset is a **visibility preference**, and enforcing it would require per-namespace dataset ACLs - exactly the tenancy machinery this decision keeps out of the platform. So static-data-visibility (and any prompt to re-point a dataset reference on fork) is the authoring tool's concern, not a platform invariant. User-scoped secrets and request/session/user data bindings are resolved at run time by the eventual caller and are unaffected by forking either way.

**Deferred, explicitly, as known limitations rather than solved here:**

```
VISIBILITY / TENANCY / PUBLISH-AUTHORITY: who may see, fork, or publish
into which namespace is delegated to the external authoring tool, which
owns the tenancy model. The platform stores and identifies workflow-
specs and enforces the secret boundary; it does not adjudicate who is
allowed to do what socially.

LINEAGE CYCLES: a fork lineage that loops (A forkedFrom B, B forkedFrom
A across versions) is not meaningful, but this decision does not specify
detection/rejection of it. Lower-stakes than the earlier reference-
flatten cycle risk (a fork is a self-contained copy, so a lineage cycle
cannot cause infinite expansion at execution) - noted as a known
limitation, tracked as follow-up, not a designed mechanism here.

IR-VERSION MISMATCH ON FORK: a source workflow-spec and the forking
author may be on different IR versions (D11). This decision does not
specify migrate-then-fork ordering - it is left to the external
authoring tool to surface the mismatch for the author to resolve,
rather than the platform silently migrating or rejecting.
```

**Rationale**: The fork model follows from taking D7's secret-scoping boundary seriously for workflow reuse: a live reference cannot carry a workflow's author-bound authority without either violating that boundary or complicating every consumer's signature, whereas a fork lands the reuse under the forker's own identity where re-binding is natural. It costs DRY / auto-update, which is an accepted trade: immutable lineage pins still provide upstream-awareness, and the runtime is dramatically simpler (self-contained specs, no external resolution or flattening, `map` child-execution as the only remaining dynamic mechanism).

**Alternatives considered**: Reusing the registry for workflow-specs, distinguished by a `kind: composite` field (rejected - this was D9a's original framing; the compose/nest split shows it conflates two artifact types with two different trust and authorship models under one storage model). Live reference + runtime flattening (rejected on reflection and superseded - see the supersession note; it cannot honor D7's writer-secret boundary without per-consumer signature holes, and forking is both safer and simpler at runtime). Rebind-in-place on a live reference, keeping B authoritative and turning B's writer-secret references into referencer-supplied holes (rejected - preserves DRY but makes a referenced workflow's secret references a per-consumer extension of its derived signature, and keeps the live-resolution machinery the fork model eliminates). Enforcing static-data visibility as a platform invariant (rejected - would pull per-namespace dataset ACLs and tenancy into the platform, which this decision deliberately delegates to the authoring tool; datasets are globally shared by D8a design, so carrying a dataset reference through a fork is safe). Tag-based (rather than immutable-version) fork lineage (rejected for the same reason D12 rejected tag-based digest resolution - a lineage pin must resolve to identical content to be meaningful).

## Risks / Trade-offs

- **[Execution engine decision left open]** D6 is deliberately unresolved rather than committed, following the R11 addressability gap and the composability/agent-directed-composition stress tests. -> Mitigation: every other decision, IR construct, and capability spec in this change is written engine-agnostically by design, so this can be resolved later (ideally via a short spike, per D6's recommended next step) without invalidating what's already captured.
- **[Operational weight varies significantly by candidate]** The engine families under consideration in D6 range from light (already-K8s-native, or a lightweight runtime) to heavy (a self-hosted cluster, or operating a second distributed system alongside K8s in a hybrid). -> Mitigation: operational weight is tracked explicitly as a comparison dimension in D6 rather than an afterthought; factor it into whichever spike is used to resolve the decision.
- **[Determinism constraints, where applicable, could leak into the authoring surface]** Several candidate engines require deterministic workflow-level code. -> Mitigation: this constraint, where it applies, is absorbed once in the generic DSL-to-engine interpreter, not per workflow-spec; D8 isolates it to the IR rather than the authoring surface, and this holds regardless of which engine D6 ultimately selects.
- **[A secondary spawn-execution backend may add operational surface]** Delegating World-1 spawn-style steps to a separate backend (e.g. Kubernetes Jobs) alongside the primary engine, if pursued, introduces two systems instead of one. -> Mitigation: keep any such delegation path narrow (a single well-defined "run this as a spawned job" step type) rather than a full second orchestration surface; whether this is needed at all depends on which engine D6 ultimately selects.
- **[COW availability varies by service]** Copy-on-write/incremental snapshotting is confirmed for the SQL-dump case but is a per-service capability that may not be available for every heavy-setup service, making the "tens of GB" cell of the D1 matrix expensive for some services. -> Mitigation: D5's capability declaration makes this visible per-service; the scheduler (D4) can refuse to promote non-COW services to shared/pooled placement and fall back to per-request cost acceptance.
- **[Pooling reintroduces isolation risk]** Reusing warm containers across invocations (for performance) is exactly the mechanism that could leak state across sessions if a service is misclassified or its capability declaration is wrong. -> Mitigation: content-addressing (D2) makes correctness structural rather than relying on service-author discipline, but the capability declarations themselves (D5) are a trust boundary that should be validated (e.g. registry-side checks, conformance tests) - not yet designed.
- **[Secret residue in trusted code]** Push-by-value (D7 rule 3) places a secret in a trusted container's memory for the duration of a call; a bug could log or persist it. -> Mitigation: log-payload redaction, best-effort in-memory clear post-call, and payload-at-rest encryption if the eventually-selected engine offers a serialization/codec hook (D7 rule 4). Residual risk is accepted because services are trusted and non-caching; it would be unacceptable for untrusted images.
- **[Threat model depends on trust assumption]** D7's simplifications (push-by-value, pooling across sessions) hold only while services are trusted platform code. -> Mitigation: recorded as an explicit non-goal; introducing untrusted images would require revisiting D7 (capability tokens, sandboxing, per-tenant isolation).
- **[Composition bypass requires ongoing registry-side vigilance]** D9b's mandatory-by-default policy closes the silent-escape-hatch risk at the policy level, but its guarantee depends on declared exceptions actually being reviewed and on the trust-tier/runtime-invariant machinery (D5a) actually catching undeclared bypasses in practice. -> Mitigation: treat an undeclared bypass exactly as any other false capability declaration (D5a's demotion + alert path), rather than as a separate enforcement problem; the mechanism cost of full SDK compliance still varies by engine (D6).
- **[UI-editability constrains the IR more than a runtime-only design would]** Because a funded UI tool must later open and edit arbitrary existing specs, constructs that would otherwise be tempting shortcuts (embedded imperative code, an unbounded expression language) are foreclosed now, even though the UI itself is not being built yet. -> Mitigation: treated as a feature, not just a constraint - D10's bounded logic-expression approach satisfies both the immediate need and the future UI requirement simultaneously; revisit only if a real need emerges that a bounded logic expression genuinely cannot express (route those to a registered service instead, per D10).
- **[Agent-directed composition is unbounded by nature]** Unlike branch/map, an agent-directed step's call sequence cannot be statically pre-analyzed. -> Mitigation: D9's allowlist and governor requirements bound the blast radius (which services/secrets are reachable, and how much the loop can cost/run) even though the sequence itself remains dynamic; services reachable this way should validate inputs defensively rather than trust caller context.

## Migration Plan

Not applicable in the traditional sense - this is a net-new platform with no prior system to migrate from. Sequencing of build-out is captured in tasks.md.

## Open Questions

- **Execution engine selection (D6)**: Left deliberately open. Five candidate paths: (a) Temporal + a hand-built placement-resolver, (b) Temporal + Ray hybrid, (c) Restate as a single system, (d) Dapr (Workflows + Actors) as a single system, (e) a DBOS-shaped thin library over Postgres. Recommended next step is a short spike on the SQL-session scenario against Restate and Dapr specifically, in placement-bookkeeping-only mode (no service rewrites), run alongside the D9 policy decision rather than after it.
- **Placement-bookkeeping vs. actor-hosting trade-off**: If Dapr (or a similar actor framework) is pursued, whether to use it only for durable placement bookkeeping (no service changes) or to additionally rewrite a narrow subset of genuinely setup-heavy services to embed the Actor SDK for true process affinity is a distinct, follow-on decision - not required to resolve D6 itself.
- **Secrets broker product**: The secrets injection model is decided (D7), but the specific broker/store (e.g. Vault, a cloud secret manager, or an encrypted-at-rest store decrypted worker-side) is intentionally left open. The spec is written broker-agnostic.
- **Dataset object storage product**: D8b decides the dataset catalog's byte store is dedicated object storage (not the artifact registry used for D12's `oci_ref`), mirroring D12's index/byte-store split; the specific product (S3, GCS, MinIO, etc.) is intentionally left open, same posture as the secrets-broker product.
- **Nesting mechanism cost**: D9b decides the policy (mandatory-by-default, declared exceptions); the concrete SDK/mechanism cost of compliance remains coupled to the D6 engine decision.
- **Outward-facing MCP exposure**: Exposing this platform's registry to arbitrary third-party agent hosts (distinct from D9c's internal agent-runner-as-a-step case) is a separate, real idea not designed here.
- **Placement-resolver/routing mechanism**: D4 decides that placement is fused from three sources and that affinity is optional, but not the concrete mechanism that routes an actual call to a specific service replica. Whether this is a bespoke resolver, a service-mesh consistent-hash policy, or a native engine primitive (D6 R11) depends materially on the D6 outcome.
- **OCI-compliant registry product/topology for image bytes (D12)**: the service registry's metadata index is designed; the underlying byte-store product/deployment (e.g. Harbor, a cloud registry) is deferred, same posture as the secrets-broker product.
- **Registry re-pin/upgrade flow (D12)**: moving an already-authored binding from a pinned digest to a newer build's digest is a real, deliberate authoring action - not yet designed.
- **Workflow-spec store visibility/tenancy/publish-authority (D13)**: who may see, fork, or publish into a namespace is explicitly delegated to the external authoring tool, not solved on the platform.
- **Fork-lineage-cycle handling (D13)**: a fork-lineage chain that loops is not currently detected or rejected; low-stakes (a fork is self-contained, so this cannot cause run-time expansion) but tracked as follow-up.
- **IR-version-mismatch-on-fork (D13)**: surfacing a mismatch between a source workflow-spec's IR version and a forking author's own is delegated to the external authoring tool.

**Resolved this round** (previously listed here as open; concrete decisions now captured in the Decisions section above): JSON-Logic vs. CEL (D10); agent-directed/MCP nesting, unified as a specific case of the nesting model rather than a separate design (D9c); authoring surface syntax - YAML/JSON restricted profile, `sessionState` declarations, `{from: item}`, `dependsOn`, flat request signatures, and the URN scheme for static dataset references (D8a); IR schema versioning/migration (D11); snapshot auto-promotion thresholds (D4a); capability declaration trust/validation (D5a); session snapshot retention for undo/time-travel (D3a). The exact numeric defaults in D4a and the specific conformance-test implementation in D5a remain tunable/to-be-implemented, but the model itself is no longer open.

**Resolved this round** (previously listed here as open; concrete decisions now captured in the Decisions section above): the authoring-surface syntax gaps left after D8a - step invocation (always a full image digest, never a mutable tag - D8c's asymmetry note vs. dataset tags), secret references as a block separate from data bindings, the `literal` binding kind, and both `branch`'s and `map`'s per-internal-sub-graph result-exposure mechanism (`yields`, generalizing the same flat-signature rule already governing top-level `outputs`) are now concretely spelled (D8c). The remaining authoring-surface work (tasks.md 1.7/5.x) is producing the formal JSON Schema from these decisions, not deciding further open syntax questions.

**Resolved more recently** (superseding an earlier "resolved this round" entry from when D9a/D9b were first drafted): the service/workflow composability model has since been split into **compose** (workflow-spec reuse, exclusively by fork, D13 - superseding the originally-resolved "composite registry entries" framing) and **nest** (a service function calling other registered services, mandatory-by-default orchestrator-aware policy, D9b - unchanged in substance, renamed from "composition"). The service registry itself (D12) and the workflow-spec store (D13) are new first-party components specified this round, resolving what was previously an unspecified external dependency.
