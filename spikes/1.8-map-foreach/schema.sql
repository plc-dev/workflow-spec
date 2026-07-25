-- Spike 1.8: dynamic map/forEach construct against the Postgres-native
-- durable-execution engine selected in tasks.md 1.4 (design.md D6 "THE
-- PATTERN", first spiked in spikes/1.2-resonate-pg-durable-exec/).
--
-- This spike does NOT re-derive the durability core; it EXTENDS the same
-- pattern (an executions table + SELECT ... FOR UPDATE SKIP LOCKED claiming +
-- a UNIQUE(execution_id, step_id) checkpoints table for exactly-once step
-- completion) with the minimum needed to represent D8's `map`/`forEach`
-- fan-out and D9's child/step-execution primitive:
--
--   design.md D8 (line 583): "A map/forEach construct statically declares the
--   shape of a single iteration ...; only the iteration count is resolved at
--   run time, from a runtime-sized collection. Each iteration executes as an
--   independently tracked, durable unit (see D9), so partial failure only
--   re-runs the failed iteration."
--
--   design.md D8c (line 735): the join resolves `{ from: step, id: <mapId>,
--   output: <name> }` to "the array of per-iteration values ... regardless of
--   ... what order they're declared" - i.e. PARALLEL ARRAYS in ORIGINAL
--   source order, not completion order.
--
--   design.md D9 (line 770) / task 6.9: "a running workflow can start one or
--   many additional tracked executions, including dynamically and in a loop,
--   WITHOUT THE PARENT TERMINATING, with each getting its own durable
--   tracking, retries ...".
--
-- Design choice: REUSE the existing `executions` table for children rather
-- than a separate `map_children` table. A child iteration IS "just another
-- durable execution" per D9 - giving it its own row means it is claimed,
-- leased, retried, checkpointed and swept by the EXACT same machinery as any
-- ordinary execution (that is the whole claim being tested). A separate table
-- would have forced a parallel, near-duplicate claim/lease/retry path and
-- undercut the "a child is just another execution row" property. The map/
-- child linkage is therefore two nullable columns (`parent_execution_id`,
-- `map_index`); a small `map_nodes` companion table tracks per-parent
-- cardinality + a completion counter for O(1) "are all children done?"
-- detection, and `map_results` stores the joined parallel arrays.

DROP SCHEMA IF EXISTS spike CASCADE;
CREATE SCHEMA spike;
SET search_path TO spike;

-- 1. DURABILITY CORE (unchanged from spike 1.2's pattern) -------------------
--    ...plus three nullable columns carrying the map/child relationship and a
--    persistent transient-failure injector for the independent-retry test.

CREATE TABLE executions (
    id                   BIGSERIAL PRIMARY KEY,
    -- 'map'  = a map/forEach node: on first claim it fans out into N child
    --          rows and parks itself in 'awaiting_children' WITHOUT holding a
    --          worker; it is re-queued for a final 'join' claim once its last
    --          child completes.
    -- 'step' = an ordinary unit of work. A step with parent_execution_id set
    --          is a map child; with it NULL it is a standalone execution,
    --          claimed from the very same queue by the very same workers.
    kind                 TEXT NOT NULL DEFAULT 'step'
                            CHECK (kind IN ('map', 'step')),
    parent_execution_id  BIGINT REFERENCES executions(id),
    map_index            INT,                    -- child's position in source
    step                 TEXT NOT NULL,
    input                JSONB NOT NULL DEFAULT '{}',
    status               TEXT NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'running',
                                              'awaiting_children', 'done',
                                              'failed')),
    worker_id            TEXT,
    lease_until          TIMESTAMPTZ,
    attempts             INT NOT NULL DEFAULT 0,
    -- Test hook for the independent-retry scenario: a persistent count of
    -- transient failures this execution should still suffer before it is
    -- allowed to succeed. Decremented in its OWN committed transaction (so the
    -- decrement survives the main transaction's rollback), simulating a
    -- transient error that is genuinely consumed across attempts. 0 = never
    -- inject a failure.
    fail_remaining       INT NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX executions_claimable_idx ON executions (status, lease_until);
CREATE INDEX executions_parent_idx ON executions (parent_execution_id);

CREATE TABLE checkpoints (
    execution_id  BIGINT NOT NULL REFERENCES executions(id),
    step_id       TEXT NOT NULL,
    output        JSONB NOT NULL,
    committed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (execution_id, step_id)
);

-- 2. MAP FAN-OUT BOOKKEEPING -------------------------------------------------

-- One row per map node, created atomically WITH its children in the fan-out
-- transaction. `total_children` freezes the runtime-resolved cardinality;
-- `completed_children` is bumped (under FOR UPDATE on this row) by each child
-- as it commits its completion, so exactly one child observes
-- completed_children == total_children and re-queues the parent for its join.
CREATE TABLE map_nodes (
    execution_id        BIGINT PRIMARY KEY REFERENCES executions(id),
    total_children      INT NOT NULL,
    completed_children  INT NOT NULL DEFAULT 0,
    source              JSONB NOT NULL,   -- the runtime-sized source array
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The join output: parallel arrays, one element per source item, in ORIGINAL
-- source order (index 0..N-1). This is what a downstream step reading
-- `{ from: step, id: <mapId>, output: <name> }` resolves to per D8c.
CREATE TABLE map_results (
    execution_id  BIGINT PRIMARY KEY REFERENCES executions(id),
    yields        JSONB NOT NULL,        -- { "<name>": [v0, v1, ... vN-1], ... }
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Claim function: identical to spike 1.2's - THE PATTERN's dispatcher.
--    A map node's children and standalone steps are indistinguishable to it;
--    all are just `status='queued'` rows handed out FOR UPDATE SKIP LOCKED.

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
