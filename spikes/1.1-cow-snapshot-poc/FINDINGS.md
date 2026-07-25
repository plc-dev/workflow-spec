# Spike 1.1 — Confirm COW/incremental-snapshot capability for the SQL-execution service (proof of concept)

**Task**: tasks.md 1.1. Confirm, end to end, against the actual pinned service image
(`ghcr.io/htw-aladin/sql-assessment-service:sha-23e9468`, digest
`sha256:2bedcc2b92dcdf43e774622423386995ef466a74b7918310d1540e313a956861`), whether
it supports copy-on-write or incremental snapshotting - the capability
design.md D1/D2/D5 assumes a "COW-capable" service class can provide, and
which a workflow's `sql-exec`-shaped steps (D3's session materialization
scenario) would want to exploit for cheap per-session forking of a shared
base dataset.

## What was done

1. Pulled and ran the real, pinned image (not a mock).
2. Fetched its actual OpenAPI spec (from the service's own source repo, matching what ships in the image) and enumerated every declared endpoint.
3. Ran direct, timed HTTP probes against a live container: cross-instance dedup/caching behavior with identical seed content, row-count scaling, warm-instance reuse, and same-key re-analyze semantics. Raw data: `probe-artifacts/timings.md`. Full endpoint list and source OpenAPI doc: `probe-artifacts/openapi.json`.

## Findings

### 1. The service's API surface has no snapshot/dump/fork/clone endpoint at all

The full endpoint list (12 routes, confirmed against the actual `openapi.json` the image ships): `analyze-database`, four `description` variants, `generation/generate`, `grading/grade`, three `grading/compare/*`, and `query/execute`. There is no `snapshot`, `dump`, `export`, `fork`, `clone`, or `copy` operation anywhere in the declared surface. The only way to materialize a database instance through this service's actual API is `analyze-database` with a full `sqlContent` (DDL + seed DML) payload, and the only way to query it afterward is by reusing the same `databaseId` in `query/execute`.

### 2. No cross-instance caching or deduplication - every session pays full materialization cost, even for byte-identical content

Three independent `databaseId`s (`base-A`, `base-B`, `base-C`) were materialized with **byte-identical** seed content (2,000 rows, ~84KB). All three took essentially the same wall time (1.03s, 0.97s, 0.96s) - no speedup for the 2nd or 3rd call despite the service having already just built the exact same schema+data moments earlier, in the same process. If any form of content-addressed caching, base-snapshot reuse, or copy-on-write existed under the hood, the 2nd/3rd calls building identical content would be expected to be measurably faster than the 1st. They were not.

### 3. Materialization cost in the tested range is dominated by fixed per-call overhead, not data volume

Across 200 to 2,000 rows (7.7KB to 83.7KB of seed SQL), wall time was flat at ~0.95-1.0s regardless of row count - consistent with the dominant cost being PGlite/WASM engine cold-start (spinning up a fresh in-process Postgres-compatible engine per `analyze-database` call), not the DDL/seed replay itself at this scale. (4,000 rows exceeded the service's request body-size limit and could not be tested via this HTTP surface - a body-size ceiling, not a finding about materialization cost.)

### 4. Re-analyzing the *same* `databaseId` fully replaces the instance - it is not an incremental update

Calling `analyze-database` again against an already-materialized `databaseId` with **different** `sqlContent` completely discards the prior schema (a table from the first call became unqueryable - `relation "bigtable" does not exist` - after the second call) and rebuilds from scratch, at the same ~1s cost as a genuinely cold call. There is no partial/incremental update path even for the same key, let alone across keys.

### 5. Within a single already-materialized instance, reuse is fast (but this is not COW - it's just "keep the process alive")

Querying an already-materialized `databaseId` without re-supplying `sqlContent` (i.e. the ordinary "warm session" path the service's own README documents) took 14ms - fast, because it's a plain in-memory read against a live PGlite instance already sitting in the service process's memory. This confirms the service behaves exactly as documented (an analyzed instance is "kept alive in memory for the lifetime of the service process") but is a different claim from COW/incremental snapshotting: it says nothing about the cost of *creating a second, related* instance cheaply from a shared base - which is the actual capability under test, and which findings 2 and 4 show does not exist.

## Verdict

**This specific service, as shipped via its actual HTTP API, does NOT support copy-on-write or incremental snapshotting.** Every session/`databaseId` is an independent, full DDL+seed materialization, with no sharing, caching, or incremental-update path between them - confirmed both by direct evidence (no speedup for identical content, full replacement on same-key re-analyze) and by absence of any endpoint that could plausibly provide it (no snapshot/dump/fork/clone operation exists in the API).

This means, per design.md D1/D5's capability taxonomy, this specific service image should be registered with **`cowSupport: false`** - it belongs to the "full-copy fallback materialization path for non-COW services" class (tasks.md 3.5), not the COW-capable class 3.4 targets. Any workflow using this service for a shared-base-dataset scenario (D3's SQL-session example) pays full base-materialization cost **per session**, not once-per-base-plus-cheap-forks-thereafter - a real cost input for D4's placement/scheduling decisions (materialization-cost-class should be set generously, not "negligible," for this service) and for capacity planning (each concurrent session held warm consumes a full separate PGlite instance's memory, not a shared base plus small deltas).

**This is a legitimate, useful negative result, not a failed spike.** Task 1.1 asked to *confirm* the capability end-to-end; the confirmation is that it is absent for this specific service, discovered by direct measurement rather than assumed from the README's silence on the topic. Design.md never assumed every service would be COW-capable (D1's whole classification scheme exists because services differ on exactly this axis) - this PoC supplies the first real, concrete data point for where an actual candidate service (the one this platform is expected to actually integrate first) falls on that axis.

## What this does NOT settle

- **Whether PGlite itself (the underlying library, `@electric-sql/pglite`) could support something COW-like if the service exposed it differently.** PGlite has its own `dumpDataDir()`/restore-from-tarball mechanism at the library level; this PoC tested the service's actual shipped HTTP API, not whether a *different*, not-yet-built version of the service (or a platform-side wrapper embedding PGlite directly, bypassing this service's HTTP layer entirely) could do better. That would be a legitimate follow-up spike if a COW-capable SQL-execution path is later judged worth building specifically, but it is out of scope for confirming *this* service's *actual, current* capability, which is what task 1.1 asked for.
- **Whether the `postgres` (external, non-PGlite) connection mode behaves differently.** That mode connects to an already-running, externally-managed Postgres instance the service doesn't materialize itself - COW/snapshotting in that mode would be a property of whatever manages that external Postgres (e.g. this platform's own D3 snapshot store), not of this service, so it wasn't in scope for this specific service-capability question.
- **Behavior at larger scale** (beyond the ~84KB/2,000-row ceiling reachable under the service's default request body-size limit) - the flat-cost finding (§3) is confirmed only up to that ceiling; a differently-configured deployment with a larger body-size limit could reveal cost starting to scale with data volume beyond it, though this would not change the core finding (no cross-instance sharing/caching exists regardless of per-call cost shape).

## How to reproduce

```bash
docker pull ghcr.io/htw-aladin/sql-assessment-service:sha-23e9468
docker run --rm -p 3099:3000 ghcr.io/htw-aladin/sql-assessment-service:sha-23e9468

# then, e.g.:
curl -s http://localhost:3099/api/database/analyze-database -X POST \
  -H "Content-Type: application/json" \
  -d '{"connectionInfo":{"type":"pglite","databaseId":"a","sqlContent":"CREATE TABLE t(x int); INSERT INTO t VALUES (1);"}}'
```

See `probe-artifacts/timings.md` for the exact payloads and timings behind every finding above.
