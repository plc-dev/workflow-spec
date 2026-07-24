## ADDED Requirements

### Requirement: Secrets referenced by name and scope, never inlined
The DSL SHALL allow a step to declare the secrets it needs by name and scope (workflow-writer or user), and SHALL NOT permit the concrete secret value to be embedded in the workflow-spec.

#### Scenario: Workflow-spec references a writer-scoped secret
- **WHEN** a workflow-writer authors a step needing an external API key they own
- **THEN** the workflow-spec SHALL record only a scope + reference name, and the value SHALL be resolved at runtime from the secrets broker

#### Scenario: Attempt to inline a secret value
- **WHEN** a workflow-spec embeds a literal secret value instead of a reference
- **THEN** the system SHALL reject the workflow-spec

### Requirement: Secret scope and isolation boundary
The system SHALL support two secret scopes with distinct isolation boundaries: workflow-writer-scoped (shared across all runs of that workflow-spec, bounded by the workflow-spec/writer identity) and user-scoped (bounded by the session).

#### Scenario: Writer secret shared across sessions of the same workflow
- **WHEN** two different sessions run the same workflow-spec that uses a writer-scoped secret
- **THEN** both SHALL resolve the same writer-owned secret without it being treated as a cross-session leak

#### Scenario: Writer secret not exposed across different workflows
- **WHEN** a pooled container serves a step of workflow A (writer X) and later a step of workflow B (writer Y)
- **THEN** workflow B's step SHALL NOT observe workflow A's writer-scoped secret

### Requirement: Per-request secret injection, never environment variables
The system SHALL inject secrets into a service invocation per-request and SHALL NOT bind secrets to a container's lifetime via environment variables.

#### Scenario: Pooled container reused across invocations
- **WHEN** a pooled container that received a secret for one invocation is reused for a subsequent invocation
- **THEN** the subsequent invocation SHALL only receive the secrets injected for its own request, with no residue from the prior invocation

### Requirement: Secrets resolved inside the step's execution, only references in history
The system SHALL resolve concrete secret values inside the worker/step execution that performs the invocation, and SHALL persist only secret references (never raw secret values) in the durable execution history.

#### Scenario: Durable history contains no raw secrets
- **WHEN** a step that consumes a secret is recorded in the execution history
- **THEN** the recorded inputs/outputs SHALL contain only a secret reference and SHALL NOT contain the resolved secret value

### Requirement: User-secret lifetime bound to the session
The system SHALL store user-provided secrets under a session-scoped entry with a TTL matching the session, and SHALL resolve them by reference so that session rehydration/replay within the TTL continues to work.

#### Scenario: Session rehydrated after snapshot GC
- **WHEN** a session is rehydrated from its input history and a step needs the user-provided secret
- **THEN** the secret reference SHALL re-resolve from the broker while within the session TTL

#### Scenario: Session ends
- **WHEN** a session ends or its TTL elapses
- **THEN** the associated user-scoped secrets SHALL be collected

### Requirement: Secret-consuming external calls are not memoized
The system SHALL treat calls that use a secret to reach an external service as non-deterministic side effects and SHALL exclude them from the operation memoization cache.

#### Scenario: External secret-consuming call repeated
- **WHEN** a step that uses a secret to call an external service runs again with the same declared inputs
- **THEN** the system SHALL re-execute the call rather than returning a memoized result, and the secret SHALL NOT form part of any content hash
