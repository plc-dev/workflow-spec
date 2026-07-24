## ADDED Requirements

### Requirement: Per-service autoscaling on demand
The system SHALL scale the number of running instances of a given service up and down based on current demand for that service, without requiring manual capacity planning per service.

#### Scenario: Demand spike triggers scale-out
- **WHEN** the request/invocation rate for a given service exceeds its current instance capacity
- **THEN** the system SHALL provision additional instances of that service to absorb the load

#### Scenario: Demand drop triggers scale-in
- **WHEN** demand for a given service drops and sustains below its current instance capacity for a configured period
- **THEN** the system SHALL reduce the number of running instances for that service

### Requirement: Container pre-warming and pooling
The system SHALL support keeping a pool of pre-warmed instances of a service available for reuse across multiple invocations, in order to reduce cold-start latency for setup-heavy or high-frequency services.

#### Scenario: Pooled instance reused across invocations
- **WHEN** a pre-warmed instance of a service is idle and a new invocation for that service arrives
- **THEN** the system MAY route the invocation to the pre-warmed instance instead of provisioning a new one

### Requirement: Pooling must not violate data isolation
Reuse of a pooled or pre-warmed instance across invocations SHALL NOT result in one invocation observing or being influenced by another invocation's user- or session-scoped data.

#### Scenario: Pooled instance reused across different sessions
- **WHEN** a pooled instance previously served session A and is subsequently routed an invocation for session B
- **THEN** the system SHALL ensure session B's invocation cannot observe any data or state left over from session A, either by verifying the instance is provably stateless between calls or by scoping the instance's warm state to a specific content-addressed hash before reuse

#### Scenario: Warm state scoped to a content hash cannot be reused for a mismatched request
- **WHEN** a request requires warm state at a content hash different from what a pooled instance currently holds
- **THEN** the system SHALL NOT serve that request from the mismatched instance without first reloading/rehydrating the correct state

### Requirement: Autoscaling and pooling coexist with placement decisions
Autoscaling and pooling mechanisms SHALL respect the placement/residency decisions made by the execution-scheduling layer (e.g. shared read-only static state, pinned session state) rather than scaling or evicting instances in a way that silently breaks an active placement guarantee.

#### Scenario: Scale-in avoids evicting a pinned, actively-used session instance
- **WHEN** the autoscaler considers scaling in instances of a service
- **THEN** it SHALL avoid terminating an instance currently pinned to an actively-used session's warm state where doing so would force an avoidable rehydration for in-flight work
