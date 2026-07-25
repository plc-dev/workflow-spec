// Validates every document under examples/ (expect PASS) and
// examples-invalid/ (expect FAIL) against workflow-spec.schema.json.
// Uses ajv (draft 2020-12) + the yaml parser (examples are restricted YAML).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));

const schema = JSON.parse(
  readFileSync(join(here, "workflow-spec.schema.json"), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

function loadDir(rel) {
  const dir = join(here, rel);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml") || f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: join(rel, f), doc: parseYaml(readFileSync(join(dir, f), "utf8")) }));
}

let pass = 0;
let fail = 0;

console.log("== examples/ (expect PASS) ==");
for (const { file, doc } of loadDir("examples")) {
  const ok = validate(doc);
  if (ok) {
    pass++;
    console.log(`  PASS  ${file}`);
  } else {
    fail++;
    console.log(`  FAIL  ${file} (expected valid)`);
    console.log("        " + ajv.errorsText(validate.errors, { separator: "\n        " }));
  }
}

console.log("== examples-invalid/ (expect FAIL) ==");
for (const { file, doc } of loadDir("examples-invalid")) {
  const ok = validate(doc);
  if (!ok) {
    pass++;
    console.log(`  PASS  ${file} (correctly rejected)`);
  } else {
    fail++;
    console.log(`  FAIL  ${file} (expected invalid, but validated)`);
  }
}

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
