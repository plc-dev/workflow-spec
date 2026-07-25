import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs all four of this spike's test scripts (happy-path, contention,
// crash, load) against ONE shared Postgres container lifecycle, instead of
// starting/stopping Postgres four separate times (what `npm run test:happy`
// / `test:contention` / etc. do individually, each via
// scripts/with-postgres.sh). This is the script `npm test` invokes.
//
// Each individual test file except test-happy-path.js resets/reseeds the
// schema itself at the start (resetSpikeSchema), so running them
// sequentially against the same live Postgres instance is safe - they
// don't need a fresh container each. test-happy-path.js is the one
// exception (it just processes whatever's already queued), so it's run
// immediately after `seed.js` in the same step.
//
// This whole file's process is itself wrapped by scripts/with-postgres.sh
// (see package.json's "test" -> actually invoked via the shell command
// below) - no, to keep the container lifecycle in ONE place rather than
// duplicated between package.json and this file, THIS script directly
// shells out to with-postgres.sh once, with a compound inner command that
// chains all four test files with `&&` (so the whole run fails fast, and
// non-zero, on the first failing step) plus the seed step ahead of
// test-happy-path.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.join(__dirname, "..", "..", "scripts", "with-postgres.sh");

const innerCommand = [
  "node src/seed.js 15 session-A",
  "node src/test-happy-path.js",
  "node src/test-contention.js",
  "node src/test-crash.js",
  "node src/test-load.js",
].join(" && ");

const result = spawnSync(
  "bash",
  [
    wrapper,
    "--name",
    "spike-1-2-test-pg",
    "--port",
    "55432",
    "--db",
    "spike",
    "--password",
    "spike",
    "--schema",
    "schema.sql",
    "--",
    "sh",
    "-c",
    innerCommand,
  ],
  { cwd: __dirname, stdio: "inherit" }
);

process.exit(result.status ?? 1);
