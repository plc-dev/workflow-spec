## ADDED Requirements

### Requirement: Placement fused from capability, intent, and observation
The scheduler SHALL determine execution/placement strategy for a step by combining three inputs: service-declared capabilities (from the registry/OpenAPI), workflow-writer declared intent (from the DSL binding), and runtime-observed characteristics (snapshot size, access frequency/recency). No single source alone SHALL be sufficient to determine placement.

#### Scenario: Placement decision combines all three sources
- **WHEN** the scheduler places a step bound to session-scoped, mutable data on a COW-capable service
- **THEN** the scheduler SHALL consider the service's declared COW capability, the binding's declared interactivity, and the currently observed snapshot size before selecting a placement strategy

### Requirement: Service capability declarations
The registry SHALL allow each service function to declare: whether it mutates state, its materialization cost class, whether it supports copy-on-write/incremental snapshotting, and whether it reports change-detection on calls.

#### Scenario: Service declares heavy materialization cost
- **WHEN** a service function is registered with a declared heavy materialization cost class
- **THEN** the scheduler SHALL treat that function's setup step as a candidate for warm reuse rather than per-call spawn

### Requirement: Affinity is an optimization, never a correctness requirement
The scheduler MAY route a step to a specific worker holding relevant warm state for performance, but the system SHALL remain correct if that routing is unavailable and the step is instead executed on any worker that rehydrates the required state from the content-addressed store.

#### Scenario: Preferred warm worker unavailable
- **WHEN** the worker holding a session's warm snapshot is unavailable (e.g. scaled down or restarted)
- **THEN** the scheduler SHALL route the step to another available worker, which SHALL rehydrate the required snapshot from the content-addressed store, and the step SHALL complete correctly

#### Scenario: Preferred warm worker available
- **WHEN** a worker already holds the relevant warm snapshot for a step
- **THEN** the scheduler SHOULD prefer routing the step to that worker to avoid rehydration cost

### Requirement: A literal-bound nesting allowlist feeds the admission model as candidates, never as unconditional pre-warming
Where an open-target nesting step's allowlist is supplied as a `literal` binding (per `workflow-dsl`), the scheduler MAY treat the functions named in that allowlist as candidates for the same promotion/admission model governing other bindings. The scheduler SHALL NOT be required to unconditionally pre-warm or pool every allowlisted function regardless of likely use.

#### Scenario: Allowlisted functions are admission-model candidates, not automatically pre-warmed
- **WHEN** an open-target nesting step's literal-bound allowlist names several functions
- **THEN** the scheduler MAY consider each named function a promotion candidate under the existing admission model, and SHALL NOT be required to pre-warm all of them unconditionally

#### Scenario: Unused capacity is not consumed by an unused allowlist entry
- **WHEN** an allowlisted function is never actually invoked during a given execution
- **THEN** the scheduler SHALL NOT be required to have reserved warm/pooled capacity for it on that basis alone

### Requirement: Adaptive residency promotion
The scheduler SHALL be permitted to start a binding's state in a rehydrate-anywhere (unpinned) residency mode and promote it to a pinned/warm residency mode based on observed size and access frequency, without requiring the workflow-writer to declare this threshold in the DSL.

#### Scenario: Large, frequently accessed session state gets promoted
- **WHEN** a session's materialized state is observed to be large and is accessed repeatedly within a short window
- **THEN** the scheduler MAY promote that session's state to a pinned residency mode to avoid repeated rehydration cost

### Requirement: Promotion is gated by declared interactivity and configurable thresholds
The scheduler SHALL NOT promote a binding to pinned residency unless its declared interactivity is interactive, and SHALL apply configurable, tunable thresholds (rather than fixed constants) for access-frequency and rehydration-cost admission, with a higher (hysteresis) threshold for demotion than for promotion.

#### Scenario: Batch-scoped binding is never auto-promoted
- **WHEN** a binding declared with batch interactivity is observed to be large and frequently accessed
- **THEN** the scheduler SHALL NOT promote it to pinned residency on that basis alone

#### Scenario: Demotion threshold is higher than promotion threshold
- **WHEN** a pinned binding's access frequency drops
- **THEN** the scheduler SHALL require a longer idle period before demoting it than the access frequency that originally qualified it for promotion, to avoid repeated promote/demote flapping

#### Scenario: Capacity-aware eviction among pinned entries
- **WHEN** the total pinned-residency budget is exceeded
- **THEN** the scheduler SHALL evict the least-recently-used pinned entry to stay within budget, even if that entry would otherwise still qualify for pinned residency

### Requirement: Capability declarations carry a trust tier keyed to a service build
The registry SHALL associate each service capability declaration with a trust tier (unverified, conformance-passed, or production-proven) keyed to a specific service image digest, and the scheduler SHALL only rely on a declared capability (for sharing, pooling, or COW reuse) once that build has reached production-proven; below that tier, the scheduler SHALL apply the conservative (fully isolated, non-shared, non-pooled) placement regardless of what is declared.

#### Scenario: Unverified declaration is not trusted
- **WHEN** a service declares COW support but its current image digest has not passed conformance checks
- **THEN** the scheduler SHALL treat that binding as isolated/non-shareable regardless of the declaration

#### Scenario: New build resets trust
- **WHEN** a service is redeployed with a new image digest
- **THEN** the new build's trust tier SHALL start over rather than inheriting the trust tier earned by the previous build

#### Scenario: Runtime invariant violation demotes trust
- **WHEN** a runtime invariant check detects that a claimed-immutable or claimed-shared binding produced divergent results across different callers
- **THEN** the system SHALL demote that service build's trust tier and SHALL raise an alert

### Requirement: Shared read-only placement for static, immutable bindings
Where a binding is declared static and immutable, the scheduler SHALL materialize it at most once per content hash and SHALL make it available read-only to any workflow instance referencing the same content hash.

#### Scenario: Multiple workflows reference the same static dataset
- **WHEN** multiple concurrent workflow instances bind to the same static, immutable dataset
- **THEN** the scheduler SHALL reuse a single materialized instance across all of them rather than materializing it once per workflow instance

### Requirement: Pre-analysis of statically declared branches and map bodies
Where a workflow-spec's execution plan contains a branch construct or a map/forEach construct, the scheduler SHALL be able to analyze every statically declared possibility (every branch case, and the map iteration body's shape) ahead of execution, independent of which case is later selected or how many iterations later occur at run time.

#### Scenario: Placement implications known before a branch is taken
- **WHEN** a workflow-spec containing a branch step is submitted for scheduling analysis
- **THEN** the scheduler SHALL be able to determine the service calls, secret references, and placement implications of every declared case before the workflow executes and before the runtime value selecting a case is known

#### Scenario: Placement implications known before iteration count is known
- **WHEN** a workflow-spec containing a map step is submitted for scheduling analysis
- **THEN** the scheduler SHALL be able to determine the placement implications of a single iteration without knowing the eventual number of iterations
