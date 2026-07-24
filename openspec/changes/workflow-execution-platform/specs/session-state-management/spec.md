## ADDED Requirements

### Requirement: Session input history as durable source of truth
The system SHALL persist, for each session, the ordered sequence of user-driven mutation inputs as the durable source of truth for that session, independent of any materialized/warm snapshot of that session's data.

#### Scenario: Session history survives snapshot loss
- **WHEN** all materialized snapshots for a session have been garbage-collected
- **THEN** the session's current state SHALL remain fully reconstructable by replaying its persisted input history

### Requirement: Content-addressed snapshot caching
The system SHALL represent materialized/warm state (e.g. a loaded dataset) as a snapshot keyed by a content hash derived from its base input and the operations applied to it, such that identical (base, operations) pairs always resolve to the same snapshot key.

#### Scenario: Identical static base shared across sessions
- **WHEN** two independent sessions both request materialization of the same unmodified static dataset
- **THEN** the system SHALL resolve both requests to the same content-addressed snapshot and share it read-only

#### Scenario: Divergent session produces isolated snapshot
- **WHEN** a session mutates a dataset it holds
- **THEN** the system SHALL produce a new snapshot under a distinct content hash, isolated from the original and from any other session's snapshot

### Requirement: Linear per-session snapshot chains
The system SHALL model each session's mutation history as a strictly linear chain of snapshots. The system is not required to support merging or branching of a single session's chain.

#### Scenario: Sequential mutation within a session
- **WHEN** a session applies a second mutation after a first
- **THEN** the resulting snapshot SHALL have the first mutation's snapshot as its direct predecessor in the chain

### Requirement: Copy-on-write for services that support incremental snapshots
Where a service declares capability support for copy-on-write / incremental snapshotting, the system SHALL materialize a session's derived state as a delta against its shared base rather than a full copy.

#### Scenario: Large static base with COW-capable service
- **WHEN** a session mutates data derived from a large, COW-capable static base
- **THEN** the system SHALL store only the delta produced by the mutation, and SHALL NOT duplicate the full base per session

#### Scenario: Service without COW support
- **WHEN** a session mutates data derived from a base whose service does not declare COW capability
- **THEN** the system SHALL fall back to a full-copy materialization for that session's snapshot

### Requirement: Time-to-live based snapshot garbage collection
The system SHALL apply a time-to-live to materialized snapshots and SHALL be permitted to garbage-collect any snapshot after its TTL elapses, relying on the session input history for reconstruction if the snapshot is needed again.

#### Scenario: Snapshot collected after TTL
- **WHEN** a snapshot's TTL has elapsed and it has not been accessed
- **THEN** the system SHALL be permitted to delete the snapshot without any loss of session correctness

#### Scenario: Snapshot rebuilt after collection
- **WHEN** a subsequent request needs a snapshot that was previously garbage-collected
- **THEN** the system SHALL be able to rebuild it by replaying the relevant portion of the session's input history

### Requirement: Cross-session operation memoization
The system SHALL support caching the mapping from (base snapshot hash, operation) to resulting output hash, such that a different session applying an identical operation to an identical base can reuse the cached result instead of recomputing it.

#### Scenario: Two sessions apply the same operation to the same base
- **WHEN** session A and session B independently apply the identical operation to the identical base snapshot
- **THEN** the system SHALL resolve both to the same output snapshot via the memoization cache without re-executing the operation twice

### Requirement: Change-detection reported by the service
The system SHALL rely on the invoked service to report whether a given call actually mutated state, and SHALL NOT advance a session's snapshot chain for calls reported as non-mutating.

#### Scenario: Read-only query against session data
- **WHEN** a session issues a query against its materialized state and the service reports no mutation occurred
- **THEN** the system SHALL NOT create a new snapshot or advance the session's chain

### Requirement: Session rewind with truncation-on-new-mutation
The system SHALL allow a session's current pointer to be rewound to an earlier point in its own snapshot chain, and SHALL, upon the next new mutation following a rewind, discard the truncated-off forward tail rather than preserving it as a branch.

#### Scenario: Rewind to an earlier snapshot
- **WHEN** a session is rewound to an earlier point in its chain
- **THEN** the session's current state SHALL reflect that earlier point, reconstructed via replay if the corresponding snapshot was previously garbage-collected

#### Scenario: New mutation after a rewind discards the abandoned tail
- **WHEN** a session applies a new mutation after having been rewound
- **THEN** the system SHALL discard the previously-truncated forward tail and SHALL NOT retain it as a separate branch, keeping the session's chain linear

### Requirement: Configurable checkpoint interval for snapshot retention
The system SHALL support a configurable checkpoint interval controlling how many intermediate snapshots in a session's chain remain materialized versus are left to be rebuilt via replay on demand, independent of correctness.

#### Scenario: Default retention for the life of a session
- **WHEN** no explicit checkpoint interval is configured
- **THEN** the system SHALL retain the full snapshot chain for the life of the session and SHALL garbage-collect it only when the session itself expires

#### Scenario: Reduced checkpoint interval under storage pressure
- **WHEN** a reduced checkpoint interval is configured to save storage
- **THEN** the system SHALL still be able to reconstruct any evicted intermediate point via replay of the session's input history, at the cost of additional rebuild latency
