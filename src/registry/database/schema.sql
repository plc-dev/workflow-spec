-- Service registry: a first-party METADATA INDEX over service images
-- (design.md D12), NOT an image byte store. Every fact is keyed by the
-- image DIGEST; the image bytes themselves live in a standard OCI registry
-- referenced only by the `oci_ref` pointer string (byte storage, pull
-- auth, replication, and GC are all deliberately out of scope - D12).
--
-- Promoted from `archive/registry/schema.sql` (task 2.1/2.1a-c). Own
-- database (ADR-0006) - entirely separate from `core/`'s consolidated
-- schema - so, unlike that archived version, this schema does NOT create
-- a dedicated `registry` SQL namespace: with a real separate database
-- already isolating these tables, a schema-level namespace would be
-- redundant (see docs/impl-plans/0007-registry.md's "Open questions").
-- Tables live in this database's default `public` schema.
--
-- Two-table shape, split by cardinality (D12's ENTRY diagram):
--   service_images        -- per-IMAGE facts (1 row per digest)
--   function_capabilities -- per-FUNCTION facts (1 row per digest+function)
-- because one image can expose several functions with different
-- capability profiles (D5), while hardware requirements + trust tier are
-- per-image.
--
-- `CREATE TABLE IF NOT EXISTS`, never `DROP TABLE` (matches
-- core/database/schema.sql's convention, not the archived version's
-- `DROP SCHEMA ... CASCADE`): this file is applied both to disposable
-- testcontainers-managed instances AND mounted into
-- docker-compose.dev.yml's PERSISTENT `registry-postgres` volume - a
-- DROP here would silently delete every earned `trust_tier` (which
-- registerImage deliberately never resets) on any re-apply against a
-- database that already has real data.
--
-- A schema CHANGE to an EXISTING table (as opposed to a brand-new one)
-- therefore cannot rely on `CREATE TABLE IF NOT EXISTS` alone - it is a
-- no-op against a database that already has the table. Such a change
-- instead follows this file's `function_capabilities` block below as
-- the pattern: idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
-- (nullable first, then tightened), guarded against a database that is
-- ALREADY in the target final shape (whether via this same block having
-- already run, or via `CREATE TABLE IF NOT EXISTS` having just created
-- it fresh).

-- 1. PER-IMAGE ENTRY (keyed by digest) -------------------------------------
--
-- openapi_spec is the SOLE STORED CONTRACT (D12): CLI and MCP surfaces are
-- projected from it at read time, never stored separately, so the three
-- surfaces cannot drift.
--
-- hardware_requirements is deliberately its OWN column, NOT folded into
-- the trust-tier / capability model (D12): a false hardware declaration is
-- a bin-packing/OOM problem corrected by runtime observation (D4), not an
-- isolation-correctness problem gated by conformance probes (D5a). Keeping
-- it a separate JSONB column makes that separation structural, not just
-- documented.
--
-- trust_tier is per-DIGEST (D5a): a regression in a new build does not
-- inherit an older build's earned trust. Every newly registered image
-- starts at 'unverified' (the conservative default - the scheduler leans
-- on NO capability declaration until a build reaches 'production-proven').
CREATE TABLE IF NOT EXISTS service_images (
    digest                TEXT PRIMARY KEY,
    oci_ref               TEXT NOT NULL,
    openapi_spec          JSONB NOT NULL,
    hardware_requirements JSONB NOT NULL DEFAULT '{}',
    trust_tier            TEXT NOT NULL DEFAULT 'unverified'
                            CHECK (trust_tier IN (
                                'unverified',
                                'conformance-passed',
                                'production-proven'
                            )),
    registered_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. PER-FUNCTION CAPABILITY METADATA (D5) ---------------------------------
--
-- One row per (digest, function). materialization_cost_class uses D1's
-- setup-cost axis vocabulary exactly ('negligible' | 'heavy'); the
-- scheduler uses it as a cost prior (D4a) before empirical rehydration
-- timings exist.
--
-- nesting_declaration (D9b/D12) records only the POSSIBILITY of nesting
-- declared by the service author - transport (`via`) plus target shape
-- (`targets`: an enumerable list, or the string "open"). It never records
-- the concrete bound target; that is a DSL-level binding decision made
-- elsewhere and is out of scope for the registry.
--
-- invocation_descriptor / state_reuse / additive_warm_update
-- (design.md D17b, docs/adr/0005, docs/adr/0008): supersedes D17/D17a's
-- single universal `--data-file <path> --state-id <key>` mandate with a
-- three-layer model so an onboarded service can stay "naive" about
-- platform internals -
--   Layer 1 (unconditional, not stored here - it's mechanism, not
--            metadata): heavy bindings are ALWAYS materialized to a
--            local path before exec, invisible to the service.
--   Layer 2 (invocation_descriptor): the function's OWN native CLI
--            signature for each heavy parameter - flag/positional/stdin.
--            Required, empty array for a light-only function.
--   Layer 3 (state_reuse/additive_warm_update): an OPT-IN, D5-style
--            capability claim - whether the function may persist local
--            state keyed by a platform-minted state-id and reuse it
--            across execs. Conservative default is 'none'; only a
--            'stateIdKeyed' function is ever handed a state-id or is
--            ever the target of the exec-agent's Evict(stateId).
-- REQUIRED (NOT NULL, no default) - a deliberate, clean override, not a
-- migration: every registration must declare these explicitly, there is
-- no fallback to D17/D17a's old universal shape.
CREATE TABLE IF NOT EXISTS function_capabilities (
    digest                     TEXT NOT NULL
                                 REFERENCES service_images(digest)
                                 ON DELETE CASCADE,
    function_name              TEXT NOT NULL,
    mutates                    BOOLEAN NOT NULL,
    materialization_cost_class TEXT NOT NULL
                                 CHECK (materialization_cost_class IN (
                                     'negligible',
                                     'heavy'
                                 )),
    cow_support                BOOLEAN NOT NULL,
    change_detection_support   BOOLEAN NOT NULL,
    -- Shape: { "via": "sdk"|"http"|"cli"|"mcp", "targets": [...] | "open" }
    -- NULL means the function declares no nesting at all.
    nesting_declaration        JSONB,
    -- Shape: [ { "param": "dumpFile", "style": "flag"|"positional"|"stdin",
    --            "flagName"?: "--data-file", "positionIndex"?: 0 } ]
    -- Empty array means the function accepts no heavy bindings.
    invocation_descriptor      JSONB NOT NULL,
    state_reuse                TEXT NOT NULL
                                 CHECK (state_reuse IN ('none', 'stateIdKeyed')),
    additive_warm_update       BOOLEAN NOT NULL,
    PRIMARY KEY (digest, function_name)
);

-- Local-review fix (deploy-safety finding): `CREATE TABLE IF NOT EXISTS`
-- above only creates invocation_descriptor/state_reuse/additive_warm_update
-- on a genuinely FRESH database. Applied against docker-compose.dev.yml's
-- PERSISTENT `registry-postgres` volume from BEFORE this change, that
-- statement is a silent no-op (the table already exists without these
-- columns) - every `registerImage` call would then fail with an
-- "undefined column" error, with NO forward path, since dropping the
-- table (forbidden by this file's own header) would destroy every earned
-- `trust_tier`. This block makes design.md D17b's "clean override, not a
-- migration" decision actually REACHABLE from a pre-existing table: add
-- the columns nullable first (never fails, even if already present),
-- DELETE any row that predates this change (an incompatible, pre-D17b
-- registration D17b's own decision says must be re-registered, never
-- silently defaulted), then tighten to the final NOT NULL/CHECK shape.
-- Every statement here is idempotent, including against a database where
-- CREATE TABLE IF NOT EXISTS above already applied the final shape
-- (the fresh-database / testcontainers case).
ALTER TABLE function_capabilities
    ADD COLUMN IF NOT EXISTS invocation_descriptor JSONB,
    ADD COLUMN IF NOT EXISTS state_reuse TEXT,
    ADD COLUMN IF NOT EXISTS additive_warm_update BOOLEAN;

-- Pre-D17b rows have no invocation_descriptor at all - incompatible with
-- the new contract; re-register rather than silently default (D17b).
DELETE FROM function_capabilities WHERE invocation_descriptor IS NULL;

ALTER TABLE function_capabilities
    ALTER COLUMN invocation_descriptor SET NOT NULL,
    ALTER COLUMN state_reuse SET NOT NULL,
    ALTER COLUMN additive_warm_update SET NOT NULL;

DO $$
BEGIN
    ALTER TABLE function_capabilities
        ADD CONSTRAINT function_capabilities_state_reuse_check
        CHECK (state_reuse IN ('none', 'stateIdKeyed'));
EXCEPTION
    WHEN duplicate_object THEN NULL; -- already present (fresh CREATE TABLE, or a prior re-apply of this file)
END $$;
