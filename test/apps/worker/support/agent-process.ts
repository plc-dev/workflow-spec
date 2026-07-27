import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// docs/impl-plans/0011-worker-cli-dispatch.md's Test design: this
// package's own correctness property - "our TS client speaks the real
// exec-agent wire protocol correctly, against a real fork/exec'd
// subprocess" - is not provable against a mocked fetch(). This helper
// spawns the REAL, already-built agent/ binary as a plain local child
// process (no Docker, no kind/k8s - package 0010 already proved the k8s
// injection shape separately). Mirrors agent/deploy/kind/run-e2e.sh's own
// curl-against-a-real-agent shape, driven from TS instead of curl.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_MODULE_DIR = path.join(__dirname, "../../../../agent");
export const FAKE_CLI_PATH = path.join(AGENT_MODULE_DIR, "testdata/fake-cli.sh");

let cachedBinaryPath: string | undefined;

/** Builds the agent binary once per test run (cached across test files -
 * `go build` is deterministic and this package's tests may start many
 * agent processes from the same binary). Fails loudly (not a silent
 * skip) if `go build` fails - this package's core claim is untestable
 * without a real agent binary. */
export function buildAgentBinary(): string {
  if (cachedBinaryPath) return cachedBinaryPath;
  const outDir = mkdtempSync(path.join(tmpdir(), "wfx-agent-bin-"));
  const outPath = path.join(outDir, "agent");
  execFileSync("go", ["build", "-o", outPath, "."], { cwd: AGENT_MODULE_DIR, stdio: "pipe" });
  cachedBinaryPath = outPath;
  return outPath;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected an AddressInfo from an ephemeral TCP listener"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitUntilReachable(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // Any response (even a 400 for a garbage body) proves the HTTP
      // server is up - this package only needs "accepting connections",
      // not a real invocation.
      await fetch(`${baseUrl}/invoke`, { method: "POST", body: "{}" });
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`agent at ${baseUrl} never became reachable within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export interface TestAgent {
  baseUrl: string;
  stop(): Promise<void>;
}

export interface StartTestAgentOptions {
  /** Defaults to agent/testdata/fake-cli.sh. */
  execPath?: string;
  /** Merged onto (not replacing) process.env for the spawned agent -
   * e.g. FAKE_CLI_INVOCATIONS_FILE for T10's invocation-count assertion.
   * fake-cli.sh reads this from ITS OWN env, inherited from the agent
   * process's env (execrunner.go copies os.Environ() verbatim for every
   * subprocess it forks/execs). */
  env?: Record<string, string>;
}

export async function startTestAgent(options: StartTestAgentOptions = {}): Promise<TestAgent> {
  const binaryPath = buildAgentBinary();
  const execPath = options.execPath ?? FAKE_CLI_PATH;
  const port = await getFreePort();
  const stateDir = mkdtempSync(path.join(tmpdir(), "wfx-agent-state-"));

  const child: ChildProcess = spawn(
    binaryPath,
    ["--listen", `:${port}`, "--exec", execPath, "--state-dir", stateDir],
    { stdio: "pipe", env: { ...process.env, ...options.env } },
  );

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitUntilReachable(baseUrl, 10_000);

  return {
    baseUrl,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}
