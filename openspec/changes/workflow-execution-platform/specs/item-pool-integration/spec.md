## ADDED Requirements

### Requirement: Item type and item instance are distinct identities
The system SHALL distinguish an item type (the authored shape of an assessment item's resources, known to the workflow-writer at authoring time) from an item instance (one of potentially many variance/difficulty realizations of that type, chosen by the external learning environment/Item Pool per learner, never by the workflow-writer). A workflow-spec SHALL reference item resources only through the item-type-level shape (named/pathed slots); it SHALL NOT embed or pin a specific item instance identifier at authoring time.

#### Scenario: A workflow-spec is authored against an item type's shape
- **WHEN** a workflow-writer authors a workflow-spec that reads item resources
- **THEN** the workflow-spec SHALL express those reads via `itemResource` bindings (see `workflow-dsl`) addressing the item type's resource shape, with no specific item instance identifier embedded in the workflow-spec itself

#### Scenario: The same workflow-spec runs against different item instances across separate runs
- **WHEN** an external learning environment invokes the same workflow-spec for two different learners assigned different instances of the same item type
- **THEN** the system SHALL resolve each run's item resources against that run's own supplied instance identifier, independently, with no cross-run interference

### Requirement: A single item instance is resolved per workflow run
Within one workflow-spec execution, every `itemResource` binding SHALL resolve against exactly one item-instance identifier, supplied as request-scoped data for that run. The system SHALL NOT provide a mechanism for a single run to resolve `itemResource` bindings against more than one item instance.

#### Scenario: One run, one instance
- **WHEN** a workflow-spec execution begins with an item-instance identifier
- **THEN** every `itemResource` binding evaluated during that run SHALL resolve against that same identifier

### Requirement: An item instance's resource manifest is resolved eagerly, in whole, on first reference
On first reference to a given item-instance identifier anywhere on the platform, the system SHALL fetch that instance's complete resource manifest from the Item Pool in one resolution pass, rather than resolving individual `itemResource` paths lazily one at a time.

#### Scenario: First reference triggers a full manifest fetch
- **WHEN** an item-instance identifier is referenced for the first time anywhere on the platform
- **THEN** the system SHALL fetch and flatten that instance's entire resource manifest from the Item Pool in a single resolution pass, not per individually-referenced path

#### Scenario: Item Pool resolution is an ordinary, retryable step in the request path
- **WHEN** the Item Pool is transiently unavailable during a manifest fetch
- **THEN** the system SHALL rely on the platform's existing native step retry/backoff behavior to recover, and SHALL NOT require a bespoke, Item-Pool-specific retry mechanism

### Requirement: Flattening classifies each resolved leaf as dataset-shaped or plain-value, trusting the Item Pool's own classification
While flattening a resolved item manifest, the system SHALL classify each named/pathed leaf as either dataset-shaped (heavy; mirrored into the existing dataset resource catalog and addressed by a minted URN) or plain-value (light; passed through inline with no catalog entry), based on the Item Pool's own self-description of that leaf. The system SHALL NOT apply a tiered/earned-trust model (of the kind used for registered service images) to this classification; the Item Pool is treated as trusted upstream infrastructure.

#### Scenario: A dataset-shaped leaf is mirrored into the dataset resource catalog
- **WHEN** a flattened leaf is classified as dataset-shaped
- **THEN** the system SHALL fetch its bytes, mirror them into the existing dataset resource catalog's byte store, and mint a URN for it, making it indistinguishable thereafter from an authoring-time-declared static dataset reference

#### Scenario: A plain-value leaf is passed through without a catalog entry
- **WHEN** a flattened leaf is classified as plain-value
- **THEN** the system SHALL retain it as an ordinary in-memory value, with no dataset-catalog entry created for it

#### Scenario: The Item Pool's classification is trusted outright
- **WHEN** the Item Pool's manifest marks a given leaf's kind (dataset-shaped or plain-value)
- **THEN** the system SHALL rely on that classification directly, without requiring the Item Pool to earn a trust tier the way a registered service image does under the capability-declaration trust model

### Requirement: Resolved item-instance resources are cached, memoized per instance, and rebuildable from the Item Pool
The system SHALL cache a resolved item instance's flattened resource map (path -> dataset reference or value), keyed by item-instance identifier, so that any reference to the same instance after the first is served from the cache rather than re-fetched from the Item Pool. This cache SHALL be safe to expire/evict at any time, since it is always rebuildable by re-resolving the same instance identifier against the Item Pool, which remains the durable source of truth.

#### Scenario: A second reference to the same instance is served from cache
- **WHEN** an item instance's resource manifest has already been resolved and cached
- **THEN** a subsequent reference to that same item-instance identifier, by any learner or workflow run, SHALL be served from the cache without a further Item Pool call

#### Scenario: An evicted cache entry is transparently rebuilt
- **WHEN** a cached item-instance resolution has been evicted or expired
- **THEN** the system SHALL transparently re-resolve it from the Item Pool on next reference, producing the same result as the original resolution

### Requirement: A resolved item instance's resource bindings remain stable for the life of one learner attempt
Once an item instance's resources have been resolved for a given learner's attempt/session, the resolved bindings SHALL remain stable (unchanged) for the duration of that attempt, even if the underlying cache entry is independently refreshed for other callers.

#### Scenario: Resource bindings do not shift mid-attempt
- **WHEN** a learner is partway through an attempt against a resolved item instance
- **THEN** every `itemResource` binding referencing that instance SHALL continue to resolve to the same dataset reference/value for the remainder of that attempt

### Requirement: Item confidentiality and item-type/instance shape consistency are delegated entirely to the Item Pool and external authoring tooling
The system SHALL NOT implement per-item visibility/access-control, or per-namespace item tenancy, as a platform invariant; the Item Pool is solely responsible for ensuring it only ever hands the platform a manifest it is authorized to resolve. The system SHALL NOT validate, at workflow-spec authoring or execution-plan-compile time, that a workflow-spec's `itemResource` paths match a given item type's actual resource shape; this consistency is the responsibility of external authoring tooling and/or the Item Pool's own item-authoring flow.

#### Scenario: The platform enforces no item-level access control
- **WHEN** an item instance's manifest is resolved and mirrored into the platform's dataset resource catalog
- **THEN** the resulting dataset entry SHALL be treated as an ordinary globally-shared, platform-internal static dataset, with no additional per-item visibility restriction enforced by the platform itself

#### Scenario: A shape mismatch surfaces only at resolution time
- **WHEN** a workflow-spec's `itemResource` path does not exist in a particular item instance's actual resolved manifest
- **THEN** the system SHALL surface this as a run-time resolution failure for that binding, and SHALL NOT have rejected the workflow-spec earlier for referencing an inconsistent path
