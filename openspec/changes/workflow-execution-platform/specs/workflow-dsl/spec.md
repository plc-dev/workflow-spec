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

### Requirement: Step identifiers are human-chosen and unique within the whole workflow-spec
A step's identifier SHALL be a workflow-writer-chosen string, validated unique across the entire workflow-spec - including steps nested within different `branch` cases or within a `map`/`forEach` body - rather than scoped per-case or per-body, and rather than being an opaque, platform-generated value.

#### Scenario: Duplicate step ids are rejected regardless of nesting
- **WHEN** two steps share the same identifier, whether at the top level or nested within different `branch` cases or `map` bodies
- **THEN** the DSL SHALL reject the workflow-spec as having a duplicate step identifier

#### Scenario: A step in one branch case may be referenced from outside it
- **WHEN** a step id is declared inside a `branch` case or `map` body
- **THEN** it SHALL be resolvable via `dependsOn` or a step-output binding using the same flat id-namespace as any top-level step

### Requirement: Secret references are declared separately from data bindings
A step SHALL declare its secret references in a distinct location from its data (`reads`/`writes`) bindings, rather than as a kind of `Binding`. This preserves the categorical exclusion of secrets from binding-only contexts (e.g. a `compute` binding's `using` inputs, which SHALL NOT accept a secret reference under any binding kind).

#### Scenario: A secret reference is not a binding kind
- **WHEN** a step declares a secret reference
- **THEN** the DSL SHALL require it in a location distinct from that step's `reads`/`writes` bindings, and SHALL NOT accept a secret reference expressed as a `from: secret`-style binding

### Requirement: A literal binding kind supplies a fixed value with no external reference
The DSL SHALL support a `literal` binding kind whose value is a fixed value (including an arbitrary compound/nested structure) authored directly in the workflow-spec, passed through opaquely without invoking a registered service, resolving a data source, or requiring a placement/scheduling decision.

#### Scenario: A literal value is used as-is
- **WHEN** a binding is declared as a `literal`
- **THEN** the system SHALL use its authored value directly at run time, without any resolution step

#### Scenario: A literal binding supplies a structured value
- **WHEN** a `literal` binding's authored value is a compound/nested structure (e.g. a list of function references for a nesting allowlist)
- **THEN** the DSL SHALL pass it through opaquely, the same way a compound `request`-scoped parameter value is passed through

### Requirement: Workflow-spec exposes a derived signature
The system SHALL derive, from a workflow-spec's IR, a signature consisting of: the set of request-scoped parameters callers must supply, whether execution requires an active session, and the set of named outputs - without requiring the workflow-writer to author this signature separately.

#### Scenario: Signature derived from bindings
- **WHEN** a workflow-spec is compiled
- **THEN** the system SHALL produce a signature listing every request-scoped binding as a required parameter and marking the workflow as session-requiring if any binding has session scope

#### Scenario: Signature published for discovery
- **WHEN** a workflow-spec's signature has been derived
- **THEN** the system SHALL make it discoverable to callers (e.g. the frontend) through the workflow-spec store's discovery mechanism (see `workflow-spec-store`) - not through the service registry, which indexes service images only

### Requirement: A step invokes a registered service function; workflow-to-workflow reuse is not a step-level construct
A step SHALL be defined as an invocation of a discoverable function of a registered service image. The DSL SHALL NOT provide a step kind that references another workflow-spec at run time; reuse of one workflow-spec by another happens by forking at authoring time (see `workflow-spec-store`), which produces an ordinary, self-contained workflow-spec whose steps are indistinguishable, at the DSL/IR level, from steps authored directly.

#### Scenario: A forked workflow-spec's steps are ordinary steps
- **WHEN** a workflow-spec was produced by forking another workflow-spec
- **THEN** its steps SHALL be defined the same way as any directly-authored step (an invocation of a registered service function), with no residual step-level dependency on the source workflow-spec

#### Scenario: There is no run-time reference to another workflow-spec
- **WHEN** a workflow-spec is compiled to IR
- **THEN** the IR SHALL NOT contain a reference to another workflow-spec's identity that requires resolution at run time; any relationship to a source workflow-spec is fork-lineage metadata external to the IR (see `workflow-spec-store`), not a binding or step

### Requirement: A concrete nesting target is supplied as an ordinary DSL binding, not a registry-level declaration
Where a registered service's function declares (via its `nesting_declaration` capability metadata, see `service-registry`) that it may nest other services' functionality, the DSL SHALL allow the concrete function(s) that fill that nesting to be supplied as ordinary parameter bindings of the step invoking that function - not as a separate, nesting-specific DSL construct.

#### Scenario: An enumerable nesting target is bound like any other parameter
- **WHEN** a step invokes a function whose `nesting_declaration` specifies an enumerable target set
- **THEN** the concrete function(s) it nests SHALL be supplied via the step's ordinary parameter bindings, validated by the same generic required-parameter rule as any other binding

#### Scenario: An open nesting target's allowlist is an ordinary required parameter, bound as a literal
- **WHEN** a step invokes a function whose `nesting_declaration` specifies an open target set (e.g. an agent-runner)
- **THEN** the allowlist SHALL be supplied as a `literal` binding (not dynamically bound from `request`, `session`, or another step's output), and the governor SHALL be supplied as an ordinary required parameter of that function's signature, per the generic required-parameter validation rule, with no agent-specific or nesting-specific DSL construct

#### Scenario: A literal-bound allowlist is a valid target for pre-warming candidacy
- **WHEN** an open-target step's allowlist binding resolves at authoring/compile time (because it is a `literal`)
- **THEN** the scheduler MAY treat the allowlist's named functions as candidates for the placement/pooling admission model (per `execution-scheduling`), without being required to unconditionally pre-warm every listed target

### Requirement: A nesting-target or callback-shaped parameter's literal binding resolves to a minted reference at run time, not its literal value directly
Where a step's binding fills a nesting-target-typed parameter or a parameter declared with an OpenAPI `callbacks`/`webhooks` contract (see `service-nesting`), the DSL SHALL still require it to be authored as an ordinary `literal` binding naming the concrete target service and function, but the system SHALL resolve that binding at run time to a freshly minted, single-purpose callback reference rather than passing the literal value through unresolved.

#### Scenario: A nesting-target literal resolves differently from an ordinary literal
- **WHEN** a step's parameter is recognized as nesting-target-typed or callback-shaped, and is bound with a `literal` naming a target service and function
- **THEN** the system SHALL resolve that binding, at run time, to a minted callback reference for that specific target rather than passing the literal's authored value through unchanged

#### Scenario: Independent nesting slots on one function each resolve independently
- **WHEN** a function declares more than one nesting-target-typed or callback-shaped required parameter
- **THEN** the workflow-spec SHALL bind each independently, and each SHALL resolve to its own independently minted callback reference

### Requirement: Binding a target to a declared callback contract requires an exact schema match at compile time
Where a parameter's declared contract (an OpenAPI `callbacks`/`webhooks` object, see `service-registry`/`service-nesting`) specifies a request/response schema, the DSL SHALL validate at compile time that the bound target function's own native input/output schema exactly satisfies that declared schema, and SHALL reject the workflow-spec if it does not. This validation SHALL NOT accept a transform or adapter as a substitute for an exact match.

#### Scenario: Compile-time rejection on schema mismatch
- **WHEN** a workflow-spec binds a callback-shaped parameter to a target function whose native schema does not exactly satisfy the parameter's declared callback contract
- **THEN** the DSL SHALL reject the workflow-spec at compile time, identifying the incompatible binding

### Requirement: Branch construct with statically enumerable cases
The DSL SHALL support a branch construct that selects one of several statically declared sub-graphs to execute based on a runtime value, and SHALL require every possible case (including a default) to be declared in the IR even though only one is executed per run.

#### Scenario: Runtime value selects a declared case
- **WHEN** a branch step evaluates its selector against a runtime value matching one of its declared cases
- **THEN** the system SHALL execute only that case's sub-graph

#### Scenario: Scheduler pre-analyzes all cases
- **WHEN** a workflow-spec containing a branch step is submitted for scheduling analysis
- **THEN** the system SHALL be able to enumerate every declared case's service calls, secret references, and placement implications ahead of execution, regardless of which case is later taken

### Requirement: Each branch case exposes its result via `yields`, a stable name independent of which case ran
Each case of a branch construct SHALL declare a `yields` mapping of named bindings pointing into that case's own internal steps. A step outside the branch that needs a value produced by whichever case executes SHALL reference the branch's own step id and a `yields` name, never a specific case's internal step id directly.

#### Scenario: Downstream reference resolves regardless of which case ran
- **WHEN** a step after a branch reads `{ from: step, id: <branchId>, output: <yieldsName> }`
- **THEN** the system SHALL resolve it through whichever case's `yields` declaration actually executed, without the reading step needing to know which case that was

#### Scenario: A case's internal step id is not directly referenceable from outside the branch
- **WHEN** a step outside a branch attempts to reference a step id declared inside one of that branch's cases directly (not through `yields`)
- **THEN** the DSL SHALL reject the workflow-spec, since that step id's output only conditionally exists

#### Scenario: `yields` defaults to a single step's whole output when a case has exactly one step
- **WHEN** a branch case contains exactly one step and declares no explicit `yields`
- **THEN** the system SHALL treat that single step's whole output object as the case's yielded value

#### Scenario: `yields` is required when a case has more than one step
- **WHEN** a branch case contains more than one step
- **THEN** the DSL SHALL reject the case if it declares no `yields`, since no step's output can be inferred as "the" result

### Requirement: Map construct with statically declared body and dynamically sized cardinality
The DSL SHALL support a map/forEach construct whose iteration body (which service(s) it calls, what it reads/writes, its secret references) is statically declared, while the number of iterations is determined at run time from a runtime-sized collection. Each iteration SHALL execute as an independently tracked, durable unit of execution.

#### Scenario: Iteration count known only at runtime
- **WHEN** a map step's source collection size is not known until the workflow is executing
- **THEN** the system SHALL dynamically start one tracked execution per item without requiring the workflow-spec to declare the count in advance

#### Scenario: Partial failure within a map does not require re-running completed iterations
- **WHEN** one iteration of a map step fails after other iterations have already completed successfully
- **THEN** the system SHALL retry only the failed iteration and SHALL NOT re-execute the already-completed iterations

### Requirement: A map's per-iteration result is exposed via `yields`, collected into a parallel array
A map/forEach construct SHALL declare a `yields` mapping of named bindings pointing into its body's own internal steps. Each named entry SHALL be collected across all iterations into an array, in the same order as the source collection, addressable by a step outside the map via the map's own step id and the `yields` name.

#### Scenario: A named yield is collected into a parallel array
- **WHEN** a map's `yields` declares a named binding pointing at a body step's output field
- **THEN** the system SHALL collect that field's value from every iteration into an array, ordered to match the source collection, addressable as `{ from: step, id: <mapId>, output: <yieldsName> }`

#### Scenario: Multiple named yields produce independent parallel arrays
- **WHEN** a map's `yields` declares more than one named binding
- **THEN** each name SHALL produce its own independently addressable array, all ordered consistently with the source collection

#### Scenario: A body step's id is not directly referenceable from outside the map
- **WHEN** a step outside a map attempts to reference a step id declared inside that map's body directly (not through `yields`)
- **THEN** the DSL SHALL reject the workflow-spec, since that step id exists once per iteration, not as a single addressable value

#### Scenario: `yields` defaults to a single step's whole output when a body has exactly one step
- **WHEN** a map's body contains exactly one step and declares no explicit `yields`
- **THEN** the system SHALL treat that single step's whole output object as the per-iteration yielded value, collected into an array

#### Scenario: `yields` is required when a body has more than one step
- **WHEN** a map's body contains more than one step
- **THEN** the DSL SHALL reject the map construct if it declares no `yields`, since no step's output can be inferred as "the" per-iteration result

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

#### Scenario: A nesting service's allowlist and governor are required parameters, not a special construct
- **WHEN** a step invokes a registered service whose signature declares `allowedTools` and `governor` as required parameters (e.g. an agent-runner service nesting other services per an "open" target declaration - see the `service-nesting` capability)
- **THEN** this generic rule alone SHALL require the workflow-writer to supply both bindings, with no DSL-level construct specific to agents or allowlists

### Requirement: IR carries a whole-document version tag with forward-only, lazy migration
Every compiled IR document SHALL carry a whole-document version tag, named `irVersion`, at the top level of the document. The system SHALL migrate a document to the current version lazily the first time it is opened, using a chain of version-to-version migrators, and SHALL NOT support migrating a document backward to an older version.

#### Scenario: Older document is migrated on open
- **WHEN** a workflow-spec IR document tagged with an older, still-supported version is opened
- **THEN** the system SHALL apply the applicable chain of migrators and SHALL persist the result in the current version's form on next save

#### Scenario: Document newer than the reader is rejected
- **WHEN** a workflow-spec IR document's version tag is newer than the version the reader (e.g. the UI tool or the runtime) understands
- **THEN** the system SHALL fail closed with an explicit unsupported-version error rather than attempting a best-effort read

#### Scenario: Additive change does not require a version bump
- **WHEN** a new binding kind or a new optional step field with a default value is added to the IR schema
- **THEN** this SHALL NOT require bumping the version tag, since existing documents remain valid without migration

### Requirement: An `itemResource` binding kind resolves a request-scoped item identifier and path into an item-type resource, deferring the shared-vs-inline classification to run time
The DSL SHALL support an `itemResource` binding kind referencing an item-instance identifier (typically itself a `request`-scoped binding) and a path locator into that instance's resolved resource manifest. The workflow-spec SHALL NOT declare, at authoring time, whether a given path resolves to a shareable dataset reference or a plain value - this SHALL be determined at resolution time from the actual resolved manifest.

#### Scenario: An itemResource binding resolves to a dataset reference
- **WHEN** an `itemResource` binding's path resolves, for the current item instance, to a heavy/dataset-shaped resource
- **THEN** the system SHALL treat the resolved binding as an ordinary static-scope dataset reference, eligible for the same materialization/placement/pooling treatment as any authoring-time static binding

#### Scenario: An itemResource binding resolves to a plain value
- **WHEN** an `itemResource` binding's path resolves, for the current item instance, to a light/plain-value resource
- **THEN** the system SHALL pass the resolved value through to the consuming step directly, without invoking dataset materialization machinery

#### Scenario: One workflow run binds to exactly one item instance
- **WHEN** a workflow-spec containing one or more `itemResource` bindings is executed
- **THEN** every `itemResource` binding in that run SHALL resolve against the same single item-instance identifier; the DSL SHALL NOT provide a construct for binding different `itemResource` references within one run to different item instances

### Requirement: `itemResource` path addressing is arbitrarily nested, using a locator syntax rather than the flat-only request-parameter rule
An `itemResource` binding's `path` SHALL be permitted to address an arbitrarily deeply nested location within the resolved item manifest, using a structural locator syntax (e.g. JSON Pointer). This SHALL NOT be governed by the flat-parameter-name-only rule that applies to `request`-scoped bindings, since an `itemResource` path addresses into an externally-sourced document to determine what gets bound, rather than extracting a field from an already-bound in-memory value.

#### Scenario: A deeply nested path is accepted
- **WHEN** a workflow-writer declares an `itemResource` binding whose `path` addresses a location nested more than one level deep within the item manifest's structure
- **THEN** the DSL SHALL accept the binding without requiring it to be flattened into a top-level named parameter

#### Scenario: Path/manifest shape mismatches are not a compile-time DSL error
- **WHEN** an `itemResource` binding's `path` does not exist within a given item instance's actual resolved manifest at run time
- **THEN** the system SHALL surface this as a run-time resolution failure; the DSL SHALL NOT be required to detect this at compile time, since keeping a workflow-spec's `itemResource` paths consistent with an item type's resource shape is delegated to external authoring tooling and/or the item type's own authoring flow, not enforced by the platform

### Requirement: Deprecated IR versions require a migration sweep before retirement
The system SHALL define a minimum supported version window and SHALL require a batch migration sweep over all stored workflow-specs below that window before retiring the migrators for versions outside it.

#### Scenario: Retiring an old migrator
- **WHEN** a version falls outside the minimum supported window
- **THEN** the system SHALL NOT retire that version's migrator until a sweep confirms no stored workflow-spec still depends on it
