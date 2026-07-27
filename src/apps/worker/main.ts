import { hostname } from "node:os";
import { pid } from "node:process";
import { createPool, logger } from "../../shared/index.js";
import { parseWorkerConfig } from "./config.js";
import { runWorkerLoop } from "./worker-loop.js";

// docs/impl-plans/0011-worker-cli-dispatch.md - apps/worker's entrypoint
// (ADR-0012's lint-rule note names `apps/*/main.ts` explicitly). Parses
// this app's OWN config at its own startup (see config.ts's comment on
// why DATABASE_URL lives here, not src/shared/config.ts), builds one
// pool for the lifetime of the process, and drains gracefully on
// SIGTERM/SIGINT - finish whatever runOnce() call is in flight, then
// exit, mirroring agent/main.go's own PID-1 graceful-shutdown posture.

function generateWorkerId(): string {
  return `${hostname()}:${pid}`;
}

async function main(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  const workerId = config.workerId ?? generateWorkerId();
  const pool = createPool({ connectionString: config.databaseUrl });
  // Local-review fix (docs/impl-plans/0011-worker-cli-dispatch.md): `pg`
  // emits an 'error' event on the pool when an IDLE client's connection
  // dies (DB restart, failover, an admin kill) - with no listener,
  // Node treats that as an uncaught exception and kills this long-lived
  // process outright, bypassing the graceful-shutdown path below
  // entirely. Logging and letting the pool recover is the correct
  // behavior for a worker meant to stay up across routine DB blips.
  pool.on("error", (err) => {
    logger.error({ err }, "apps.worker.main.pool_error");
  });

  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  logger.info(
    { workerId, agentInvokeBaseUrl: config.agentInvokeBaseUrl },
    "apps.worker.main.start",
  );

  try {
    await runWorkerLoop(
      pool,
      {
        agentBaseUrl: config.agentInvokeBaseUrl,
        agentAuthToken: config.agentAuthToken,
        workerId,
        leaseSeconds: config.claimLeaseSeconds,
        invokeTimeoutMs: config.invokeTimeoutMs,
      },
      { pollIntervalMs: config.pollIntervalMs, signal: controller.signal },
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.fatal({ err }, "apps.worker.main.fatal");
  process.exitCode = 1;
});
