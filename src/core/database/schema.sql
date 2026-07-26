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
-- `session_log`/`session_pointer` (design.md D3/D3a, tasks 3.1/3.10,
-- docs/impl-plans/0003-session-log.md) are added below too - the durable
-- session input-history log and its rewindable pointer, owned by `core/`
-- per ADR-0002, operated over by the `session/` module (ADR-0007).
--
-- This file also promotes `placement`/`placement_config`/`placement_access`
-- (design.md D4/D4a, task 4.1a, docs/impl-plans/0005-placement.md) -
-- promoted from archive/placement-resolver/schema.sql - the fourth and
-- last piece of the D6 four-way consolidation (durability core, session
-- log, placement, dataset catalog). Decision logic over these tables
-- (resolvePlacement, recordAccess, evaluatePromotion/evaluateDemotion,
-- promote/demote, evictLRUIfOverCapacity, isTrustEligibleForOptimization)
-- lives in the `scheduler/` module (ADR-0007), not here - `core/` owns
-- only the schema and thin per-table repositories.
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
                    CHECK (status IN ('blocked', 'queued', 'running', 'waiting', 'done', 'failed')),
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
    CHECK (status IN ('blocked', 'queued', 'running', 'waiting', 'done', 'failed'));

CREATE INDEX IF NOT EXISTS executions_claimable_idx ON executions (status, lease_until);

-- Task 6.2a (docs/impl-plans/0006-interpreter-plain-steps.md): links an
-- execution row to the workflow_runs row (below) it was created for, and
-- reuses the pre-existing `step` column as that run's IR node id (a
-- WorkflowSpec node's `id` is already a free-text label with no FK/enum
-- constraint - exactly what `step` already was, so no second, redundant
-- column was added). NULL for every execution NOT created by
-- engine.submitRun (durable-sleep/session-log tests, and any future
-- non-workflow-run use of `executions`) - added via ALTER rather than at
-- CREATE TABLE time since `executions` may already exist in a persistent
-- dev database (same posture as the status-CHECK widening above).
ALTER TABLE executions ADD COLUMN IF NOT EXISTS run_id BIGINT;

CREATE INDEX IF NOT EXISTS executions_run_id_idx ON executions (run_id) WHERE run_id IS NOT NULL;

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

-- Session log (design.md D3, tasks 3.1/3.10): the durable source of truth
-- for a session is its user input history, kept independent of any
-- derived snapshot cache (D3's own diagram). `session_id` is the same
-- opaque string `executions.session_id` already uses (minted elsewhere,
-- per D14) - there is no platform-owned `sessions` table, so no FK from
-- either table below to one. `sequence` is per-session, starting at 1,
-- assigned and advanced exclusively by `session/`'s `appendEntry`
-- (docs/impl-plans/0003-session-log.md) - never by a DEFAULT/sequence
-- object here, since the "next" value depends on this session's own
-- current_sequence, not a global counter.
CREATE TABLE IF NOT EXISTS session_log (
    id            BIGSERIAL PRIMARY KEY,
    session_id    TEXT NOT NULL,
    sequence      BIGINT NOT NULL,
    input         JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Also serves every query pattern this table needs (WHERE session_id
    -- = $1 [AND sequence ...] ORDER BY sequence ASC) via this constraint's
    -- own index - a separate CREATE INDEX on the same columns would be
    -- purely redundant write/storage overhead (local-review fix, docs/
    -- impl-plans/0003-session-log.md "Post-review fixes"; mirrors
    -- `checkpoints`' own posture of relying solely on its UNIQUE index).
    UNIQUE (session_id, sequence)
);

-- D3a: a rewind moves `current_sequence` backward; the next `appendEntry`
-- (not the rewind itself) deletes any `session_log` rows past this point
-- before inserting its new entry - see session-pointer.repository.ts /
-- session-log.repository.ts and session/session-log.ts for where each
-- half of that sequencing actually happens. `current_sequence = 0` means
-- "no entries appended yet"; a session has no row here until its first
-- `appendEntry` call creates one.
CREATE TABLE IF NOT EXISTS session_pointer (
    session_id       TEXT PRIMARY KEY,
    current_sequence BIGINT NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (current_sequence >= 0)
);

-- Placement (design.md D4/D4a, task 4.1a): the bespoke-resolver option
-- formalized by task 1.10 (archive/placement-resolver/), promoted here per
-- ADR-0002/0007's split - the schema lives in `core/`, the decision logic
-- that operates over it lives in `scheduler/`. Uses the default `public`
-- schema, same namespacing call already made for the rest of this file -
-- the archived `placement` SQL-schema wrapper existed only to isolate the
-- formalization spike from other experiments sharing one dev database.
--
-- Tunable scheduler parameters as DATA (D4a: every threshold is a
-- "starting default exposed as a tunable scheduler parameter, not a
-- hardcoded constant"). scheduler/constants.ts's DEFAULT_PLACEMENT_CONFIG
-- mirrors the seeded row below - kept in sync by hand, same posture as
-- core/constants.ts's DEFAULT_LEASE_SECONDS.
CREATE TABLE IF NOT EXISTS placement_config (
    name          TEXT PRIMARY KEY,
    config        JSONB NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO placement_config (name, config)
VALUES ('default', $json${
  "promotion": {
    "frequencyThreshold": 3,
    "frequencyWindowMs": 420000,
    "rehydrationCostThresholdMs": 250
  },
  "demotion": {
    "idleThresholdMs": 1200000
  },
  "capacity": {
    "pinnedBudgetBytes": 1073741824
  },
  "cost": {
    "observedMinSamples": 5,
    "classPriorsMs": {
      "trivial": 10,
      "cheap": 50,
      "moderate": 300,
      "expensive": 2000
    }
  }
}$json$::jsonb)
ON CONFLICT (name) DO NOTHING;

-- The formalized placement table (task 1.10, promoted). `replica_id`/
-- `session_id` are NULLABLE (unlike spike 1.2's minimal table): a hash can
-- be tracked for admission before/without a bound replica, and a
-- demoted/evicted entry retains its fact with no live replica - a
-- resolver "miss" is `replica_id IS NULL` or no row at all, never an
-- error (D4: affinity is always an optimization). `session_id` stays
-- NULLABLE because static/shared/immutable bindings (D4 scope=static)
-- are not session-scoped.
CREATE TABLE IF NOT EXISTS placement (
    content_hash              TEXT PRIMARY KEY,
    replica_id                TEXT,
    session_id                TEXT,

    pinned                    BOOLEAN NOT NULL DEFAULT false,
    pinned_at                 TIMESTAMPTZ,

    -- Workflow-writer declared intent (D4). 'batch' is the conservative
    -- default: D4a forbids auto-promoting batch bindings regardless of
    -- frequency, so an unknown/undeclared binding must never accidentally
    -- qualify for promotion.
    interactivity             TEXT NOT NULL DEFAULT 'batch'
                                CHECK (interactivity IN ('interactive', 'batch')),

    -- Frequency/recency signal (D4a promotion + demotion). access_count is
    -- the cumulative lifetime counter; the windowed ">=3 within N minutes"
    -- test is computed from placement_access below, since a cumulative
    -- count can't answer a rolling-window question on its own.
    access_count              BIGINT NOT NULL DEFAULT 0,
    first_accessed_at         TIMESTAMPTZ,
    last_accessed_at          TIMESTAMPTZ,

    -- Rehydration-cost model (D4a: declared prior -> observed average).
    declared_cost_class       TEXT
                                CHECK (declared_cost_class IS NULL OR
                                       declared_cost_class IN
                                       ('trivial', 'cheap', 'moderate', 'expensive')),
    observed_rehydration_ms   DOUBLE PRECISION,
    observed_sample_count     INT NOT NULL DEFAULT 0,

    -- Capacity-aware LRU eviction (D4a).
    size_bytes                BIGINT NOT NULL DEFAULT 0,

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Eviction scans the PINNED set ordered by recency (LRU); index it.
CREATE INDEX IF NOT EXISTS placement_pinned_lru_idx
    ON placement (last_accessed_at)
    WHERE pinned = true;

-- Rolling-window access event log (D4a): append-one-row-per-access so the
-- windowed frequency test is exact rather than an approximation of a
-- cumulative counter. PlacementAccessRepo.pruneOlderThan keeps this
-- bounded.
CREATE TABLE IF NOT EXISTS placement_access (
    content_hash  TEXT NOT NULL,
    accessed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS placement_access_hash_time_idx
    ON placement_access (content_hash, accessed_at);

-- Task 6.2a (docs/impl-plans/0006-interpreter-plain-steps.md): the
-- generic dependency-graph interpreter for plain-`Step` workflow-specs
-- (design.md D8), promoted from archive/spikes/1.5-ir-interpreter/'s
-- already-proven `workflow_runs`/`run_node_outputs` pattern. `spec` is
-- stored as `unknown` (cast, not validated, by core/domain/workflow-
-- run.ts) rather than a typed `ir.WorkflowSpec` - `core/` does not depend
-- on `ir/` (ADR-0007's dependency direction runs the other way); the
-- caller (engine/) is responsible for having already run `ir.validate()`
-- before `submitRun` is ever called.
CREATE TABLE IF NOT EXISTS workflow_runs (
    id            BIGSERIAL PRIMARY KEY,
    session_id    TEXT,
    spec          JSONB NOT NULL,
    input         JSONB NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'done', 'failed')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `executions.run_id` is added earlier in this file (alongside the rest
-- of the `executions` table) but its FK constraint is added here instead,
-- once `workflow_runs` actually exists.
--
-- Local-review fix: unlike `executions_status_check` above (a CHECK,
-- deliberately drop-and-re-added on every apply so a WIDENING is picked
-- up against an already-applied database), this FK's definition never
-- changes once added - there is no widening case to re-apply for. Adding
-- it unconditionally on every apply (as the CHECK pattern does) would
-- mean: (1) `DROP CONSTRAINT` + a validated `ADD CONSTRAINT` takes an
-- `ACCESS EXCLUSIVE` lock on `executions` - the hot table `claim_execution()`
-- polls - for the duration of a full-table validation scan, on every
-- single schema.sql apply against a database that may already hold real
-- rows; (2) that validation cost is repaid for no reason, since the
-- constraint's definition is static. Guarded so it is only ever added
-- once, and via `NOT VALID` + a separate `VALIDATE CONSTRAINT` (the
-- latter takes only `SHARE UPDATE EXCLUSIVE`, which does not block
-- ordinary reads/writes) rather than a single validated `ADD CONSTRAINT`.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'executions_run_id_fkey'
    ) THEN
        ALTER TABLE executions ADD CONSTRAINT executions_run_id_fkey
            FOREIGN KEY (run_id) REFERENCES workflow_runs(id) NOT VALID;
        ALTER TABLE executions VALIDATE CONSTRAINT executions_run_id_fkey;
    END IF;
END $$;

-- Per-run, per-TOP-LEVEL-node-id completed output - what `{from:"step",
-- id}` bindings resolve against across node boundaries (spike 1.5's
-- `run_node_outputs`). Deliberately scoped to top-level node ids only,
-- from the start: design.md D8c's "a case's/body's internal step ids are
-- structurally unreachable from outside that node" means a future 6.2b
-- (branch/map) must never write an internal case/body step's output
-- here - only a completed branch/map NODE's own `yields` result, exactly
-- like a plain Step's output. Scoping this table that way now means
-- 6.2b extends it as-is, no later migration needed.
CREATE TABLE IF NOT EXISTS run_node_outputs (
    run_id        BIGINT NOT NULL REFERENCES workflow_runs(id),
    node_id       TEXT NOT NULL,
    output        JSONB NOT NULL,
    completed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Also serves this table's one lookup pattern (WHERE run_id = $1
    -- [AND node_id = $2]) via this constraint's own index - mirrors
    -- session_log's UNIQUE(session_id, sequence) posture of not adding a
    -- redundant separate index over the same columns.
    UNIQUE (run_id, node_id)
);
