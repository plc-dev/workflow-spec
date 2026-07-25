-- Spike 1.5: generic, engine-agnostic IR interpreter, run against the
-- Postgres-native durability core decided in D6/D6a. Reuses the exact
-- executions/checkpoints/claim_execution() shape from spikes 1.2 and 1.8
-- (a node - step, branch, or map - is just another executions row), plus
-- two new tables needed to interpret a MULTI-NODE workflow-spec generically:
--   - workflow_runs:      one row per invocation of a workflow-spec
--   - run_node_outputs:   per-run, per-node completed output, used to
--                         resolve {from: "step", id, output} bindings that
--                         cross node boundaries (including branch/map
--                         yields, not just plain steps) and to decide when
--                         a dependent node's dependencies are satisfied

DROP SCHEMA IF EXISTS ir CASCADE;
CREATE SCHEMA ir;
SET search_path TO ir;

CREATE TABLE workflow_runs (
    id              BIGSERIAL PRIMARY KEY,
    workflow_name   TEXT NOT NULL,
    request_params  JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'done', 'failed')),
    outputs         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

CREATE TABLE run_node_outputs (
    run_id      BIGINT NOT NULL REFERENCES workflow_runs(id),
    node_id     TEXT NOT NULL,
    output      JSONB NOT NULL,
    done        BOOLEAN NOT NULL DEFAULT false,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, node_id)
);

-- executions: one row per SCHEDULABLE unit - a top-level node (step/branch/
-- map) OR a map child (kind='step', parent_execution_id set) OR a
-- branch/map-case's inner step (kind='step', parent_execution_id set to
-- the branch/map node that spawned it - branch cases spawn their steps
-- lazily, exactly like map's fan-out, once the selector resolves).
CREATE TABLE executions (
    id                  BIGSERIAL PRIMARY KEY,
    run_id              BIGINT NOT NULL REFERENCES workflow_runs(id),
    node_id             TEXT NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN ('step', 'branch', 'map')),
    parent_execution_id BIGINT REFERENCES executions(id),
    map_index           INT,
    node_def            JSONB NOT NULL,   -- this node's own IR fragment
    status              TEXT NOT NULL DEFAULT 'blocked'
                          CHECK (status IN ('blocked', 'queued', 'running', 'awaiting_children', 'done', 'failed')),
    worker_id           TEXT,
    lease_until         TIMESTAMPTZ,
    attempts            INT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX executions_claimable_idx ON executions (status, lease_until);
CREATE INDEX executions_run_idx ON executions (run_id, node_id);

CREATE TABLE checkpoints (
    execution_id  BIGINT NOT NULL REFERENCES executions(id),
    step_id       TEXT NOT NULL,
    output        JSONB NOT NULL,
    committed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (execution_id, step_id)
);

-- map fan-out bookkeeping (identical shape to spike 1.8)
CREATE TABLE map_nodes (
    execution_id      BIGINT PRIMARY KEY REFERENCES executions(id),
    total_children    INT NOT NULL,
    completed_children INT NOT NULL DEFAULT 0,
    source            JSONB NOT NULL
);

-- branch fan-out bookkeeping: which case was selected, and how many of
-- that case's steps must complete before the branch's `yields` can be
-- computed (mirrors map_nodes, generalized to "N children, once selected").
CREATE TABLE branch_nodes (
    execution_id       BIGINT PRIMARY KEY REFERENCES executions(id),
    selected_case      TEXT NOT NULL,
    total_children     INT NOT NULL,
    completed_children INT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION claim_execution(p_worker_id TEXT, p_lease_seconds INT DEFAULT 30)
RETURNS ir.executions AS $$
DECLARE
    v_row ir.executions;
BEGIN
    SELECT * INTO v_row
    FROM ir.executions
    WHERE status = 'queued'
       OR (status = 'running' AND lease_until < now())
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF v_row.id IS NOT NULL THEN
        UPDATE ir.executions
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
$$ LANGUAGE plpgsql SET search_path = ir, pg_catalog;
