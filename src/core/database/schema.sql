-- core/ owns the consolidated Postgres schema (ADR-0002). This package
-- (0001-durable-core) promotes only the durability-core subset of that
-- eventual schema - `executions`/`checkpoints` plus the `claim_execution()`
-- dispatcher - from archive/spikes/1.2-resonate-pg-durable-exec/schema.sql.
--
-- This file also promotes the `waits` table, `claim_execution()`'s
-- due-timer-wait branch, and `signal_wait()` (docs/impl-plans/
-- 0002-durable-sleep.md, task 6.1b) - the remainder of THE PATTERN
-- (design.md D6) that 0001 deliberately deferred.
--
-- Deliberately NOT included here:
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
                    CHECK (status IN ('queued', 'running', 'waiting', 'done', 'failed')),
    worker_id     TEXT,
    lease_until   TIMESTAMPTZ,
    attempts      INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `CREATE TABLE IF NOT EXISTS` above is a no-op against an already-
-- existing `executions` table (e.g. a persistent docker-compose.dev.yml
-- volume created before this file added 'waiting'), so it would NOT by
-- itself widen an already-applied, narrower CHECK. Make the widening
-- itself idempotent and re-appliable: drop-if-exists then re-add the
-- named constraint on every apply, so schema.sql really is the single
-- canonical source of truth this file's header claims, not just for
-- brand-new databases.
ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_status_check;
ALTER TABLE executions ADD CONSTRAINT executions_status_check
    CHECK (status IN ('queued', 'running', 'waiting', 'done', 'failed'));

CREATE INDEX IF NOT EXISTS executions_claimable_idx ON executions (status, lease_until);

CREATE TABLE IF NOT EXISTS checkpoints (
    execution_id  BIGINT NOT NULL REFERENCES executions(id),
    step_id       TEXT NOT NULL,
    output        JSONB NOT NULL,
    committed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (execution_id, step_id)
);

-- Durable sleep (design.md D6 "THE PATTERN", task 6.1b): a `wake_at`
-- timer wait, a `wait_key` signal wait, or both (a hybrid wait, woken by
-- whichever fires first) - at least one wakeup path is required. A
-- multi-week wait costs exactly this one row; no separate sweeper process
-- ever polls it - `claim_execution()` below finds a due timer wait via an
-- ordinary EXISTS join on its own existing SKIP LOCKED scan, and
-- `signal_wait()` finds signal waits directly by key.
CREATE TABLE IF NOT EXISTS waits (
    id            BIGSERIAL PRIMARY KEY,
    execution_id  BIGINT NOT NULL REFERENCES executions(id),
    wait_key      TEXT,
    wake_at       TIMESTAMPTZ,
    satisfied_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (wait_key IS NOT NULL OR wake_at IS NOT NULL),
    -- Defense in depth: signal_wait() passes wait_key straight into
    -- pg_notify(), whose payload is hard-capped at 8000 bytes by Postgres
    -- itself - an oversized key would otherwise abort that ENTIRE call
    -- (rolling back every wait it was about to satisfy/promote), not just
    -- reject the one bad row. WaitsRepo.create (core/repositories/waits
    -- .repository.ts) already rejects an oversized key before this point
    -- with a structured error; this CHECK is the backstop for any other
    -- writer of this table. WAIT_KEY_MAX_LENGTH in core/constants.ts is
    -- the TypeScript-side mirror of this literal - kept in sync by hand.
    CHECK (wait_key IS NULL OR length(wait_key) <= 256)
);

-- Partial indexes: only pending (unsatisfied) waits are ever scanned by
-- claim_execution()'s EXISTS join or signal_wait()'s key lookup - satisfied
-- rows are historical and never looked up by either path again.
CREATE INDEX IF NOT EXISTS waits_pending_wake_idx ON waits (execution_id, wake_at)
    WHERE satisfied_at IS NULL AND wake_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS waits_pending_key_idx ON waits (wait_key)
    WHERE satisfied_at IS NULL AND wait_key IS NOT NULL;

-- THE PATTERN's dispatcher (design.md D6): no broker, no leader election.
-- `SELECT ... FOR UPDATE SKIP LOCKED` claims exactly one claimable row -
-- queued, running-with-an-expired-lease, OR waiting-with-a-due-timer (the
-- EXISTS branch added for task 6.1b, no separate sweeper) - and promotes
-- it to `running` with a fresh lease, all in one round trip. Ported
-- near-verbatim from spike 1.2 (already crash/contention/load-tested
-- there), extended in place for durable sleep.
CREATE OR REPLACE FUNCTION claim_execution(p_worker_id TEXT, p_lease_seconds INT DEFAULT 30)
RETURNS executions AS $$
DECLARE
    v_row executions;
BEGIN
    SELECT * INTO v_row
    FROM executions
    WHERE status = 'queued'
       OR (status = 'running' AND lease_until < now())
       OR (status = 'waiting' AND EXISTS (
             SELECT 1 FROM waits w
             WHERE w.execution_id = executions.id
               AND w.satisfied_at IS NULL
               AND w.wake_at IS NOT NULL
               AND w.wake_at <= now()
           ))
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF v_row.id IS NOT NULL THEN
        -- Mark the due timer wait(s) that made this row claimable as
        -- satisfied - same transaction as the promotion below, so a wait
        -- row is never left dangling "pending" once its execution has
        -- already moved past `waiting`. Lock order here (executions
        -- already locked by the SELECT above, waits locked next) is the
        -- one signal_wait() deliberately mirrors - see its own comment
        -- for why a mismatched order would deadlock.
        UPDATE waits
        SET satisfied_at = now()
        WHERE execution_id = v_row.id
          AND satisfied_at IS NULL
          AND wake_at IS NOT NULL
          AND wake_at <= now();

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

-- Durable-sleep wakeup, signal side (design.md D6, task 6.1b). Durably
-- broadcasts to EVERY still-pending wait on `p_wait_key`, not just one -
-- this is why each matching row is (eventually) locked with plain
-- (blocking) `FOR UPDATE`, not `SKIP LOCKED`: skipping a contended row
-- here would silently under-deliver the broadcast, unlike
-- claim_execution()'s "some other worker already has it, fine"
-- reasoning. Each matching wait's execution is promoted back to `queued`
-- only if it is still `waiting` (guards against a race with
-- claim_execution()'s own timer-wait branch already having claimed it via
-- the hybrid wait's OTHER wakeup path). Emits one NOTIFY on
-- execution_ready per call (see core/constants.ts EXECUTION_READY_CHANNEL
-- for the TypeScript-side name) - a latency optimization only; the rows
-- above are what actually make an execution claimable, never the NOTIFY
-- itself.
--
-- Lock ORDER matters here: this function locks `executions` BEFORE
-- `waits`, on purpose, matching claim_execution()'s own order (it locks
-- `executions` via its outer SELECT, then locks the matching `waits` row
-- afterward). If this function locked `waits` first instead (the more
-- "obvious" order, given it's driven by a `waits` lookup), a
-- claim_execution() call and a signal_wait() call racing on the SAME
-- hybrid wait's rows could deadlock (each blocked waiting for the lock
-- the other already holds) - Postgres would detect and abort one side
-- with a `deadlock detected` error neither caller expects. The initial
-- candidate scan below deliberately does NOT lock `waits` up front (no
-- `FOR UPDATE` on it yet) - each candidate's `executions` row is locked
-- FIRST, then its `waits` row is re-locked and re-checked (a concurrent
-- signal_wait()/claim_execution() may have already satisfied it in the
-- gap between the initial scan and this row's turn).
CREATE OR REPLACE FUNCTION signal_wait(p_wait_key TEXT)
RETURNS SETOF waits AS $$
DECLARE
    v_candidate waits;
    v_wait waits;
BEGIN
    FOR v_candidate IN
        SELECT * FROM waits
        WHERE wait_key = p_wait_key AND satisfied_at IS NULL
    LOOP
        -- Lock the EXECUTION row first (same order claim_execution()
        -- uses) - blocks here if claim_execution() (or a concurrent
        -- signal_wait()) already holds it, rather than racing to lock
        -- `waits` first and risking the opposite deadlock order.
        PERFORM 1 FROM executions WHERE id = v_candidate.execution_id FOR UPDATE;

        -- Re-lock and re-check the wait row itself now that the execution
        -- lock is held - it may have been satisfied by a concurrent call
        -- in the gap since the unlocked scan above found it.
        SELECT * INTO v_wait FROM waits WHERE id = v_candidate.id FOR UPDATE;
        CONTINUE WHEN v_wait.satisfied_at IS NOT NULL;

        UPDATE waits SET satisfied_at = now() WHERE id = v_wait.id
        RETURNING * INTO v_wait;

        UPDATE executions
        SET status = 'queued', updated_at = now()
        WHERE id = v_wait.execution_id AND status = 'waiting';

        RETURN NEXT v_wait;
    END LOOP;

    PERFORM pg_notify('execution_ready', p_wait_key);
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_catalog;
