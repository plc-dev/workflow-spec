// Named stand-ins for types that will eventually live in the future pure
// modules `logic/` (D10's JSON-Logic evaluator) and `urn/` (D8a/D13's URN
// parser) - neither module exists yet (ADR-0003: `workflow-spec/` "MAY
// depend on" them, not "MUST"). Each alias is currently just
// `unknown`/`string`; the
// indirection means tightening these later (once `logic/`/`urn/` land) is
// a one-line change to the alias itself, not a hunt through every
// interface that references it.

/** D10: a JSON-Logic expression object (e.g. `{ ">": [{ var: "count" }, 100] }`).
 * Placeholder until `logic/` exists and can type this precisely. */
export type LogicExpression = Record<string, unknown>;

/** D8a/D13: a dataset or workflow URN string
 * (`urn:<platform>:<resourceType>:<namespace>/<name>[:<tag> | @<alg>:<digest>]`).
 * Placeholder until `urn/` exists and can type/parse this precisely. */
export type Urn = string;

/** D16: a locator into a flattened item-instance manifest. Provisional
 * grammar: RFC 6901 JSON Pointer (see schema/workflow-spec.schema.json's
 * `jsonPointer` $def, the single source of truth for this pattern, and
 * this package's impl-plan doc for why this is a revisitable choice, not
 * a closed decision). */
export type JsonPointer = string;

/** D8c: a digest-pinned OCI reference (`<repo>@<alg>:<hex-digest>`), never
 * a bare tag. Placeholder string type - no OCI-reference parsing exists
 * anywhere in this codebase yet. */
export type OciDigestRef = string;
