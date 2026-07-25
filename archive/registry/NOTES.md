# Service registry - implementation notes

First real (non-spike) product component in this repo. Establishes the
`registry/` top-level directory as a parallel convention to `spikes/`.
Postgres-native per D6/D6a, following the style of
`spikes/1.2-resonate-pg-durable-exec` (Node.js + `pg`, explicit schema,
small focused modules).

## Tasks implemented (tasks.md section 2)

| Task  | Where | Notes |
|-------|-------|-------|
| 2.1   | `schema.sql`, `admin.js` | `service_images` keyed by digest: `openapi_spec` JSONB (sole stored contract), `oci_ref` pointer string only (no OCI byte interaction). |
| 2.1a  | `schema.sql` `function_capabilities` | per-FUNCTION `mutates` / `materialization_cost_class` / `cow_support` / `change_detection_support`. Cost-class enum is D1's exact vocabulary (`negligible` \| `heavy`). |
| 2.1b  | `schema.sql` `service_images.hardware_requirements` | per-IMAGE JSONB (cpu/mem/gpu/nodeClass), a genuinely separate column-set from `trust_tier`/capabilities - never folded into trust logic (D12). |
| 2.1c  | `schema.sql` `function_capabilities.nesting_declaration` | per-FUNCTION `{ via, targets }`; records only the *possibility* of nesting, never a concrete bound target. |
| 2.2   | `validate.js` | enum + required-field checks, well-formed nesting declaration, and the referential check: capability metadata may not name a function the `openapi_spec` doesn't declare as an `operationId`. |
| 2.5   | `schema.sql` `trust_tier` CHECK + `conformance.js recordTrustTier` | tier storage + transition only; defaults every new image to `unverified`. Does NOT build the conformance probes (2.4). |
| 2.8   | `query.js getPlacementFacts` | single JOIN returning capability metadata + trust tier + hardware requirements from one MVCC snapshot - never composed from multiple round-trips. |
| 2.10  | `admin.js` (only `registerImage`) + `conformance.js` (only `recordTrustTier`) | privilege split modeled structurally as two separate modules with disjoint exports, not one gated `update()`. No real auth built. |

## Judgment calls

- **Function identity = OpenAPI `operationId`.** The referential check (2.2)
  and the per-function key both use `operationId` as the canonical function
  name, since the CLI/MCP surfaces are projected from the OpenAPI spec
  (D9c/D12) and `operationId` is the natural per-operation handle there.
- **Two tables, not one.** Per-image facts (`oci_ref`, `openapi_spec`,
  `hardware_requirements`, `trust_tier`) live in `service_images`;
  per-function facts live in `function_capabilities` with a cascading FK.
  This makes the per-image vs per-function cardinality (D12's ENTRY diagram)
  structural.
- **Hardware requirements are a plain JSONB column, deliberately adjacent to
  but never joined into the trust model.** D12 is explicit that a false
  hardware declaration is a bin-packing/OOM problem corrected by runtime
  observation (D4), not an isolation-correctness problem gated by
  conformance (D5a). Keeping it its own column enforces that separation.
- **Validation is hand-rolled, not `ajv`.** The shape is small and fixed,
  and the most valuable check (OpenAPI-vs-capability referential
  consistency) is a cross-field rule not expressible in pure JSON Schema.
  Postgres CHECK constraints provide a second, defense-in-depth enum layer.
- **`registerImage` is idempotent** (upsert + replace-function-rows) so
  re-registration and tests stay clean; it never touches `trust_tier` beyond
  the `unverified` default - trust is exclusively `conformance.js`'s domain.

## Tasks deliberately NOT attempted (and why each is correctly deferred now)

- **2.3 - Backfill capability/hardware/nesting metadata for existing service
  images.** There are no existing registered service images in this repo to
  backfill against; backfill is a data-migration exercise that only becomes
  meaningful once real images exist. The schema + `registerImage` path this
  task builds is exactly what a future backfill would drive.
- **2.4 - Define conformance checks validating declared capabilities against
  actual behavior.** Needs real running service images to probe (call twice
  with identical inputs, verify declared mutation/COW behavior). That is a
  substantially larger effort requiring live services; this task builds only
  the tier *storage/transition* it will eventually write into
  (`recordTrustTier`).
- **2.6 - Gate conformance re-checks into CI/CD on every redeploy.** Depends
  on 2.4 existing and on a real CI pipeline; it is pipeline wiring, not
  registry logic. The registry already supports it structurally (a redeploy
  is a new digest starting at `unverified`; the pipeline calls
  `recordTrustTier`).
- **2.7 - Continuous runtime invariant checker with auto-demotion.** Depends
  on real running traffic to sample shared/immutable bindings for
  cross-caller divergence. When built it is just another caller of
  `recordTrustTier` (demoting on a detected violation); no new registry
  surface is needed.
- **2.9 - Digest-pinned resolution for workflow-spec step bindings at
  authoring time.** This is a DSL-compiler concern (task 5.3): the DSL pins a
  digest when a step is authored. This registry only needs to *expose*
  digest-pinned entries, which it already does by being keyed on digest -
  `getEntry(digest)` / `getPlacementFacts(digest, fn)` are the read surface a
  compiler would resolve against. Building the DSL compiler is out of scope.
- **2.11 - Deferred re-pin/upgrade flow.** design.md D12 itself flags this as
  "a real, deferred affordance, not yet designed." Inventing it here would
  pre-empt a design decision that has not been made.
