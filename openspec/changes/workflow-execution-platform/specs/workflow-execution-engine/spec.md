## ADDED Requirements

### Requirement: Distributed, multi-machine workflow execution
The system SHALL execute instantiated workflows across multiple machines/workers, load-balancing steps across available workers rather than requiring all steps of a workflow instance to run on a single machine.

#### Scenario: Workflow steps distributed across workers
- **WHEN** a workflow instance with multiple independent steps is executed
- **THEN** those steps MAY be scheduled onto different worker machines and executed in parallel where the workflow-spec's dependency graph allows it

### Requirement: Support both spawned and warm-service step execution
The engine SHALL support invoking a step either by spawning a fresh, isolated execution unit (for stateless, per-call services) or by calling a long-lived, pooled warm service instance (for setup-heavy services), as determined by the scheduler's placement decision, within a single workflow-spec.

#### Scenario: Mixed workflow with both execution shapes
- **WHEN** a workflow-spec includes one step classified for spawn-per-call execution and another step classified for warm-pooled execution
- **THEN** the engine SHALL execute each step using its assigned execution shape without requiring the workflow-writer to specify the mechanism

### Requirement: Long-lived sessions modeled as durable, signal-driven executions
The engine SHALL support a session as a single long-lived execution context that persists across multiple, separately-triggered user actions over an extended period (hours to days), rather than requiring each user action to be modeled as a fully independent workflow run disconnected from prior actions in the same session.

#### Scenario: Session receives a user action after a delay
- **WHEN** a user issues a new action against an existing session after a multi-hour gap
- **THEN** the engine SHALL route that action into the same session's ongoing execution context, preserving session identity and history

### Requirement: Durable execution and resumability
The engine SHALL persist enough execution state that a workflow or session in progress can resume correctly after a worker or engine-node failure, without losing progress already made or duplicating already-completed side-effecting steps.

#### Scenario: Worker crash mid-workflow
- **WHEN** the worker executing a step crashes after the step's side effect has been recorded as complete but before the workflow has advanced
- **THEN** the engine SHALL resume the workflow from its last durably recorded point without re-executing the completed step

### Requirement: Native retries, backoff, and timeouts
The engine SHALL provide built-in support for retrying a failed step according to a configurable backoff policy, and for enforcing per-step timeouts, without requiring the workflow-writer to implement retry logic manually.

#### Scenario: Transient failure retried automatically
- **WHEN** a step invocation fails with a transient error
- **THEN** the engine SHALL retry the step according to its configured backoff policy up to a configured retry limit before surfacing a failure

#### Scenario: Step exceeds timeout
- **WHEN** a step's execution exceeds its configured timeout
- **THEN** the engine SHALL treat the step as failed and apply the configured retry/backoff policy

### Requirement: Step-level memoization skip
The engine SHALL allow a step to be skipped, reusing a previously computed result, when the step's declared inputs match an entry already present in the cross-session operation memoization cache.

#### Scenario: Repeated identical step skipped
- **WHEN** a step's resolved (base, operation) inputs match a cached memoization entry from a prior execution
- **THEN** the engine SHALL reuse the cached output rather than re-invoking the underlying service

### Requirement: Dynamic child executions without terminating the parent
The engine SHALL support starting one or more dynamically-determined child executions from within a running workflow (e.g. to satisfy a map/forEach construct), without requiring the parent execution to terminate, and SHALL track each child execution durably and independently.

#### Scenario: Parent continues after starting children
- **WHEN** a running workflow starts multiple child executions to satisfy a map construct over a runtime-sized collection
- **THEN** the parent workflow SHALL remain running and SHALL be able to await or continue past the children according to the workflow-spec's declared behavior

#### Scenario: Independent failure and retry of a child execution
- **WHEN** one dynamically-started child execution fails while sibling child executions have already completed
- **THEN** the engine SHALL retry only the failed child execution and SHALL NOT require the parent or sibling executions to restart
