// ADR-0012: module-wide named constants live here, not inlined at call
// sites (implementation-best-practices.md #3 - no magic numbers/strings).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnySchemaObject } from "ajv/dist/2020.js";

/** D8d/D11: the current whole-document workflow-spec schema version
 * (author-facing; the field itself is `workflowSpecVersion`, renamed from
 * `irVersion`). Bumped only on breaking changes (additive constructs do
 * not bump it). Nothing yet migrates from an older version - migration
 * (5.13/5.13a/5.13b) is a separate, deferred package (see
 * docs/impl-plans/0004-workflow-spec-schema.md). Execution-plan
 * versioning is tracked separately once a future dsl-compiler/ splits
 * the execution plan out of the workflow-spec into its own
 * `execution-plan/` module. */
export const CURRENT_WORKFLOW_SPEC_VERSION = 1;

const SCHEMA_PATH = fileURLToPath(new URL("./schema/workflow-spec.schema.json", import.meta.url));

/** The parsed workflow-spec JSON Schema, loaded exactly once here so
 * `validate.ts` and `JSON_SCHEMA_ID` share this same object
 * rather than each hardcoding their own independent copy of values the
 * schema file itself already states ($id, $schema draft, the
 * itemResource path pattern) - a single source of truth instead of two
 * hand-synced literals that could drift. */
export const WORKFLOW_SPEC_JSON_SCHEMA: AnySchemaObject = JSON.parse(
  readFileSync(SCHEMA_PATH, "utf-8"),
);

/** Derived from the schema's own `$id` field - never a separately
 * hand-maintained literal. */
export const JSON_SCHEMA_ID = WORKFLOW_SPEC_JSON_SCHEMA.$id as string;
