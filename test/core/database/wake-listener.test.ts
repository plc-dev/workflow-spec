import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type WakeListener, createWakeListener, withTransaction } from "../../../src/core/index.js";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";

// TC-9 (docs/impl-plans/0002-durable-sleep.md): WakeListener tested as
// the standalone primitive it is - no poll-loop consumer exists yet
// (Scope explicitly excludes wiring it up). Real LISTEN/NOTIFY semantics,
// so this stays on testcontainers like every other test in this package.
describe("core.createWakeListener", () => {
  let tp: TestPostgres;
  let listener: WakeListener | undefined;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterEach(async () => {
    await listener?.close();
    listener = undefined;
  });

  afterAll(async () => {
    await tp.stop();
  });

  it("fires onNotify with the signaled wait key when signal_wait() runs", async () => {
    listener = await createWakeListener({ connectionString: tp.pool.options.connectionString });

    const received: string[] = [];
    const unsubscribe = listener.onNotify((payload) => received.push(payload));

    await withTransaction(tp.pool, (repos) => repos.waits.signal("wake-listener-test-key"));

    // pg_notify delivery is asynchronous relative to the notifying
    // transaction's COMMIT - poll briefly rather than asserting
    // synchronously.
    await waitUntil(() => received.length > 0);

    expect(received).toEqual(["wake-listener-test-key"]);
    unsubscribe();
  });

  // Review finding (docs/impl-plans/0002-durable-sleep.md): a dropped
  // connection must not crash the process (no unhandled 'error' event) -
  // this is the actual regression test for that fix. If createWakeListener
  // regressed to having no `error` listener, terminating its backend
  // would throw an unhandled exception and this whole test process would
  // crash rather than this test merely failing an assertion.
  it("does not crash the process when its connection is forcibly terminated", async () => {
    const applicationName = "wake-listener-crash-test";
    listener = await createWakeListener({
      connectionString: tp.pool.options.connectionString,
      application_name: applicationName,
    });

    const { rows } = await tp.adminPool.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE application_name = $1",
      [applicationName],
    );
    const pid = rows[0]?.pid;
    expect(pid).toBeDefined();
    await tp.adminPool.query("SELECT pg_terminate_backend($1)", [pid]);

    // Give the 'error' event a moment to fire and be handled internally.
    await sleep(200);

    // No unhandled exception crashed the process (this line is reached at
    // all), and cleanup still completes without throwing even though the
    // underlying connection is already dead.
    await expect(listener.close()).resolves.toBeUndefined();
    listener = undefined;
  });

  it("stops delivering notifications after unsubscribe, and after close", async () => {
    listener = await createWakeListener({ connectionString: tp.pool.options.connectionString });

    const received: string[] = [];
    const unsubscribe = listener.onNotify((payload) => received.push(payload));
    unsubscribe();

    await withTransaction(tp.pool, (repos) => repos.waits.signal("after-unsubscribe-key"));
    await sleep(200);
    expect(received).toEqual([]);

    await listener.close();
    // A closed listener's underlying connection is ended - a further
    // notification (from a still-open, separate connection) has no
    // subscriber left to reach in-process either way.
    await withTransaction(tp.pool, (repos) => repos.waits.signal("after-close-key"));
    await sleep(200);
    expect(received).toEqual([]);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: predicate did not become true within the timeout");
    }
    await sleep(20);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
