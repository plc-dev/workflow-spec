// design.md D8a: the restricted-YAML profile - a strict superset-of-JSON
// grammar with anchors (`&`), aliases (`*`), merge keys (`<<`), and
// custom tags banned (task 5.6a). Enforcing this is explicitly THIS
// module's job, not `workflow-spec/`'s JSON Schema (see
// `archive/dsl/schema/README.md`'s "Limitations" section, carried forward
// by docs/impl-plans/0004-workflow-spec-schema.md) - any YAML parser
// resolves anchors/aliases away *before* a JSON Schema validator ever
// sees the result, so the ban has to be enforced against the YAML AST
// itself, before that resolution happens.

import { type Document, isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import { COMPILE_ERROR_CODES, WHOLE_DOCUMENT_ERROR_PATH, YAML_MERGE_KEY } from "./constants.js";
import type { CompileError } from "./domain/compile-result.js";

export type ParsedYamlResult = { ok: true; doc: unknown } | { ok: false; errors: CompileError[] };

function restrictedYamlError(message: string): CompileError {
  return {
    code: COMPILE_ERROR_CODES.restricted_yaml_violation,
    path: WHOLE_DOCUMENT_ERROR_PATH,
    message,
  };
}

/** Walks the parsed AST looking for the four constructs D8a bans. Returns
 * every violation found (does not stop at the first one) so a caller gets
 * a complete picture of what to fix, mirroring `workflow-spec/validate()`'s
 * `allErrors: true` posture. */
function findRestrictedProfileViolations(doc: Document): CompileError[] {
  const violations: CompileError[] = [];

  visit(doc, (_key, node) => {
    if (node == null || typeof node !== "object") return;

    if ("anchor" in node && node.anchor) {
      violations.push(
        restrictedYamlError(
          `Restricted-YAML profile violation: anchor "&${node.anchor}" is not allowed (D8a).`,
        ),
      );
    }

    if (isAlias(node)) {
      violations.push(
        restrictedYamlError(
          `Restricted-YAML profile violation: alias "*${node.source}" is not allowed (D8a).`,
        ),
      );
    }

    if ("tag" in node && node.tag) {
      violations.push(
        restrictedYamlError(
          `Restricted-YAML profile violation: custom tag "${node.tag}" is not allowed (D8a).`,
        ),
      );
    }

    if (isMap(node)) {
      for (const pair of node.items) {
        if (isScalar(pair.key) && pair.key.value === YAML_MERGE_KEY) {
          violations.push(
            restrictedYamlError(
              `Restricted-YAML profile violation: merge key "${YAML_MERGE_KEY}" is not allowed (D8a).`,
            ),
          );
        }
      }
    }
  });

  return violations;
}

/** Parses restricted-YAML source into a plain JS value, rejecting
 * anchors/aliases/merge-keys/custom-tags (D8a) and ordinary YAML syntax
 * errors alike - both leave the caller with no usable document, so both
 * are reported the same way rather than one of them crashing this
 * function. Never throws. */
export function parseRestrictedYaml(source: string): ParsedYamlResult {
  const doc = parseDocument(source);

  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((error) => restrictedYamlError(`YAML parse error: ${error.message}`)),
    };
  }

  const violations = findRestrictedProfileViolations(doc);
  if (violations.length > 0) {
    return { ok: false, errors: violations };
  }

  return { ok: true, doc: doc.toJS() };
}
