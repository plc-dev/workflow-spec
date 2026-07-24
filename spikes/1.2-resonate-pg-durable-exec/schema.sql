-- Spike 1.2: Postgres-durable-execution pattern (resonate-pg-shaped fork),
-- extended to hold D3's session log and D4's placement-resolver in the SAME
-- Postgres instance/schema, so a single transaction can prove (or disprove)
-- DEEP infra consolidation (atomic multi-concern commit), not just SHALLOW
-- (same-instance locality).
--
-- This mirrors design.md D6's "THE PATTERN":
--   - an executions table (status, step, input, context, lease/heartbeat)
--   - claim via SELECT ... FOR UPDATE SKIP LOCKED
--   - idempotent steps via a UNIQUE(execution_id, step_id) constraint on a
--     checkpoints table
--   - a sweeper that resets/retries executions whose lease has expired
--
-- Added for this spike, in the SAME schema (the thing under test):
--   - session_log: D3's durable, append-only, per-session input history
--   - placement: D4's placement-resolver ("which replica is warm for hash X")

DROP SCHEMA IF EXISTS spike CASCADE;
CREATE SCHEMA spike;
SET search_path TO spike;

-- 1. DURABILITY CORE (the engine itself) -----------------------------------

CREATE TABLE executions (
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

CREATE INDEX executions_claimable_idx ON executions (status, lease_until);

CREATE TABLE checkpoints (
    execution_id  BIGINT NOT NULL REFERENCES executions(id),
    step_id       TEXT NOT NULL,
    output        JSONB NOT NULL,
    committed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (execution_id, step_id)
);

-- 2. D3: SESSION INPUT-HISTORY LOG (durable source of truth for a session) --

CREATE TABLE session_log (
    session_id    TEXT NOT NULL,
    seq           BIGINT NOT NULL,
    mutation      JSONB NOT NULL,
    committed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, seq)
);

-- One row per session tracks the current chain pointer; FOR UPDATE on THIS
-- row is exactly the "ordinary SELECT ... FOR UPDATE discipline" D6 asks
-- this spike to validate against D3's linear-per-session-mutation guarantee.
CREATE TABLE session_pointer (
    session_id    TEXT PRIMARY KEY,
    head_seq      BIGINT NOT NULL DEFAULT 0,
    head_hash     TEXT NOT NULL DEFAULT 'root'
);

-- 3. D4: PLACEMENT-RESOLVER (which replica is warm for a given content hash) -

CREATE TABLE placement (
    content_hash  TEXT PRIMARY KEY,
    replica_id    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Claim function: THE PATTERN's dispatcher, no broker, no leader election

CREATE OR REPLACE FUNCTION claim_execution(p_worker_id TEXT, p_lease_seconds INT DEFAULT 30)
RETURNS spike.executions AS $$
DECLARE
    v_row spike.executions;
BEGIN
    SELECT * INTO v_row
    FROM spike.executions
    WHERE status = 'queued'
       OR (status = 'running' AND lease_until < now())
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF v_row.id IS NOT NULL THEN
        UPDATE spike.executions
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
$$ LANGUAGE plpgsql SET search_path = spike, pg_catalog;
