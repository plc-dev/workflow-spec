## ADDED Requirements

### Requirement: Registry stores service metadata, not image bytes
The registry SHALL store metadata about a service image, keyed by that image's digest, and SHALL reference the image's bytes via an OCI pointer (`oci_ref`) into a separately-operated OCI-compliant registry rather than storing or serving image bytes itself.

#### Scenario: Registering an entry does not upload image bytes
- **WHEN** a service image is registered
- **THEN** the registry SHALL record an `oci_ref` pointing at the image's existing location in an OCI-compliant registry, and SHALL NOT require or store the image's bytes

### Requirement: OpenAPI spec is the sole stored contract; CLI and MCP surfaces are projected
Each registry entry SHALL store exactly one contract - an OpenAPI specification - per image digest. The registry SHALL NOT store a separately-authored MCP specification or any other duplicate contract for the same digest; any CLI or MCP tool surface SHALL be derived (projected) from the stored OpenAPI specification at read time.

#### Scenario: MCP tool definitions are derived, not stored
- **WHEN** an MCP tool surface is produced for a registered function
- **THEN** its name, description, and input schema SHALL be derived from that function's stored OpenAPI specification, and no separate MCP specification SHALL exist to diverge from it

### Requirement: Capability metadata is declared per function, at digest granularity
The registry SHALL allow each function of a registered image to declare, independently of other functions on the same image: whether it mutates state, its materialization cost class, whether it supports copy-on-write/incremental snapshotting, and whether it reports change-detection on calls. These declarations SHALL be scoped to the image's specific digest, not to the service name in the abstract.

#### Scenario: Two functions on the same image declare differently
- **WHEN** one function of a registered image is declared non-mutating and another function of the same image is declared mutating
- **THEN** the registry SHALL retain both declarations independently, and a query for one function's capability metadata SHALL NOT be affected by the other function's declaration

### Requirement: Hardware requirements are declared per image, outside the trust-tier model
The registry SHALL allow each registered image to declare its hardware requirements (e.g. CPU, memory, GPU, node class) at whole-image granularity. This declaration SHALL NOT be subject to the capability-declaration trust-tier gating that applies to capability metadata (mutates/COW/change-detection); a hardware-requirements declaration SHALL be usable by the scheduler and autoscaling layers regardless of the image's current trust tier.

#### Scenario: Hardware requirements are usable before conformance passes
- **WHEN** an image's trust tier is `unverified`
- **THEN** the scheduler and autoscaling layers MAY still use that image's declared hardware requirements for placement and capacity planning, even though its capability metadata is not yet trusted for sharing/pooling/COW decisions

### Requirement: Nesting is declared per function as a possibility, not a concrete binding
The registry SHALL allow each function of a registered image to declare whether its own execution may invoke other registered services' functionality ("nesting"), and if so, the transport used (`sdk`, `http`, `cli`, or `mcp`) and whether its reachable target set is enumerable (a fixed, declared list) or open (determined per invocation). This declaration SHALL record only the possibility and shape of nesting; it SHALL NOT itself name which concrete workflow-spec-level binding fills that nesting at invocation time.

#### Scenario: A function declares an open, MCP-transported nesting target
- **WHEN** a function is registered as capable of nesting other services' functionality via MCP with an open target set
- **THEN** the registry SHALL record this declaration against that function, and SHALL treat the concrete set of services reachable in any given invocation as a fact resolved elsewhere (at the workflow-spec/DSL level), not as part of this declaration

### Requirement: Placement facts are readable as a single atomic view per digest
The registry SHALL expose a single read operation that returns a function's capability metadata, its image's trust tier, and its image's hardware requirements together as one atomic result for a given digest and function. The registry SHALL NOT require or encourage callers needing all three facts to issue separate reads that could observe an inconsistent combination (e.g. a trust-tier demotion landing between two reads).

#### Scenario: Scheduler placement read is atomic
- **WHEN** the scheduler requests placement facts for a step bound to a specific digest and function
- **THEN** the registry SHALL return capability metadata, trust tier, and hardware requirements as a single consistent result, reflecting one point in time

### Requirement: Workflow-spec bindings resolve against a pinned digest at authoring time
A workflow-spec step that invokes a registered function SHALL resolve to a specific image digest at the time the workflow-spec is authored, not to a mutable tag re-resolved at dispatch time.

#### Scenario: A redeploy does not affect an already-authored workflow-spec
- **WHEN** a registered image is redeployed under the same name, producing a new image digest
- **THEN** an already-authored workflow-spec step that was pinned to the prior digest SHALL continue to resolve to that prior digest and its associated trust tier, unaffected by the redeploy

### Requirement: Registration and trust-tier updates are separate, independently privileged write operations
The registry SHALL expose registering a new image (with its initial OpenAPI spec, capability metadata, hardware requirements, nesting declaration, and OCI reference) as an operation distinct from updating an image's trust tier, and SHALL restrict each operation to a different actor: registering a new image SHALL be restricted to platform developers, and SHALL NOT be reachable by the workflow platform's own runtime; updating an image's trust tier SHALL be reachable by the workflow platform's runtime (e.g. its conformance-testing pipeline), and SHALL NOT require platform-developer involvement for each update.

#### Scenario: The runtime cannot register a new image
- **WHEN** the workflow platform's runtime (including its conformance pipeline) attempts to introduce a new image into the registry
- **THEN** the registry SHALL reject the attempt; only a platform-developer-privileged path SHALL be able to register a new image

#### Scenario: The conformance pipeline can update trust tier without developer involvement
- **WHEN** the workflow platform's conformance pipeline completes a conformance run for an already-registered image digest
- **THEN** the registry SHALL accept a trust-tier update from that pipeline without requiring a platform-developer-privileged action

### Requirement: Every registered function complies with a mandated CLI dispatch contract, not a discovered capability
The engine SHALL invoke every registered function via the CLI transport for ordinary step dispatch - never REST - regardless of whether a given call's bindings are heavy or light. The registry SHALL require every registered function to comply with one universal, platform-mandated calling convention: light bindings passed as ordinary CLI arguments, and any binding classified as heavy/dataset-scoped passed via a local filesystem path argument plus a content-hash-derived state key argument. Transport shape SHALL NOT be treated as a per-function capability the registry discovers or that a function author may vary, and SHALL NOT be folded into the discovered capability metadata (mutates/materialization-cost/COW/change-detection) that this registry captures elsewhere. A registered function MAY also expose a REST surface (e.g. for external callers outside the engine's own step dispatch), but the engine SHALL NOT use it to dispatch a step.

#### Scenario: Every function is onboarded against one fixed CLI contract
- **WHEN** any function is registered, regardless of whether its bindings are ever heavy
- **THEN** the registry SHALL require it to be invocable via the platform's mandated CLI convention, accepting a local-path argument and a state-key argument whenever a given call's binding is heavy/dataset-scoped, and SHALL NOT accept an alternative, function-declared transport shape in its place

#### Scenario: Transport shape is not queried as a discovered capability
- **WHEN** the placement/scheduling layer requests a function's capability metadata
- **THEN** the returned metadata SHALL contain only the existing discovered facts (mutation, materialization-cost class, COW support, change-detection), and SHALL NOT contain a per-function transport-shape field, since transport shape is fixed by the mandated contract rather than discovered per function

#### Scenario: A function's own REST surface, if any, is never used for step dispatch
- **WHEN** a registered function exposes a REST endpoint in addition to its mandated CLI contract
- **THEN** the engine SHALL dispatch that function's steps via the CLI contract only, and SHALL NOT invoke the REST endpoint as part of ordinary step execution

#### Scenario: A service without a native CLI is not onboardable, and the registry SHALL NOT substitute a generated wrapper
- **WHEN** an image intended for registration does not itself expose a CLI entrypoint satisfying the mandated contract (e.g. it exposes only a REST API)
- **THEN** the registry SHALL NOT register it by generating a platform-side CLI wrapper in place of a native one, and registration SHALL be rejected or deferred until the image itself ships a compliant CLI entrypoint

### Requirement: Registry entries represent service images only
A registry entry SHALL represent a single service image and SHALL NOT represent a workflow-spec. The registry SHALL NOT provide a mechanism for publishing a workflow-spec as an invocable registry entry.

#### Scenario: A workflow-spec cannot be registered
- **WHEN** an attempt is made to register a workflow-spec as a registry entry
- **THEN** the registry SHALL reject the attempt, since registry entries are scoped to service images only
