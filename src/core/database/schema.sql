-- core/ owns the consolidated Postgres schema (ADR-0002). This package
-- (0001-durable-core) promotes only the durability-core subset of that
-- eventual schema - `executions`/`checkpoints` plus the `claim_execution()`
-- dispatcher - from archive/spikes/1.2-resonate-pg-durable-exec/schema.sql.
--
-- Deliberately NOT included here (see docs/impl-plans/0001-durable-core.md):
--   - `waits` (durable sleep) and the LISTEN/NOTIFY WakeListener - task 6.1b
--   - `session_log`/`session_pointer` (D3) - belongs to a future session/
--     package, added to this same schema.sql when that package lands
--   - `placement`/`placement_config`/`placement_access` (D4/D4a) - belongs
--     to a future scheduler/ package, likewise
--
-- Uses the default `public` schema, not a dedicated SQL schema namespace -
-- spike 1.2's `spike` schema existed only to isolate it from other
-- experiments sharing one dev database; that concern doesn't apply here
-- (registry/workflow-store get their own separate databases per ADR-0006).
--
-- Applied fresh by testcontainers (tests, ADR-0009) and by the local dev
-- stack (docker-compose.dev.yml, ADR-0010). No migration tool yet
-- (ADR-0009: migrations deferred until a live environment holds data worth
-- preserving across a schema change) - this file is the single canonical,
-- idempotent source of truth.

CREATE TABLE IF NOT EXISTS executions (
    id            BIGSERIAL PRIMARY KEY,
    session_id    TEXT NOT NULL,
    step          TEXT NOT NULL,
    input         JSONB NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'done', 'failed')),
    worker_id     TEXT,
    lease_until   TIMESTAMPTZ,
    attempts      INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS executions_claimable_idx ON executions (status, lease_until);

CREATE TABLE IF NOT EXISTS checkpoints (
    execution_id  BIGINT NOT NULL REFERENCES executions(id),
    step_id       TEXT NOT NULL,
    output        JSONB NOT NULL,
    committed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (execution_id, step_id)
);

-- THE PATTERN's dispatcher (design.md D6): no broker, no leader election.
-- `SELECT ... FOR UPDATE SKIP LOCKED` claims exactly one claimable row
-- (queued, or running-with-an-expired-lease) and promotes it to `running`
-- with a fresh lease, all in one round trip. Ported near-verbatim from
-- spike 1.2 (already crash/contention/load-tested there).
CREATE OR REPLACE FUNCTION claim_execution(p_worker_id TEXT, p_lease_seconds INT DEFAULT 30)
RETURNS executions AS $$
DECLARE
    v_row executions;
BEGIN
    SELECT * INTO v_row
    FROM executions
    WHERE status = 'queued'
       OR (status = 'running' AND lease_until < now())
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF v_row.id IS NOT NULL THEN
        UPDATE executions
        SET status = 'running',
            worker_id = p_worker_id,
            lease_until = now() + (p_lease_seconds || ' seconds')::interval,
            attempts = attempts + 1,
            updated_at = now()
        WHERE id = v_row.id
        RETURNING * INTO v_row;
    END IF;

    RETURN v_row;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_catalog;
