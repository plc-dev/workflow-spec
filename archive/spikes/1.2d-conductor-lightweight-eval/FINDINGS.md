# Spike 1.2d — LIGHTWEIGHT EVALUATION: Conductor (Orkes)

**Task**: tasks.md 1.2d. How directly Conductor's native MCP gateway
(Agentspan) and declarative workflow format could serve D9c (agent-directed
composition) and the IR-to-engine compilation step (5.10), before
committing to a full spike (path e, design.md D6). Desk research only, per
the task's explicit lightweight scoping - no build-out.

## What was done

Architecture research against Conductor OSS/Orkes documentation
(conductor-oss.github.io MCP guide, orkes.io developer guides for the MCP
Gateway/tasks/workflows/Switch/Dynamic Fork/Dynamic task, and the
`agentspan-ai/agentspan` GitHub repo/SDK examples) - no build-out, per the
lightweight-evaluation scoping.

## Findings

### 1. MCP fit for D9c (bounded agent-directed composition)

Conductor ships **two distinct, complementary MCP capabilities**, both as
native system tasks/features requiring no custom worker code:

- **Consuming external MCP tools**: `LIST_MCP_TOOLS` (runtime tool
  discovery from an MCP server) and `CALL_MCP_TOOL` (invoke a specific
  tool) - both get durable execution for free (retry policy, full audit
  trail of method/arguments/response/timing, crash recovery resuming from
  the last completed step, and a configurable `responseTimeoutSeconds`).
  This directly matches D9c's requirement that agent-directed tool calls
  be durable/resumable across a multi-round loop.
- **Exposing our own workflows as MCP tools**: the **MCP Gateway** maps
  named "routes" to workflows, with a JSON Schema attached per route to
  validate incoming tool-call requests, and authentication settings
  controlling which external callers may invoke which routes.

**Mapping onto D9c's specific mechanisms**:

- **Allowlist enforcement (10.5)**: partially native. MCP Gateway routes +
  authentication settings *do* function as an allowlist at the
  workflow-exposure granularity (only workflows explicitly published as
  routes are callable via MCP) - but this is coarser than D9c's model,
  which needs a per-invocation allowlist of *specific nested targets*
  supplied as an ordinary DSL binding, not a static, deploy-time set of
  exposed routes. Conductor's allowlist answers "which workflows can be
  called via MCP at all," not "which specific targets can *this particular
  running instance* call, as decided by this invocation's own binding
  data." The finer-grained, per-invocation enforcement D9c/10.5 needs would
  still have to be built on top of (not replaced by) Conductor's route-level
  gating - same conclusion as every other engine candidate evaluated so
  far, not a Conductor-specific gap.
- **Durable governor counter (10.6)**: no native match found. Conductor's
  closest built-in primitives are per-task-definition `retryCount`,
  `rateLimitPerFrequency`/`rateLimitFrequencyInSeconds`, and
  `responseTimeoutSeconds` - these are global/per-task-type policies, not a
  durable, per-invocation count/cost/timeout counter checked before each
  dispatch and surviving crash-and-resume as D9c/10.6 specifies. This
  would need to be hand-built (e.g. as workflow variables incremented via
  `SET_VARIABLE` and checked via `SWITCH`/`terminate` before each MCP call)
  regardless of which candidate engine is eventually chosen - a neutral
  finding, not a point against Conductor specifically.
- **MCP transport realization (D9b/service-nesting)**: strong native fit.
  Both directions (agent-runner service calling out via MCP, and our own
  workflows being called in via MCP) are first-class, which is
  differentiated versus every other candidate evaluated in design.md D6 -
  none of Temporal/Restate/Dapr/Hatchet ship an equivalent native MCP
  gateway; this reconfirms, rather than merely repeats, D6's existing "R12:
  Strongest - native MCP gateway built in" rating.
- **Agentspan** (the specific product design.md D6 named) turns out to be a
  **separate, newer Python SDK layer** ("Built by the team at Orkes," a
  distinct GitHub org/package) that compiles higher-level agent
  definitions (with decorators for tool-approval pauses, `>>` pipeline
  composition) down into the same underlying Conductor MCP/LLM system
  tasks described above - it is not a different engine capability, it's a
  more ergonomic authoring layer over capabilities that are already native
  to Conductor itself (`LIST_MCP_TOOLS`/`CALL_MCP_TOOL`/MCP Gateway/
  `LLM_CHAT_COMPLETE`). Worth flagging as a maturity/scope distinction:
  the durable, crash-resumable MCP/LLM primitives are core-product
  features; Agentspan specifically is a newer, thinner convenience layer
  on top, with its own separate adoption-maturity question if it were used
  directly rather than authoring against Conductor's system tasks.

### 2. Declarative format fit for D8/D8c and the IR-to-engine compilation step (5.10)

Conductor's JSON workflow-definition format maps onto our own IR constructs
more directly than any other candidate evaluated so far, confirming
design.md D6's "potentially the lowest-effort IR-to-engine compilation
target" hypothesis with concrete structural evidence:

- **`branch` (D8/D8c) <-> `SWITCH` task**: an unusually close match.
  `SWITCH`'s `decisionCases` (a map of case values to task lists) plus
  `defaultCase` is structurally the same shape as D8c's "statically
  enumerated cases, dynamically selected" - and `SWITCH` even emits
  `selectedCase` as output, matching D8c's own `yields`-style
  case-selection reporting. Compiling our `branch` IR node to a `SWITCH`
  task configuration looks close to mechanical.
- **`map`/`forEach` (D8/D8c) <-> `FORK_JOIN_DYNAMIC` (single-task-name
  variant)**: also a close match. The `forkTaskName` + `forkTaskInputs`
  form of `FORK_JOIN_DYNAMIC` runs the *same* task shape once per element
  of a runtime-sized input array - exactly D8c's "statically shaped body,
  dynamically sized cardinality." (Conductor also supports a
  *different-task-per-fork* variant via `dynamicForkTasksParam` /
  `dynamicForkTasksInputParamName`, which is more general than our `map`
  needs - we'd only ever compile to the single-task-name form, and should
  explicitly not reach for the heavier variant, to keep the compiled output
  matching our own "body shape stays static" invariant rather than
  Conductor's more permissive one.)
- **`SUB_WORKFLOW` / `DYNAMIC` task <-> workflow-spec-store fork semantics: a real mismatch, but not a blocker.** Conductor's native way to
  compose one workflow from another is `SUB_WORKFLOW`, which calls a
  *versioned, named, live-referenced* workflow definition already
  registered on the server - the opposite of what proposal.md /
  design.md D13 already decided for our own workflow-spec store (reuse by
  **fork**: copy the source's shape/steps into the forker's own namespace
  at authoring time, never a live run-time reference). This means 5.10's
  IR-to-Conductor compilation, if Conductor is selected, would need to
  **inline/expand** a forked workflow-spec's steps directly into the
  compiled output rather than emitting a `SUB_WORKFLOW` reference to the
  original - which is exactly what our own fork model already requires
  regardless of engine (the fork is supposed to be self-contained), so
  this is a confirmation that Conductor's native composition primitive
  should simply not be used for *our* notion of workflow reuse, not a
  capability gap that blocks anything.
- **Derived workflow-signature generation (5.9) <-> Conductor's
  `inputParameters`/MCP route schema: two separate mechanisms, not one.**
  Conductor workflow definitions carry a flat `inputParameters` list (names
  only, no types) plus separately-authored `outputParameters` expressions;
  the MCP Gateway additionally wants its *own*, separately-authored JSON
  Schema per route for request validation. D8's requirement - "every
  workflow-spec has a derivable signature," walked directly from the IR -
  is not something Conductor derives natively; 5.9/5.10 would need to
  generate *both* Conductor artifacts (the `inputParameters` list and the
  MCP route's JSON Schema) from our own already-derived signature as two
  compile outputs, rather than relying on Conductor to compute either from
  the workflow shape itself. A real compilation-target detail worth noting
  in 5.9/5.10's eventual implementation, not a new open question.
- **LLM task support**: `LLM_CHAT_COMPLETE` and related native LLM
  provider task types (14+, per design.md's existing note) further
  reinforce agent-composition fit, consistent with D6's existing rating.

## Verdict

**No new differentiator changes design.md D6's existing rating for
Conductor** (Strongest on R12/native MCP gateway; potentially lowest-effort
IR-to-engine compilation target) - this evaluation *substantiates* those
claims with concrete structural evidence (SWITCH/branch and
FORK_JOIN_DYNAMIC/map are genuinely close matches) rather than overturning
them. It surfaces three **compilation-detail refinements** worth folding
into 5.9/5.10 whenever Conductor is seriously considered as a compile
target, none of which are blockers or new open questions:

1. 5.10 should compile `branch` -> `SWITCH` and `map`/`forEach` -> the
   single-task-name form of `FORK_JOIN_DYNAMIC` specifically (not the
   different-task-per-fork form, which is more permissive than our IR's
   static-shape invariant).
2. 5.10 must **inline/expand** forked workflow-specs rather than emit
   `SUB_WORKFLOW` references, since Conductor's native sub-workflow
   primitive is a live reference and our fork model is explicitly not.
3. 5.9's derived-signature generation would need to target two separate
   Conductor artifacts (`inputParameters` list + a generated MCP-route JSON
   Schema), not one.

D9c's allowlist (10.5) and durable governor counter (10.6) both still need
custom logic on top of Conductor's primitives, same conclusion as every
other candidate engine evaluated in design.md D6 - a neutral finding, not
a Conductor-specific weakness. This closes out 1.2d without further spike
effort, per its lightweight posture.
