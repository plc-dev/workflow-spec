-- placement-resolver: formalized placement schema (task 1.10).
--
-- This is the BESPOKE-RESOLVER option from design.md D4/D6 open questions,
-- formalized. The engine decision (1.4/1.4a, design.md D6/D6a) is locked to a
-- Postgres-native, clean-room implementation of THE PATTERN, so a bespoke
-- Postgres-resident placement resolver is the natural fit: it can be upserted
-- in the SAME transaction as the durability core and session log (exactly the
-- DEEP-consolidation property spike 1.2 demonstrated).
--
-- It extends spike 1.2's minimal `placement` table
--   (content_hash PK, replica_id, session_id, updated_at)
-- with the fields D4a's cache-admission model needs: residency state, declared
-- intent, frequency/recency signal, a declared-vs-observed rehydration-cost
-- model, and a size for capacity-aware LRU eviction.
--
-- IMPORTANT: this file lives in its OWN schema (`placement`). It does not
-- modify or depend on the spike's `spike` schema; the two can coexist in one
-- Postgres instance. Downstream (task 4.x) this schema is meant to be created
-- alongside the durability core so a single BEGIN...COMMIT can touch both.

DROP SCHEMA IF EXISTS placement CASCADE;
CREATE SCHEMA placement;
SET search_path TO placement;

-- 1. TUNABLE SCHEDULER PARAMETERS AS DATA -----------------------------------
--
-- D4a is explicit that all numeric thresholds are STARTING DEFAULTS "exposed
-- as tunable scheduler parameters - not hardcoded constants". We model this as
-- a small config table holding named profiles; the JS module reads a profile
-- into a plain config object (and callers may also override it in-memory).
-- The single seeded row `default` carries D4a's starting defaults verbatim.
CREATE TABLE placement_config (
    name          TEXT PRIMARY KEY,
    config        JSONB NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- D4a starting defaults. Every value here is tunable by UPDATE-ing this row
-- (or by passing a different config object into the module's functions); none
-- of them are compiled into SQL or JS.
INSERT INTO placement_config (name, config) VALUES ('default', $json${
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
}$json$::jsonb);

-- Notes on the defaults, mapped to D4a's prose:
--   promotion.frequencyThreshold / frequencyWindowMs
--       -> ">= 3 accesses within a 5-10 minute rolling window" (7 min chosen).
--   promotion.rehydrationCostThresholdMs
--       -> "~250-500ms, below which users likely won't perceive the difference".
--   demotion.idleThresholdMs (20 min) is DELIBERATELY HIGHER than the 7-min
--       promotion window -> D4a's "promote-quick, demote-slow" hysteresis.
--   capacity.pinnedBudgetBytes -> the pinned-pool memory/size budget.
--   cost.observedMinSamples / classPriorsMs -> the declared-cost-class prior
--       used until enough real timings are sampled (see resolver.js).

-- 2. THE FORMALIZED PLACEMENT TABLE -----------------------------------------

CREATE TABLE placement (
    -- identity (carried over from spike 1.2's minimal table) ----------------
    content_hash              TEXT PRIMARY KEY,
    -- the warm replica for this content hash. NULLABLE (unlike the spike's
    -- NOT NULL): a hash can be tracked for admission before/without a bound
    -- replica, and a demoted/evicted entry may retain its fact with no live
    -- replica. A resolver "miss" is replica_id IS NULL or no row at all.
    replica_id                TEXT,
    -- NULLABLE: static/shared/immutable bindings (D4 scope=static) are not
    -- session-scoped, so this is only set for session-scoped residency.
    session_id                TEXT,

    -- residency state (D4a: unpinned vs pinned) ----------------------------
    pinned                    BOOLEAN NOT NULL DEFAULT false,
    pinned_at                 TIMESTAMPTZ,

    -- workflow-writer declared intent (D4) ---------------------------------
    -- batch is the conservative default: D4a forbids auto-promoting batch
    -- bindings regardless of frequency, so an unknown/undeclared binding must
    -- never accidentally qualify for promotion.
    interactivity             TEXT NOT NULL DEFAULT 'batch'
                                CHECK (interactivity IN ('interactive', 'batch')),

    -- frequency / recency signal (D4a promotion + demotion) ----------------
    -- access_count is the CUMULATIVE lifetime counter (cheap running stat).
    -- The windowed ">=3 within N minutes" test is computed from the
    -- placement_access event log below, since a cumulative count cannot
    -- answer a rolling-window question on its own.
    access_count              BIGINT NOT NULL DEFAULT 0,
    first_accessed_at         TIMESTAMPTZ,
    last_accessed_at          TIMESTAMPTZ,

    -- rehydration-cost model (D4a: declared prior -> observed average) ------
    -- declared_cost_class is the service author's D5 materialization-cost
    -- class, used as a PRIOR before empirical data exists.
    declared_cost_class       TEXT
                                CHECK (declared_cost_class IS NULL OR
                                       declared_cost_class IN
                                       ('trivial', 'cheap', 'moderate', 'expensive')),
    -- observed_rehydration_ms is the rolling average of real sampled
    -- rehydration timings; observed_sample_count tracks how many samples have
    -- fed it. Once observed_sample_count >= cost.observedMinSamples the
    -- observed average becomes AUTHORITATIVE over the declared prior.
    observed_rehydration_ms   DOUBLE PRECISION,
    observed_sample_count     INT NOT NULL DEFAULT 0,

    -- capacity-aware LRU eviction (D4a) ------------------------------------
    size_bytes                BIGINT NOT NULL DEFAULT 0,

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Eviction scans the PINNED set ordered by recency (LRU); index it.
CREATE INDEX placement_pinned_lru_idx
    ON placement (last_accessed_at)
    WHERE pinned = true;

-- 3. ROLLING-WINDOW ACCESS EVENT LOG ----------------------------------------
--
-- Append-one-row-per-access so the windowed frequency test is exact rather
-- than an approximation of a cumulative counter. recordAccess prunes rows
-- older than the widest configured window to keep this bounded.
CREATE TABLE placement_access (
    content_hash  TEXT NOT NULL,
    accessed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX placement_access_hash_time_idx
    ON placement_access (content_hash, accessed_at);
