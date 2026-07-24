## ADDED Requirements

### Requirement: Compose docker service images into workflow-specs
The DSL SHALL allow a workflow-writer to define a workflow-spec as a directed graph of steps, where each step invokes a discoverable function of a registered docker service image (as exposed via the service's OpenAPI/registry entry).

#### Scenario: Referencing a registered service function
- **WHEN** a workflow-writer authors a step that invokes a function exposed by a registered service
- **THEN** the DSL SHALL validate that the function exists in the registry's OpenAPI specification for that service before the workflow-spec is accepted

#### Scenario: Unknown service function referenced
- **WHEN** a workflow-writer references a service function that does not exist in the registry
- **THEN** the DSL SHALL reject the workflow-spec with an error identifying the unresolved reference

### Requirement: Data bindings by source reference, not by value
The DSL SHALL require that data consumed by a step be expressed as a reference to a named source category - user, static, or session - rather than as an inlined literal value baked into the workflow-spec, except for genuinely constant configuration values.

#### Scenario: Binding to session data
- **WHEN** a workflow-writer binds a step's input to a session-scoped reference
- **THEN** the workflow-spec SHALL record the binding as a source category plus a logical reference key, resolved only at run time against the session/state layer

#### Scenario: Binding to static reference data
- **WHEN** a workflow-writer binds a step's input to a static data reference
- **THEN** the workflow-spec SHALL record the binding without embedding the underlying static data in the workflow-spec itself

### Requirement: Declare scope and mutability per binding; interactivity per session key
For each data binding, the DSL SHALL allow the workflow-writer to declare scope (static, session, or request) and mutability (whether the step may produce a new derived state), without requiring the workflow-writer to specify infrastructure mechanism (e.g. volumes, affinity, container pool sizing, byte-size thresholds). Interactivity (whether a binding is latency-sensitive/interactive or batch) SHALL be declared once per session key in the `sessionState` declaration, not repeated on each binding referencing that key, and SHALL NOT be a declarable property of a static-scope binding at all.

#### Scenario: Declaring a session-mutable binding
- **WHEN** a workflow-writer declares a binding with scope=session, mutable=true, referencing a key declared in `sessionState`
- **THEN** the workflow-spec SHALL persist scope and mutability as intent metadata attached to the binding, and SHALL resolve that key's interactivity from its single `sessionState` declaration

#### Scenario: Declaring a static read-only binding
- **WHEN** a workflow-writer declares a binding with scope=static, mutable=false
- **THEN** the workflow-spec SHALL persist the binding as shareable/read-only intent, eligible for cross-workflow reuse by the placement layer, with no interactivity field

#### Scenario: Multiple bindings to the same session key stay consistent
- **WHEN** two different steps each bind to the same session key
- **THEN** both SHALL resolve the same interactivity value from that key's single `sessionState` declaration, with no possibility of the two sites disagreeing

### Requirement: Same service usable with different scope declarations
The DSL SHALL allow the same underlying service function to be bound with different scope/mutability declarations across different workflow-specs (e.g. bound to a static dataset in one workflow and to session-owned data in another), without requiring changes to the service itself.

#### Scenario: Same SQL service used statically and per-session
- **WHEN** two separate workflow-specs both invoke the same SQL-execution service, one with a static-scope binding and one with a session-scope, mutable binding
- **THEN** the DSL SHALL accept both workflow-specs independently, with each binding's declared intent governing its own execution

### Requirement: Authored workflow-specs compile to a stable intermediate representation
The system SHALL compile any authored workflow-spec, regardless of authoring surface (e.g. a declarative document or a code-based builder), into a single stable intermediate representation (IR) consisting of steps, bindings, write declarations, secret references, and outputs. Only the IR SHALL be consumed by the execution engine and scheduler.

#### Scenario: Two authoring surfaces produce equivalent IR
- **WHEN** an equivalent workflow is authored once via a declarative surface and once via a code-based builder surface
- **THEN** both SHALL compile to IR that the execution engine treats identically

#### Scenario: Authoring-time computation does not require runtime determinism
- **WHEN** an authoring surface uses non-deterministic constructs (e.g. reading a local config file, calling an external API) to help construct a workflow-spec
- **THEN** this SHALL be permitted, because such constructs execute only at compile/synthesis time and never appear in the resulting IR or at workflow run time

### Requirement: A session key's seed/fallback source is declared once, in `sessionState`
The DSL SHALL allow a `sessionState` declaration to specify a fallback source (e.g. a static reference) to be used the first time that session key is read, before any session-owned snapshot exists for it. This SHALL be declared once per key, not repeated on individual bindings.

#### Scenario: First read of an unseeded session key
- **WHEN** a step reads a session-scoped binding whose logical key has no existing snapshot for the current session
- **THEN** the system SHALL resolve the binding using the declared fallback source

#### Scenario: Subsequent read of a seeded session key
- **WHEN** a step reads a session-scoped binding whose logical key already has a session-owned snapshot
- **THEN** the system SHALL resolve the binding from the existing session snapshot and SHALL NOT re-apply the fallback

### Requirement: Step dependency graph inferred from data references, with an explicit escape hatch
The DSL SHALL infer a step's dependencies from the step-output bindings it reads (i.e. referencing another step's output creates an implicit ordering dependency), and SHALL additionally allow an explicit ordering dependency to be declared between steps that have no data dependency.

#### Scenario: Implicit dependency from a data reference
- **WHEN** step B reads a binding sourced from step A's output
- **THEN** the DSL SHALL treat step A as a dependency of step B without requiring an explicit declaration

#### Scenario: Explicit ordering with no data dependency
- **WHEN** a workflow-writer declares that step B must run after step A even though step B does not read any of step A's outputs
- **THEN** the DSL SHALL accept an explicit ordering declaration and enforce it at execution time

### Requirement: Workflow-spec exposes a derived signature
The system SHALL derive, from a workflow-spec's IR, a signature consisting of: the set of request-scoped parameters callers must supply, whether execution requires an active session, and the set of named outputs - without requiring the workflow-writer to author this signature separately.

#### Scenario: Signature derived from bindings
- **WHEN** a workflow-spec is compiled
- **THEN** the system SHALL produce a signature listing every request-scoped binding as a required parameter and marking the workflow as session-requiring if any binding has session scope

#### Scenario: Signature published for discovery
- **WHEN** a workflow-spec's signature has been derived
- **THEN** the system SHALL make it discoverable to callers (e.g. the frontend) through the same registry/discovery mechanism used for service OpenAPI specifications

### Requirement: Branch construct with statically enumerable cases
The DSL SHALL support a branch construct that selects one of several statically declared sub-graphs to execute based on a runtime value, and SHALL require every possible case (including a default) to be declared in the IR even though only one is executed per run.

#### Scenario: Runtime value selects a declared case
- **WHEN** a branch step evaluates its selector against a runtime value matching one of its declared cases
- **THEN** the system SHALL execute only that case's sub-graph

#### Scenario: Scheduler pre-analyzes all cases
- **WHEN** a workflow-spec containing a branch step is submitted for scheduling analysis
- **THEN** the system SHALL be able to enumerate every declared case's service calls, secret references, and placement implications ahead of execution, regardless of which case is later taken

### Requirement: Map construct with statically declared body and dynamically sized cardinality
The DSL SHALL support a map/forEach construct whose iteration body (which service(s) it calls, what it reads/writes, its secret references) is statically declared, while the number of iterations is determined at run time from a runtime-sized collection. Each iteration SHALL execute as an independently tracked, durable unit of execution.

#### Scenario: Iteration count known only at runtime
- **WHEN** a map step's source collection size is not known until the workflow is executing
- **THEN** the system SHALL dynamically start one tracked execution per item without requiring the workflow-spec to declare the count in advance

#### Scenario: Partial failure within a map does not require re-running completed iterations
- **WHEN** one iteration of a map step fails after other iterations have already completed successfully
- **THEN** the system SHALL retry only the failed iteration and SHALL NOT re-execute the already-completed iterations

### Requirement: A map/forEach body may reference its current item via a dedicated binding source
The DSL SHALL provide a binding source that resolves to the current iteration's item within a map/forEach body, exposing the raw item value without a built-in path/field-extraction syntax.

#### Scenario: Body reads the raw current item
- **WHEN** a map/forEach body step binds an input to the current-item source
- **THEN** the system SHALL supply that iteration's item value directly

#### Scenario: Extracting a field from a compound item reuses compute, not a new path syntax
- **WHEN** a map/forEach body needs a specific field of a compound (object-shaped) current item
- **THEN** the workflow-spec SHALL express this via a computed binding referencing the current-item source, using the same logic-expression field-access operator used elsewhere, rather than a dedicated item-path syntax

### Requirement: Request-scoped bindings reference flat, named, typed parameters only
A request-scoped binding SHALL reference one of the workflow-spec's own declared parameter names (as derived into its signature), and the DSL SHALL NOT provide a path-expression syntax for reaching into a nested structure within a caller's request payload at the binding-source level.

#### Scenario: Binding names a declared parameter
- **WHEN** a workflow-writer declares a request-scoped binding
- **THEN** it SHALL reference a flat parameter name that appears in the workflow-spec's derived signature, not a dotted or nested path

#### Scenario: A parameter's own value may still be a compound object
- **WHEN** a declared parameter's value is itself a nested/compound object
- **THEN** the DSL SHALL pass it through opaquely to whichever step consumes it, without requiring the DSL to understand its internal shape

#### Scenario: Workflow-level inspection of a nested field reuses compute
- **WHEN** the workflow itself (e.g. a branch selector) needs to inspect a nested field within a compound parameter's value
- **THEN** the workflow-spec SHALL express this via a computed binding using the logic expression's field-access operator, not a dedicated request-path syntax

### Requirement: Static dataset references use a namespaced, tag/digest-addressable URN; service references use OCI identifiers
A static-scope binding's reference SHALL be a URN identifying the dataset by namespace and name, with either a mutable tag or an immutable content digest. A reference to a specific pinned service version, where used, SHALL use a real OCI image reference (tag or digest), never the dataset URN scheme.

#### Scenario: Tag-based static reference
- **WHEN** a workflow-writer references a static dataset by a mutable tag
- **THEN** the system SHALL resolve the current digest for that tag through the dataset resource catalog at the time of resolution

#### Scenario: Digest-pinned static reference never drifts
- **WHEN** a workflow-writer references a static dataset by its content digest directly
- **THEN** the resolved dataset SHALL always be the exact same immutable content, regardless of any later change to a tag that once pointed at it

#### Scenario: Dataset references and service references are not interchangeable
- **WHEN** a reference is being validated
- **THEN** the DSL SHALL reject a dataset URN used where an OCI service reference is expected, and vice versa

### Requirement: Computed bindings via a bounded, serializable logic expression
The DSL SHALL support a binding kind whose value is derived by evaluating a bounded, serializable, side-effect-free logic expression (e.g. JSON-Logic or CEL) against a set of already-resolved input bindings, without invoking a registered service and without scheduling any execution unit for the evaluation.

#### Scenario: Branch selector computed without a service call
- **WHEN** a branch step's selector is declared as a computed binding evaluating a comparison over a prior step's output
- **THEN** the system SHALL evaluate the expression directly, without invoking any registered service and without a placement/scheduling decision

#### Scenario: Computed binding cannot reference a secret
- **WHEN** a computed binding's inputs are declared
- **THEN** the system SHALL reject any attempt to supply a secret reference as an input to the expression

#### Scenario: Computed binding is distinct from the dynamic map/forEach construct
- **WHEN** a computed binding's expression includes an operator that transforms an already-resolved, finite, in-memory array (e.g. an internal map/filter/reduce operator of the chosen logic language)
- **THEN** this SHALL be treated purely as in-memory computation and SHALL NOT be conflated with, or capable of triggering, the DSL's dynamic map/forEach construct (which fans out to services as tracked, durable child executions)

### Requirement: Utility leaf services remain available for non-pure transforms
The registry MAY expose generic utility leaf services (e.g. for transforms requiring external computation, heavier processing, or domain logic) for cases that exceed what a bounded, side-effect-free logic expression can express; workflow-writers SHALL use a computed binding rather than a utility service wherever the transform is pure, bounded, and side-effect-free.

#### Scenario: Pure comparison uses a computed binding, not a service
- **WHEN** a workflow-writer needs a simple comparison or field extraction with no external data access
- **THEN** a computed binding SHALL be preferred over introducing a dedicated utility service for that purpose

### Requirement: A step's binding must satisfy every required parameter of the function it invokes
The DSL SHALL validate, for every step, that a binding is supplied for each parameter the invoked function's registry/OpenAPI signature declares as required, and SHALL reject the workflow-spec otherwise. This is a generic validation rule with no special case for any particular kind of required parameter.

#### Scenario: Missing required parameter is rejected
- **WHEN** a step invokes a function that declares a required parameter, and the workflow-spec supplies no binding for it
- **THEN** the DSL SHALL reject the workflow-spec

#### Scenario: A composing service's allowlist and governor are required parameters, not a special construct
- **WHEN** a step invokes a registered service whose signature declares `allowedTools` and `governor` as required parameters (e.g. an agent-runner service composing other services per an "open" target declaration - see the `service-composability` capability)
- **THEN** this generic rule alone SHALL require the workflow-writer to supply both bindings, with no DSL-level construct specific to agents or allowlists

### Requirement: IR carries a whole-document version tag with forward-only, lazy migration
Every compiled IR document SHALL carry a whole-document version tag. The system SHALL migrate a document to the current version lazily the first time it is opened, using a chain of version-to-version migrators, and SHALL NOT support migrating a document backward to an older version.

#### Scenario: Older document is migrated on open
- **WHEN** a workflow-spec IR document tagged with an older, still-supported version is opened
- **THEN** the system SHALL apply the applicable chain of migrators and SHALL persist the result in the current version's form on next save

#### Scenario: Document newer than the reader is rejected
- **WHEN** a workflow-spec IR document's version tag is newer than the version the reader (e.g. the UI tool or the runtime) understands
- **THEN** the system SHALL fail closed with an explicit unsupported-version error rather than attempting a best-effort read

#### Scenario: Additive change does not require a version bump
- **WHEN** a new binding kind or a new optional step field with a default value is added to the IR schema
- **THEN** this SHALL NOT require bumping the version tag, since existing documents remain valid without migration

### Requirement: Deprecated IR versions require a migration sweep before retirement
The system SHALL define a minimum supported version window and SHALL require a batch migration sweep over all stored workflow-specs below that window before retiring the migrators for versions outside it.

#### Scenario: Retiring an old migrator
- **WHEN** a version falls outside the minimum supported window
- **THEN** the system SHALL NOT retire that version's migrator until a sweep confirms no stored workflow-spec still depends on it
