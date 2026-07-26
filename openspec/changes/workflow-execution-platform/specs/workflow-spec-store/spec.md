## ADDED Requirements

### Requirement: Workflow-specs are stored separately from the service registry
The platform SHALL provide a workflow-spec store, distinct from the service registry, for storing workflow-specs. The service registry SHALL NOT contain workflow-specs, and the workflow-spec store SHALL NOT contain service-image metadata.

#### Scenario: A workflow-spec is not a registry entry
- **WHEN** a workflow-spec is published
- **THEN** it SHALL be stored in the workflow-spec store under its own identity and version, and SHALL NOT appear as a registry entry alongside service images

### Requirement: Workflow-specs are identified by a namespaced URN with an immutable version
The workflow-spec store SHALL identify each published workflow-spec by a URN of the form `urn:workflow-platform:workflow:<namespace>/<name>[:<tag>|@<version-digest>]`, mirroring the dataset URN scheme. A published version SHALL be immutable: once published, the content addressed by a given version SHALL NOT change. Publishing a new version SHALL NOT be described as, or implemented as, an overwrite of a prior version.

#### Scenario: A published version never changes
- **WHEN** a workflow-spec version has been published
- **THEN** repeated lookups of that same version SHALL always return identical content, and no operation SHALL mutate an already-published version's content

#### Scenario: A new version does not overwrite a prior one
- **WHEN** a workflow-writer publishes a new version of a workflow-spec under an existing name
- **THEN** the store SHALL retain the prior version, addressable by its own version identifier, unaffected by the new publish

### Requirement: Workflow-specs are keyed by identity and version, exposing a derived signature
The workflow-spec store SHALL keep every published workflow-spec under its URN identity and version, and SHALL expose each version's derived signature (required request parameters, session-requirement, and outputs, per the `workflow-dsl` capability) for discovery.

#### Scenario: Discovering a workflow-spec's signature
- **WHEN** a caller looks up a published workflow-spec by identity and version
- **THEN** the store SHALL return its derived signature, sufficient for callers to invoke it without loading its full internal execution plan

### Requirement: A workflow-spec has no trust tier
The workflow-spec store SHALL NOT apply a capability-declaration trust-tier model (per D5a) to workflow-specs. A workflow-spec's runtime behavior SHALL continue to depend only on the trust tiers of the individual registered service images its steps invoke.

#### Scenario: Placement still depends on per-step registry trust, not workflow trust
- **WHEN** a workflow-spec's steps are dispatched
- **THEN** each step's placement SHALL be governed by that step's own service image's trust tier (per `service-registry`/D5a), and the workflow-spec itself SHALL NOT carry or require a separate trust tier

### Requirement: Reuse of a workflow-spec is by fork, producing a self-contained copy
When a workflow-writer reuses another workflow-spec, the store SHALL support this as a fork operation: the source workflow-spec's shape and steps are copied into a new workflow-spec under the forking writer's own namespace at authoring time. The resulting forked workflow-spec SHALL be self-contained - its execution plan SHALL require no run-time resolution of, or dependency on, the source workflow-spec.

#### Scenario: A fork is self-contained at execution time
- **WHEN** a forked workflow-spec is executed
- **THEN** its steps SHALL execute without the platform resolving or contacting the source workflow-spec it was forked from

#### Scenario: Forking does not modify the source
- **WHEN** a workflow-spec is forked
- **THEN** the source workflow-spec SHALL remain unchanged and independently resolvable at its own identity and version

### Requirement: A fork carries an immutable lineage pin to its exact source version, transitively
Every forked workflow-spec SHALL record an immutable lineage pin identifying the exact source workflow-spec identity and version it was forked from. This lineage pin SHALL be transitive: if the source workflow-spec itself carries a lineage pin from an earlier fork, that pin SHALL remain intact and inspectable through the new fork. The lineage pin SHALL be for provenance/audit and upstream-awareness only; it SHALL NOT be a run-time resolution dependency, and a later version of the source SHALL NOT automatically propagate to the fork.

#### Scenario: Lineage identifies the exact source version
- **WHEN** workflow-spec `A` is forked from workflow-spec `B` at version `v1`
- **THEN** `A`'s lineage pin SHALL identify `B@v1` specifically, not `B` in the abstract or any later version of `B`

#### Scenario: A later source version does not propagate to an existing fork
- **WHEN** `B` is published as `v2` after `A` was forked from `B@v1`
- **THEN** `A` SHALL continue to run exactly as forked, unaffected by `B@v2`, unless a workflow-writer deliberately creates a new fork against `B@v2`

#### Scenario: Lineage is transitively inspectable
- **WHEN** workflow-spec `C` is forked from `A`, and `A` itself carries a lineage pin to `B@v1`
- **THEN** `C`'s lineage SHALL make both `A`'s source version and `A`'s own lineage pin to `B@v1` inspectable

### Requirement: Writer-scoped secret references do not carry across a fork
When a workflow-spec is forked, any writer-scoped secret reference (per the `secrets-management` capability's writer/user scope taxonomy) present in the source's steps SHALL NOT resolve under the forking writer's identity. The platform SHALL treat such an inherited, unresolved writer-scoped secret reference as an unsatisfied binding that the forking writer must replace with their own writer-scoped secret reference before the fork is valid. This SHALL hold regardless of whether any authoring tool also surfaces this to the writer.

#### Scenario: An inherited writer-scoped secret is not resolvable
- **WHEN** a forked workflow-spec still contains a writer-scoped secret reference inherited unchanged from its source
- **THEN** the platform SHALL refuse to resolve that secret reference under the forking writer's identity, and SHALL treat the fork as having an unsatisfied binding

#### Scenario: Re-binding a secret reference makes the fork valid
- **WHEN** a forking writer replaces an inherited writer-scoped secret reference with their own writer-scoped secret reference
- **THEN** the fork's binding SHALL be satisfied and SHALL resolve under the forking writer's own identity at run time

#### Scenario: User-scoped secrets and runtime data bindings carry over unaffected
- **WHEN** a forked workflow-spec contains a user-scoped secret reference or a request/session/user data binding
- **THEN** these SHALL carry over unchanged, since they are resolved at run time by the eventual caller/session and are not bound to the source workflow-spec's writer identity

### Requirement: Static-dataset references carry over on fork; visibility policy is not enforced by the platform
A static-dataset reference (per the dataset URN scheme) present in a source workflow-spec's steps SHALL carry over unchanged when forked, since static datasets are globally shared, content-addressed resources by design. The workflow-spec store SHALL NOT enforce dataset-visibility restrictions or namespace-scoped access control over dataset references; any such policy is the responsibility of the external authoring tool.

#### Scenario: A dataset reference is preserved by default on fork
- **WHEN** a workflow-spec containing a static-dataset reference is forked
- **THEN** the forked workflow-spec's dataset reference SHALL resolve identically to the source's, unless a workflow-writer deliberately changes it

#### Scenario: The platform does not gate dataset access by namespace
- **WHEN** a workflow-writer forks a workflow-spec referencing a static dataset published under a different namespace
- **THEN** the workflow-spec store SHALL NOT reject the fork or the reference on the basis of namespace, that decision being left to the external authoring tool if it chooses to enforce one

### Requirement: Visibility, tenancy, and publish-authority are delegated to the external authoring tool
The workflow-spec store SHALL NOT itself adjudicate who may view, fork, or publish into a given namespace. This capability's scope is limited to storing, identifying, and enforcing the invariants above (immutability, lineage, and the writer-scoped-secret boundary); visibility/tenancy/publish-authority policy is the responsibility of the external authoring tool.

#### Scenario: The store does not enforce a visibility policy
- **WHEN** a fork or publish request is made
- **THEN** the workflow-spec store SHALL NOT itself apply a visibility or tenancy rule to permit or deny it, beyond the invariants this capability specifies elsewhere

### Requirement: Lineage cycles are a known, deferred limitation
The workflow-spec store SHALL NOT be required to detect or reject a fork-lineage cycle (e.g. a chain of forks that lineage-references back to itself) as of this capability's initial scope. Because a fork is a self-contained copy, a lineage cycle SHALL NOT cause any run-time resolution or expansion; it is a bookkeeping/provenance concern only, tracked as follow-up work rather than solved here.

#### Scenario: A lineage cycle does not affect execution
- **WHEN** a fork-lineage chain contains a cycle
- **THEN** execution of any workflow-spec in that chain SHALL be unaffected, since lineage is not a run-time resolution mechanism

### Requirement: Workflow-spec-version mismatch on fork is resolved by the authoring tool, not the platform
When a source workflow-spec and the forking writer's own work are authored against different workflow-spec versions (per the `workflowSpecVersion` versioning model), the workflow-spec store SHALL NOT be required to silently migrate or reject the mismatch. Surfacing and resolving such a mismatch SHALL be the responsibility of the external authoring tool, presented to the workflow-author for resolution.

#### Scenario: A version mismatch is surfaced to the author, not silently resolved
- **WHEN** a workflow-writer forks a workflow-spec authored against a different workflow-spec version than their own current work
- **THEN** the platform SHALL NOT be required to automatically migrate either workflow-spec, and the authoring tool SHALL be responsible for surfacing this mismatch to the author
