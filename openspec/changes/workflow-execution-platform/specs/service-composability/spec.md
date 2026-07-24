## ADDED Requirements

### Requirement: A workflow-spec may be published as a composite registry entry
The registry SHALL allow a workflow-spec's derived signature (per the `workflow-dsl` capability) to be published as an invocable registry entry alongside leaf (raw-container) services, discoverable and callable the same way.

#### Scenario: A workflow-spec is invoked as a step by another workflow
- **WHEN** a workflow-writer references a published composite registry entry as a step in a different workflow-spec
- **THEN** the system SHALL validate and invoke it the same way it would a leaf service function

#### Scenario: A composite's internal steps remain fully governed by the platform
- **WHEN** a composite registry entry executes as a tracked child execution
- **THEN** every one of its own internal steps SHALL be resolved through the same scheduler, capability, and secret-scoping rules (D2-D5, D7) as any top-level workflow, since a composite's internals are ordinary IR, never opaque

### Requirement: Inter-service composition defaults to an orchestrator-aware path
Where a service's own implementation needs to call other registered services (rather than being called as a composite per the previous requirement), the system SHALL require this composition to go through an orchestrator-aware path by default, preserving retry, secret-scoping, and placement guarantees for each inner call.

#### Scenario: Default composition preserves guarantees
- **WHEN** a service composes another registered service without declaring an exception
- **THEN** each inner call SHALL be tracked, retried, and secret-scoped the same as any top-level step invocation

#### Scenario: Silent direct calls are not a supported default
- **WHEN** a service's capability declaration does not declare a guarantees-forfeited exception
- **THEN** the system SHALL NOT treat a raw, untracked HTTP/CLI call from that service to another registered service as a supported composition path

### Requirement: Bypassing the orchestrator-aware path requires an explicit, declared exception
The registry SHALL require any service that composes other registered services outside the orchestrator-aware path to declare this explicitly via capability metadata, naming the transport and the forfeited guarantees, and SHALL treat this declaration as subject to the same trust-tier review as other capability claims.

#### Scenario: Declared exception is visible and reviewable
- **WHEN** a service declares a guarantees-forfeited composition exception
- **THEN** the declaration SHALL record the transport used (e.g. http, cli) and SHALL be visible to registry-side review, not merely trusted on assertion

#### Scenario: Undeclared bypass is a capability-declaration violation
- **WHEN** a service is found to compose another registered service outside the orchestrator-aware path without having declared the exception
- **THEN** the system SHALL treat this the same as any other false capability declaration (see the trust-tier and runtime invariant-check requirements in `execution-scheduling`)

### Requirement: A composing service's target set may be enumerable or open
A composing service's capability declaration SHALL specify whether the set of services it may reach is statically enumerable (`targets` lists specific services/functions) or open (determined per-invocation by an external decision process, e.g. an agent), and SHALL specify the transport (e.g. sdk, mcp, http, cli).

#### Scenario: Enumerable target set
- **WHEN** a composing service declares a specific, fixed list of target services/functions
- **THEN** the system SHALL treat that list as the complete set the service may ever reach

#### Scenario: Open target set is bounded per invocation, not by the declaration alone
- **WHEN** a composing service declares an open target set (e.g. an agent-runner service using MCP)
- **THEN** the actual set of services reachable in a given invocation SHALL be bounded by the allowlist parameter supplied to that specific invocation, not by an unbounded default

### Requirement: Allowlist enforcement happens at dispatch time in the composability layer, not by trusting the composing service
For a composing service with an open target set, the system SHALL enforce the per-invocation allowlist at the point of dispatching each inner call, refusing calls outside the allowlist and withholding any secret scoped to a refused target, regardless of what the composing service's own code attempts.

#### Scenario: Call outside the allowlist is refused at dispatch
- **WHEN** a composing service with an open target set attempts to invoke a service not present in the allowlist supplied for that invocation
- **THEN** the composability layer SHALL refuse the call and SHALL NOT resolve any secret scoped to that service, independent of the composing service's own behavior

### Requirement: A durable governor bounds an open-target composing service's call sequence
Where a composing service's target set is open, its invocation SHALL be bounded by a governor (e.g. maximum call count, cost budget, or timeout) whose accumulated state is durable and checked before dispatching each call, such that a crash and resume does not reset progress toward the limit.

#### Scenario: Governor state survives a crash mid-loop
- **WHEN** a composing service with an open target set crashes after several inner calls and is resumed
- **THEN** the resumed execution SHALL continue from the durably-tracked count/cost already accumulated, not from zero

#### Scenario: Governor limit reached stops further dispatch
- **WHEN** an open-target composing service's accumulated count, cost, or elapsed time reaches its declared governor limit
- **THEN** the composability layer SHALL stop dispatching further inner calls for that invocation

### Requirement: Pure computed bindings are exempt from allowlist requirements
A computed binding (per the `workflow-dsl` capability's bounded logic expression) SHALL NOT require allowlist declaration or enforcement, since it cannot invoke a service, access a secret, or produce a side effect by construction.

#### Scenario: Compute-only tool is always reachable
- **WHEN** an open-target composing service's invocation offers a purely computed transform as an available tool
- **THEN** the system SHALL NOT require that transform to appear in the invocation's allowlist

### Requirement: MCP is one transport realization of the composability model, not a separate mechanism
Where a composing service declares `via: mcp`, the system SHALL translate its declared/allowlisted target functions into MCP tool definitions dynamically, scoped to that specific invocation's allowlist, and SHALL route every resulting tool call through the same dispatch, secret-resolution, and governor-enforcement path used for any other composed call.

#### Scenario: MCP tool surface is derived from the registry
- **WHEN** an MCP tool definition is generated for an allowlisted function
- **THEN** its name, description, and input schema SHALL be derived from that function's existing OpenAPI/registry entry rather than maintained separately

#### Scenario: MCP tool surface is scoped per invocation
- **WHEN** two different invocations of the same open-target composing service declare different allowlists
- **THEN** each invocation SHALL see only the MCP tools corresponding to its own allowlist, never the full registry

#### Scenario: MCP-dispatched calls receive the same guarantees as any other composed call
- **WHEN** an MCP tool call is dispatched on behalf of a composing service
- **THEN** it SHALL be tracked, retried, secret-scoped, and governor-accounted the same as a call dispatched via any other transport
