# Raw timing data from the 1.1 PoC

Service: `ghcr.io/htw-aladin/sql-assessment-service:sha-23e9468`
(digest confirmed on pull: `sha256:2bedcc2b92dcdf43e774622423386995ef466a74b7918310d1540e313a956861`)
Mode: PGlite (in-process, embedded WASM Postgres), via `POST /api/database/analyze-database`.

## Full endpoint list (from the service's own `openapi.json`, source repo)

```
/api/database/analyze-database
/api/description/template
/api/description/llm/default
/api/description/llm/creative
/api/description/llm/multi-step
/api/description/hybrid
/api/generation/generate
/api/grading/grade
/api/grading/compare/result-set
/api/grading/compare/ast
/api/grading/compare/execution-plan
/api/query/execute
```

No `snapshot`, `dump`, `export`, `fork`, `clone`, or `copy` endpoint exists anywhere in the declared API surface.

## Cross-instance dedup/caching test (identical seed content, 2,000 rows / ~84KB)

| Call | databaseId | Content | Wall time |
|---|---|---|---|
| 1 (cold) | base-A | seed_med.sql | 1.031s |
| 2 (cold) | base-B | **identical** seed_med.sql | 0.968s |
| 3 (cold) | base-C | **identical** seed_med.sql | 0.956s |

No speedup for the 2nd/3rd identical-content call. All three pay full cost.

## Row-count scaling test (independent databaseIds, one call each)

| Rows | Payload size | Wall time | HTTP |
|---|---|---|---|
| 200 | 7,691 B | 0.999s | 200 |
| 500 | 19,691 B | 0.950s | 200 |
| 1,000 | 39,691 B | 0.947s | 200 |
| 2,000 | 83,691 B | 0.957s | 200 |
| 4,000 | 171,691 B | 0.008s | **413** (exceeds the service's request body-size limit - not reached) |

Essentially flat ~0.95-1.0s across the whole row-count range reachable under the body-size limit - dominated by fixed PGlite/WASM cold-start overhead at this scale, not by data volume.

## Warm-instance reuse vs. re-analyze-replaces-everything test

| Call | databaseId | Action | Wall time | Result |
|---|---|---|---|---|
| 1 | base-A | `query/execute SELECT count(*) FROM bigtable` (no `sqlContent`, reusing the already-materialized instance) | 0.014s | `{"count":2000}` |
| 2 | base-A | `analyze-database` again, SAME databaseId, DIFFERENT `sqlContent` (`CREATE TABLE other...`) | 0.988s | 200 |
| 3 | base-A | `query/execute SELECT count(*) FROM bigtable` | - | **`relation "bigtable" does not exist"`** |
| 4 | base-A | `query/execute SELECT count(*) FROM other` | - | `{"count":3}` |

Re-analyzing the same `databaseId` **fully replaces** the instance (the old schema is gone, not merged/incrementally updated), at the same ~1s cost as a cold analyze - confirming full-rebuild, not incremental-update, semantics even for same-key "updates."
