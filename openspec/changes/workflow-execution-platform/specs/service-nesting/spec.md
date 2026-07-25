## ADDED Requirements

### Requirement: Inter-service nesting defaults to an orchestrator-aware path
Where a service's own implementation needs to call other registered services from inside its own execution ("nesting"), the system SHALL require this to go through an orchestrator-aware path by default, preserving retry, secret-scoping, and placement guarantees for each inner call.

#### Scenario: Default nesting preserves guarantees
- **WHEN** a service nests a call to another registered service without declaring an exception
- **THEN** each inner call SHALL be tracked, retried, and secret-scoped the same as any top-level step invocation

#### Scenario: Silent direct calls are not a supported default
- **WHEN** a service's capability declaration does not declare a guarantees-forfeited exception
- **THEN** the system SHALL NOT treat a raw, untracked HTTP/CLI call from that service to another registered service as a supported nesting path

### Requirement: Bypassing the orchestrator-aware path requires an explicit, declared exception
The registry SHALL require any service that nests calls to other registered services outside the orchestrator-aware path to declare this explicitly via its `nesting_declaration` capability metadata (see `service-registry`), naming the transport and the forfeited guarantees, and SHALL treat this declaration as subject to the same trust-tier review as other capability claims.

#### Scenario: Declared exception is visible and reviewable
- **WHEN** a service declares a guarantees-forfeited nesting exception
- **THEN** the declaration SHALL record the transport used (e.g. http, cli) and SHALL be visible to registry-side review, not merely trusted on assertion

#### Scenario: Undeclared bypass is a capability-declaration violation
- **WHEN** a service is found to nest a call to another registered service outside the orchestrator-aware path without having declared the exception
- **THEN** the system SHALL treat this the same as any other false capability declaration (see the trust-tier and runtime invariant-check requirements in `execution-scheduling`)

### Requirement: A nesting service's target set may be enumerable or open
A nesting service's `nesting_declaration` capability metadata SHALL specify whether the set of services it may reach is statically enumerable (`targets` lists specific services/functions) or open (determined per-invocation by an external decision process, e.g. an agent), and SHALL specify the transport (e.g. sdk, mcp, http, cli). This declaration records only the *possibility* and shape of nesting; the concrete function a given workflow-spec binds to fill an open or enumerable slot is a DSL-level binding (see `workflow-dsl`), not part of this declaration.

#### Scenario: Enumerable target set
- **WHEN** a nesting service declares a specific, fixed list of target services/functions
- **THEN** the system SHALL treat that list as the complete set the service may ever reach

#### Scenario: Open target set is bounded per invocation, not by the declaration alone
- **WHEN** a nesting service declares an open target set (e.g. an agent-runner service using MCP)
- **THEN** the actual set of services reachable in a given invocation SHALL be bounded by the allowlist parameter supplied to that specific invocation, not by an unbounded default

### Requirement: Allowlist enforcement happens at dispatch time in the nesting-enforcement layer, not by trusting the nesting service
For a nesting service with an open target set, the system SHALL enforce the per-invocation allowlist at the point of dispatching each inner call, refusing calls outside the allowlist and withholding any secret scoped to a refused target, regardless of what the nesting service's own code attempts.

#### Scenario: Call outside the allowlist is refused at dispatch
- **WHEN** a nesting service with an open target set attempts to invoke a service not present in the allowlist supplied for that invocation
- **THEN** the nesting-enforcement layer SHALL refuse the call and SHALL NOT resolve any secret scoped to that service, independent of the nesting service's own behavior

### Requirement: A durable governor bounds an open-target nesting service's call sequence
Where a nesting service's target set is open, its invocation SHALL be bounded by a governor (e.g. maximum call count, cost budget, or timeout) whose accumulated state is durable and checked before dispatching each call, such that a crash and resume does not reset progress toward the limit.

#### Scenario: Governor state survives a crash mid-loop
- **WHEN** a nesting service with an open target set crashes after several inner calls and is resumed
- **THEN** the resumed execution SHALL continue from the durably-tracked count/cost already accumulated, not from zero

#### Scenario: Governor limit reached stops further dispatch
- **WHEN** an open-target nesting service's accumulated count, cost, or elapsed time reaches its declared governor limit
- **THEN** the nesting-enforcement layer SHALL stop dispatching further inner calls for that invocation

### Requirement: Pure computed bindings are exempt from allowlist requirements
A computed binding (per the `workflow-dsl` capability's bounded logic expression) SHALL NOT require allowlist declaration or enforcement, since it cannot invoke a service, access a secret, or produce a side effect by construction.

#### Scenario: Compute-only tool is always reachable
- **WHEN** an open-target nesting service's invocation offers a purely computed transform as an available tool
- **THEN** the system SHALL NOT require that transform to appear in the invocation's allowlist

### Requirement: Orchestrator-aware nesting is realized via minted, single-purpose callback references, never a caller-specified target
For the default orchestrator-aware path with an enumerable target set, the system SHALL realize each nesting slot as a freshly minted, single-purpose, opaque callback reference resolved at run time - never as a generic dispatch endpoint into which the nesting service specifies its own target. The nesting service's own request to that reference SHALL contain only the target function's own native input, with no field identifying the target.

#### Scenario: A minted callback reference is single-purpose
- **WHEN** a step's nesting-target parameter resolves at run time
- **THEN** the resolved value SHALL be an opaque reference bound to exactly one target service and function, and SHALL NOT accept a caller-supplied target identifier at the point of use

#### Scenario: The request to a callback reference carries no target-identifying field
- **WHEN** a nesting service issues its own call to a resolved callback reference
- **THEN** the request body SHALL contain only the target function's own declared input parameters, and the system SHALL determine the target from the reference itself, not from any field in the request body

### Requirement: Callback-reference identity and governance context are derived server-side, never trusted from caller-supplied fields
The system SHALL derive a callback reference's associated execution, step, target, and remaining governor budget entirely server-side, from the reference itself, and SHALL NOT accept or trust any caller-supplied claim of this context when handling a call to that reference.

#### Scenario: A caller-supplied identity claim is ignored
- **WHEN** a nesting service's call to a callback reference includes a field claiming a particular execution, step, or target
- **THEN** the system SHALL determine the actual execution, step, target, and governor state from the reference itself, and SHALL ignore any such caller-supplied claim

### Requirement: A generic callback-accepting parameter's compatibility is declared via the target function's own OpenAPI callbacks/webhooks contract, checked exactly, with no adapter
Where a registered function accepts a parameter that is itself a callback URL invoked with a caller-defined request/response contract (as opposed to a platform-recognized nesting-target type), that function's own OpenAPI operation SHALL declare the exact contract via a `callbacks` (or `webhooks`) object. When a workflow-writer binds such a parameter to a concrete target function, the system SHALL require the target function's own native input/output schema to exactly satisfy the declared contract, and SHALL reject the workflow-spec otherwise. The system SHALL NOT provide an adapter or transform mechanism to bridge a schema mismatch.

#### Scenario: An exactly matching target is accepted
- **WHEN** a workflow-writer binds a callback-shaped parameter to a target function whose native input/output schema exactly matches the declared `callbacks` contract
- **THEN** the workflow-spec SHALL be accepted, and the callback SHALL resolve to a minted reference for that target the same way an ordinary nesting-target parameter does

#### Scenario: A near-but-not-exact match is rejected, not adapted
- **WHEN** a workflow-writer binds a callback-shaped parameter to a target function whose native schema differs from the declared `callbacks` contract, even in a way that could be trivially reshaped
- **THEN** the system SHALL reject the workflow-spec, and SHALL NOT apply any transform or adapter to reconcile the mismatch

### Requirement: MCP is one transport realization of the nesting model, not a separate mechanism
Where a nesting service declares `via: mcp`, the system SHALL translate its declared/allowlisted target functions into MCP tool definitions dynamically, scoped to that specific invocation's allowlist, and SHALL route every resulting tool call through the same dispatch, secret-resolution, and governor-enforcement path used for any other nested call.

#### Scenario: MCP tool surface is derived from the registry
- **WHEN** an MCP tool definition is generated for an allowlisted function
- **THEN** its name, description, and input schema SHALL be derived from that function's stored OpenAPI specification (see `service-registry`) rather than maintained separately

#### Scenario: MCP tool surface is scoped per invocation
- **WHEN** two different invocations of the same open-target nesting service declare different allowlists
- **THEN** each invocation SHALL see only the MCP tools corresponding to its own allowlist, never the full registry

#### Scenario: MCP-dispatched calls receive the same guarantees as any other nested call
- **WHEN** an MCP tool call is dispatched on behalf of a nesting service
- **THEN** it SHALL be tracked, retried, secret-scoped, and governor-accounted the same as a call dispatched via any other transport
