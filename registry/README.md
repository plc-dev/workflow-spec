# service-registry

A first-party **metadata index** over service images - the single
most-depended-on component in the workflow-execution-platform design
(design.md **D12**). It owns facts *about* an image, keyed by that image's
digest; it does **not** own the image bytes (those live in a standard OCI
registry, referenced only by an `oci_ref` pointer string).

This is the first real (non-spike) product component in the repo. It follows
the Postgres-native conventions established in
`spikes/1.2-resonate-pg-durable-exec` (Node.js + `pg`, a dedicated schema,
small focused modules), per the engine decision in D6/D6a.

## What it implements

- **D12** - the registry as a metadata index, not a byte store: per-digest
  entry with `openapi_spec` as the sole stored contract, an `oci_ref`
  pointer, per-image hardware requirements (outside the trust model),
  per-function nesting declarations, and a trust tier. Reads split by
  consistency need; writes split by privilege.
- **D5** - per-function capability metadata (`mutates`,
  `materializationCostClass`, `cowSupport`, `changeDetectionSupport`) lives
  here, in the registry, not in the DSL.
- **D5a** - capability declarations earn scheduler trust via a per-digest
  trust tier (`unverified` -> `conformance-passed` -> `production-proven`),
  defaulting to `unverified`.

## Layout

| File | Purpose |
|------|---------|
| `schema.sql` | Postgres `registry` schema: `service_images` (per-image) + `function_capabilities` (per-function). |
| `src/db.js` | Connection pool + schema reset helper. |
| `src/admin.js` | **Platform-developer-only** write path - exports only `registerImage(...)`. |
| `src/conformance.js` | **Workflow-platform** write path - exports only `recordTrustTier(digest, tier)`. |
| `src/query.js` | Read paths: `getPlacementFacts(digest, fn)` (atomic dispatch-time read) and `getEntry(digest)` (authoring-time read). |
| `src/validate.js` | Schema-level validation incl. the OpenAPI-vs-capability referential check. |
| `test.js` | Full test suite against a real Postgres instance. |
| `NOTES.md` | Implementation notes + deferred-task rationale. |

### The privilege split (D12) is structural

`registerImage` (create an image entry) and `recordTrustTier` (annotate trust
on an existing one) live in **separate modules with disjoint exports**, not a
single `update()` behind a runtime permission flag. A hypothetical
runtime-facing module has nothing to import that would let it introduce a new
image - the module boundary *is* the privilege boundary. No real auth is
built (there is no RBAC system in this repo yet); the split is modeled in
code structure and documented intent.

## Running it / its tests

Requires Docker. `npm test` is fully self-contained - it starts a throwaway
Postgres container on port `55444` (via `../scripts/with-postgres.sh`),
waits for it to actually be ready, applies `schema.sql`, runs `test.js`,
and tears the container down afterward, whether the suite passes or fails:

```bash
npm install
npm test
```

This is enforcement, not graceful degradation: if Docker isn't available,
or the container never becomes ready, the script exits non-zero with a
clear error - it never silently skips the database-dependent tests. See
`scripts/with-postgres.sh` at the repo root for the shared lifecycle logic
(the same wrapper is used by `placement-resolver/`, `spikes/1.8-map-foreach/`,
and `spikes/1.2-resonate-pg-durable-exec/`).

If you want to poke at the database interactively instead of via `npm
test`, start it manually with the same parameters:
`bash ../scripts/with-postgres.sh --name registry-dev-pg --port 55444 --db registry --password registry --schema schema.sql -- sleep infinity`
(then `Ctrl+C` to tear it down), or just `docker run --rm --name registry-pg -e POSTGRES_PASSWORD=registry -e POSTGRES_DB=registry -p 55444:5432 postgres:16-bookworm` followed by `docker exec -i registry-pg psql -U postgres -d registry < schema.sql`.

The suite demonstrates: `registerImage` succeeds and defaults `trust_tier` to
`unverified`; `recordTrustTier` transitions it; `getPlacementFacts` returns
capability metadata, trust tier, and hardware requirements together
atomically; and `validate.js` rejects malformed entries (capability metadata
naming a function absent from the OpenAPI spec, an invalid
`materializationCostClass`, and a malformed nesting declaration).
