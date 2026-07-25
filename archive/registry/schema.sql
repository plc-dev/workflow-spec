-- Service registry: a first-party METADATA INDEX over service images
-- (design.md D12), NOT an image byte store. Every fact is keyed by the
-- image DIGEST; the image bytes themselves live in a standard OCI registry
-- referenced only by the `oci_ref` pointer string (byte storage, pull auth,
-- replication, and GC are all deliberately out of scope - D12).
--
-- Conventions mirror spikes/1.2-resonate-pg-durable-exec (Postgres-native
-- per D6/D6a): a dedicated schema/namespace, explicit CHECK-constrained
-- enums, small focused tables. This is the first REAL (non-spike) product
-- component in the repo, so it establishes the `registry/` convention
-- parallel to `spikes/`.
--
-- Two-table shape, split by cardinality (D12's ENTRY diagram):
--   service_images       -- per-IMAGE facts (1 row per digest)
--   function_capabilities -- per-FUNCTION facts (1 row per digest+function)
-- because one image can expose several functions with different capability
-- profiles (D5), while hardware requirements + trust tier are per-image.

DROP SCHEMA IF EXISTS registry CASCADE;
CREATE SCHEMA registry;
SET search_path TO registry;

-- 1. PER-IMAGE ENTRY (keyed by digest) -------------------------------------
--
-- openapi_spec is the SOLE STORED CONTRACT (D12): CLI and MCP surfaces are
-- projected from it at read time, never stored separately, so the three
-- surfaces cannot drift.
--
-- hardware_requirements is deliberately its OWN column, NOT folded into the
-- trust-tier / capability model (D12): a false hardware declaration is a
-- bin-packing/OOM problem corrected by runtime observation (D4), not an
-- isolation-correctness problem gated by conformance probes (D5a). Keeping
-- it a separate JSONB column makes that separation structural, not just
-- documented.
--
-- trust_tier is per-DIGEST (D5a): a regression in a new build does not
-- inherit an older build's earned trust. Every newly registered image
-- starts at 'unverified' (the conservative default - the scheduler leans on
-- NO capability declaration until a build reaches 'production-proven').
CREATE TABLE service_images (
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
-- setup-cost axis vocabulary exactly ('negligible' | 'heavy'); the scheduler
-- uses it as a cost prior (D4a) before empirical rehydration timings exist.
--
-- nesting_declaration (D9b/D12) records only the POSSIBILITY of nesting
-- declared by the service author - transport (`via`) plus target shape
-- (`targets`: an enumerable list, or the string "open"). It never records
-- the concrete bound target; that is a DSL-level binding decision made
-- elsewhere and is out of scope for the registry.
CREATE TABLE function_capabilities (
    digest                    TEXT NOT NULL
                                REFERENCES service_images(digest)
                                ON DELETE CASCADE,
    function_name             TEXT NOT NULL,
    mutates                   BOOLEAN NOT NULL,
    materialization_cost_class TEXT NOT NULL
                                CHECK (materialization_cost_class IN (
                                    'negligible',
                                    'heavy'
                                )),
    cow_support               BOOLEAN NOT NULL,
    change_detection_support  BOOLEAN NOT NULL,
    -- Shape: { "via": "sdk"|"http"|"cli"|"mcp", "targets": [...] | "open" }
    -- NULL means the function declares no nesting at all.
    nesting_declaration       JSONB,
    PRIMARY KEY (digest, function_name)
);
