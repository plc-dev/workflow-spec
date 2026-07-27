# Plan: Naive Service CLI Contract (D17b)

## Overview

Split D17/D17a's universal `--data-file <path> --state-id <key>` mandate into three layers, allowing services to remain naive about platform internals while preserving all heavy-data transport properties.

**Current state**: Every service must accept `--data-file` and `--state-id`, requiring knowledge of content hashing and state reuse lifecycle.

**Target state**: Services only declare their native CLI signature (how they accept file paths); platform handles materialization universally; state reuse is an opt-in capability.

## Scope

### In scope
- Design documentation (D17b in design.md)
- ADR updates (0005, 0008)
- Registry schema and code changes
- Worker dispatch code changes
- Agent code changes (execrunner)
- Tasks.md updates
- Implementation plan updates (0010, 0011)
- Cross-reference consistency

### Out of scope
- Actual implementation of dataset catalog (5.6d)
- Actual implementation of promote/demote lifecycle (4.8)
- Conformance probing for the new fields (tasks 2.4/2.6/2.7)
- Changes to the reference SQL service (still REST-only, not onboardable)

## Implementation phases

### Phase 1: Design documentation

**1.1 Add D17b to `openspec/changes/workflow-execution-platform/design.md`**

Location: After D17a (line ~1237)

Content:
- Supersedes D17's *shape* mandate (not D17a's scope widening)
- Three-layer model:
  - **Layer 1**: Universal materialization to local path (invisible to service) - unchanged from D17
  - **Layer 2**: Per-function invocation descriptor (derived from D12's OpenAPI contract) - how to pass the path (flag name, positional index, stdin)
  - **Layer 3**: Per-function capability (D5-style, opt-in) - `stateReuse: none | stateIdKeyed`, `additiveWarmUpdate: bool`
- Rationale: D17's "universal mandated shape" argument is sound for materialization but over-applies to argv rendering and state reuse; splitting restores "naive services" while keeping every property ADR-0005/0008 were protecting
- Consequences:
  - Stdin becomes usable for non-state-reusing functions (piped by agent from materialized path, not carried as bytes in RPC - preserves D6/R3)
  - A lying capability flag costs performance, not correctness (platform may always decline the optimization)
  - Combined with D5a trust tiers, no new trust machinery needed
- Alternatives considered: Keep D17's one-shape simplicity (rejected - onboarding cost for naive third-party services is the real bite D17 anticipated)

**1.2 Update ADR-0005 (`docs/adr/0005-step-dispatch-is-cli-nesting-stays-flexible.md`)**

Location: Consequence #4 (line ~52)

Change: Revise to state that *transport* (CLI + exec-agent + local filesystem) stays universal, but *argv rendering* and *state-reuse claims* are per-function declared. Update the "two parallel materialization strategies" rejection rationale to clarify it was about REST-warm vs CLI-warm, not about argv syntax variation.

**1.3 Update ADR-0008 (`docs/adr/0008-in-pod-exec-agent.md`)**

Location: `InvokeRequest` contract (line ~40) and "Interaction with D17" section (line ~140)

Changes:
- `dataFiles[].stateId` becomes optional
- Add `dataFiles[].stdinFromPath?: boolean` variant (agent pipes path to subprocess stdin, never carries bytes in RPC)
- `Evict(stateId)` narrows to only functions declaring `stateReuse: stateIdKeyed`
- Update "The agent stays deliberately dumb about state-ids" to clarify the agent is also dumb about invocation descriptors (it just renders what the worker tells it)

### Phase 2: Registry schema and code

**2.1 Update registry schema (`src/registry/database/schema.sql`)**

Replace the existing `function_capabilities` table with a new schema that requires the new fields:

```sql
CREATE TABLE IF NOT EXISTS function_capabilities (
    digest                     TEXT NOT NULL
                                 REFERENCES service_images(digest)
                                 ON DELETE CASCADE,
    function_name              TEXT NOT NULL,
    mutates                    BOOLEAN NOT NULL,
    materialization_cost_class TEXT NOT NULL
                                 CHECK (materialization_cost_class IN (
                                     'negligible',
                                     'heavy'
                                 )),
    cow_support                BOOLEAN NOT NULL,
    change_detection_support   BOOLEAN NOT NULL,
    -- Shape: { "via": "sdk"|"http"|"cli"|"mcp", "targets": [...] | "open" }
    -- NULL means the function declares no nesting at all.
    nesting_declaration        JSONB,
    -- Layer 2: How to invoke this function's CLI (derived from OpenAPI contract)
    -- Shape: [ { "param": "schemaFile", "style": "flag"|"positional"|"stdin", "flagName"?: "--sql-file", "positionIndex"?: 0 } ]
    -- Empty array [] means the function accepts no heavy bindings (light-only).
    invocation_descriptor      JSONB NOT NULL DEFAULT '[]',
    -- Layer 3: State reuse capability (D5-style, opt-in)
    -- 'none' = no state reuse (conservative default)
    -- 'stateIdKeyed' = may persist state keyed by state-id and reuse across execs
    state_reuse                TEXT NOT NULL DEFAULT 'none'
                               CHECK (state_reuse IN ('none', 'stateIdKeyed')),

    -- Layer 3: Additive warm update capability (only meaningful if state_reuse = 'stateIdKeyed')
    -- true = can accept incremental updates to existing state without full re-materialization
    -- false = must re-materialize from scratch on any change
    additive_warm_update       BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (digest, function_name)
);
```

Migration strategy: Drop and recreate the table (no backward compatibility). Existing registrations must be re-registered with the new fields.

**2.2 Update registry admin code (`src/registry/admin.ts`)**

- `registerImage` requires `invocationDescriptor` and `stateReuse` per function (no defaults, no fallback)
- Validation: `invocationDescriptor` must be a valid array (empty for light-only functions)
- Validation: if `stateReuse: stateIdKeyed`, then `invocationDescriptor` must contain at least one heavy binding entry
- Validation: `additiveWarmUpdate` only meaningful if `stateReuse: stateIdKeyed` (reject otherwise)
- Validation: each invocation descriptor entry must have either `flagName` (if style is "flag") or `positionIndex` (if style is "positional")

**2.3 Update registry read paths**

- `getPlacementFacts` returns the new fields (needed by worker dispatch to build the correct InvokeRequest)
- `getEntry` returns the new fields (needed by DSL compiler for validation)

**2.4 Update registry tests**

- Add tests for the new schema columns
- Add tests for the validation rules
- Add tests for the read paths returning the new fields

### Phase 3: Worker dispatch code

**3.1 Update `src/apps/worker/agent-client.ts`**

- `AgentDataFile` interface: `stateId` becomes optional, add `stdinFromPath?: boolean`

```ts
export interface AgentDataFile {
  flag?: string;           // optional if stdinFromPath
  path: string;
  stateId?: string;        // optional, only for stateIdKeyed functions
  stdinFromPath?: boolean; // agent pipes path to subprocess stdin
}
```

**3.2 Update `src/apps/worker/dispatch.ts`**

- `buildInvokeRequest` requires the function's `invocationDescriptor` and `stateReuse` from the registry (no fallback to old contract)
- For each heavy binding:
  - Look up the invocation descriptor entry for that parameter
  - If `style: "flag"`, populate `dataFiles[].flag` with the declared flag name
  - If `style: "positional"`, populate `args` with the path at the declared index (no `dataFiles` entry)
  - If `style: "stdin"`, populate `dataFiles[].stdinFromPath: true` (no flag)
  - If `stateReuse: stateIdKeyed`, populate `dataFiles[].stateId` with the content hash
  - If `stateReuse: none`, omit `stateId` entirely
- Throw `FatalError` if `invocationDescriptor` is missing from the registry entry (registration validation failure)

**3.3 Update `src/apps/worker/dispatch.ts` validation**

- Validate that every heavy binding has a matching invocation descriptor entry
- Throw `FatalError` if a heavy binding is missing its descriptor (a registry/DSL compile-time validation failure that should never reach runtime)

**3.4 Update worker dispatch tests**

- Add tests for each invocation style (flag, positional, stdin)
- Add tests for stateId presence/absence based on stateReuse
- Add tests for the validation rules

### Phase 4: Agent code

**4.1 Update `agent/internal/api/types.go`**

```go
type DataFile struct {
    Flag         string `json:"flag,omitempty"`
    Path         string `json:"path"`
    StateID      string `json:"stateId,omitempty"`
    StdinFromPath bool  `json:"stdinFromPath,omitempty"`
}
```

**4.2 Update `agent/internal/execrunner/execrunner.go`**

- For each `DataFile` in the request:
  - If `StdinFromPath: true`, pipe the file contents to subprocess stdin (not the path itself)
  - If `Flag` is present, append `--<flag> <path>` to argv
  - If neither, this is a positional argument (handled by the worker's args translation, not the agent)
- `StateID` is now informational only (the agent doesn't use it for anything - it's passed through for logging/metrics if needed, but the agent doesn't track state)

**4.3 Update `agent/internal/server/evict.go`**

- `Evict(stateId)` is now only called for functions declaring `stateReuse: stateIdKeyed`
- The agent's local dedup store doesn't need to change (it's keyed on `(executionId, stepId)`, not state-id)

**4.4 Update agent tests**

- Add tests for `StdinFromPath` (pipe file contents to stdin)
- Add tests for `Flag` omission (positional arguments)
- Add tests for `StateID` omission (non-state-reusing functions)

### Phase 5: Tasks and implementation plans

**5.1 Update `openspec/changes/workflow-execution-platform/tasks.md`**

- Task 2.12: Narrow scope to "extend the registry's onboarding requirements with the per-function invocation descriptor and state-reuse capability"
- Task 4.8: Narrow scope to "implement CLI heavy-data transport volume/local-state attach-on-promote, detach-on-demote for functions declaring `stateReuse: stateIdKeyed`"
- Task 6.4: Update to reflect that `--data-file` omission is only for stateIdKeyed functions on warm hits
- Add a new task (or note in 2.12) about conformance probing for the new fields

**5.2 Update `docs/impl-plans/0010-exec-agent.md`**

- Update the `InvokeRequest` contract sketch to match the new shape
- Update the "Interaction with D17" section to reference D17b
- Update the execrunner description to handle `StdinFromPath` and optional `Flag`
- Update the Evict description to clarify it's only for stateIdKeyed functions

**5.3 Update `docs/impl-plans/0011-worker-cli-dispatch.md`**

- Update the "Args translation" section to describe the new invocation descriptor logic
- Update the wire types to match the new `AgentDataFile` shape (stateId optional, stdinFromPath added)
- Update the "dataFiles" scope note to reflect that heavy bindings are now in scope (pending 5.6d)
- Add a new section on "Invocation descriptor rendering" describing the flag/positional/stdin logic
- Remove any references to backward compatibility or fallback to the old contract

### Phase 6: Cross-reference consistency

**6.1 Verify all D17/D17a references**

- Search for all mentions of `--data-file`/`--state-id` in design docs, ADRs, tasks, impl plans
- Ensure each reference is updated to reflect D17b's three-layer model
- Add cross-references to D17b where appropriate

**6.2 Verify all `dataFiles` references in code**

- Search for all uses of `dataFiles` in TypeScript and Go code
- Ensure each use is updated to handle the new optional fields
- Add comments referencing D17b where appropriate

**6.3 Update proposal.md**

- Add a note in the proposal's "Superseded in scope by D17a" section that D17b further refines the scope
- Update the "resolved" language to reflect that the onboarding gap is now smaller (services need a CLI with their native signature, not the platform's mandated contract)

## Testing strategy

- **Registry tests**: Schema validation, required fields, invocation descriptor structure, state_reuse constraints
- **Worker dispatch tests**: Invocation descriptor rendering (flag/positional/stdin), stateId presence/absence based on stateReuse, validation errors for missing descriptors
- **Agent tests**: StdinFromPath piping, Flag omission for positional arguments, StateID omission for non-state-reusing functions
- **Integration tests**: End-to-end dispatch with a fake CLI that accepts different invocation styles
- **Validation tests**: Reject registrations with missing invocationDescriptor, reject stateIdKeyed without heavy bindings, reject additiveWarmUpdate without stateIdKeyed

## Migration path

- Schema migration: Drop and recreate `function_capabilities` table with new required fields
- Existing registrations: Must be re-registered with `invocationDescriptor` and `stateReuse` fields
- No gradual migration, no fallback to old contract
- Worker dispatch: Requires `invocationDescriptor` in registry entry, throws `FatalError` if missing
- Agent: Requires updated wire types, no support for old contract

## Risks and mitigations

- **Risk**: Breaking existing registered functions
  - **Mitigation**: This is intentional - the old contract required services to know platform internals. Re-registration with the new fields is required.
- **Risk**: Inconsistent invocation descriptors across functions
  - **Mitigation**: DSL compile-time validation that every heavy binding has a matching descriptor
- **Risk**: Lying capability flags (claiming stateIdKeyed when not)
  - **Mitigation**: D5a trust tiers (only production-proven digests get the optimization); conformance probing (future work, tasks 2.4/2.6/2.7)

## Success criteria

- All design docs, ADRs, tasks, and impl plans are consistent with D17b
- Registry schema supports the new fields
- Worker dispatch renders invocation descriptors correctly
- Agent handles all invocation styles (flag, positional, stdin)
- All tests pass

## Estimated effort

- Phase 1 (Design docs): 2-3 hours
- Phase 2 (Registry): 3-4 hours
- Phase 3 (Worker dispatch): 2-3 hours
- Phase 4 (Agent): 2-3 hours
- Phase 5 (Tasks/impl plans): 1-2 hours
- Phase 6 (Cross-references): 1-2 hours
- **Total**: 11-17 hours

## Dependencies

- No external dependencies
- All changes are internal to this repository
- No changes to the reference SQL service (still REST-only, not onboardable)

## Rollback plan

- Schema migration is a clean break (drop and recreate table)
- Code changes are a clean override (no fallback to old contract)
- Design doc changes are a clean override (D17b supersedes D17's shape mandate)
- Existing registrations must be re-registered with the new fields
- No backward compatibility, no gradual migration
