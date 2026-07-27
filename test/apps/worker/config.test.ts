import { describe, expect, it } from "vitest";
import { parseWorkerConfig } from "../../../src/apps/worker/config.js";

// T6 (docs/impl-plans/0011-worker-cli-dispatch.md): apps/worker/config.ts
// follows shared/config.ts's exact fail-closed pattern (best-practices.md
// #1), scoped to this app's own env vars.

const VALID_ENV = {
  DATABASE_URL: "postgres://wfx:wfx@localhost:5432/core",
  AGENT_INVOKE_BASE_URL: "http://127.0.0.1:9464",
};

describe("parseWorkerConfig", () => {
  it("fails closed when DATABASE_URL is missing", () => {
    const env = { ...VALID_ENV, DATABASE_URL: undefined };
    expect(() => parseWorkerConfig(env)).toThrow();
  });

  it("fails closed when AGENT_INVOKE_BASE_URL is missing", () => {
    const env = { ...VALID_ENV, AGENT_INVOKE_BASE_URL: undefined };
    expect(() => parseWorkerConfig(env)).toThrow();
  });

  it("fails closed when AGENT_INVOKE_BASE_URL is not a valid URL", () => {
    expect(() => parseWorkerConfig({ ...VALID_ENV, AGENT_INVOKE_BASE_URL: "not-a-url" })).toThrow();
  });

  it("applies documented defaults for every optional var when unset", () => {
    const config = parseWorkerConfig(VALID_ENV);
    expect(config).toEqual({
      databaseUrl: VALID_ENV.DATABASE_URL,
      agentInvokeBaseUrl: VALID_ENV.AGENT_INVOKE_BASE_URL,
      workerId: undefined,
      claimLeaseSeconds: 30,
      invokeTimeoutMs: 30_000,
      pollIntervalMs: 250,
    });
  });

  it("honors explicit overrides for every optional var", () => {
    const config = parseWorkerConfig({
      ...VALID_ENV,
      WORKER_ID: "worker-1",
      CLAIM_LEASE_SECONDS: "60",
      INVOKE_TIMEOUT_MS: "5000",
      POLL_INTERVAL_MS: "1000",
    });
    expect(config).toEqual({
      databaseUrl: VALID_ENV.DATABASE_URL,
      agentInvokeBaseUrl: VALID_ENV.AGENT_INVOKE_BASE_URL,
      workerId: "worker-1",
      claimLeaseSeconds: 60,
      invokeTimeoutMs: 5000,
      pollIntervalMs: 1000,
    });
  });

  it("rejects a non-positive CLAIM_LEASE_SECONDS", () => {
    expect(() => parseWorkerConfig({ ...VALID_ENV, CLAIM_LEASE_SECONDS: "0" })).toThrow();
  });
});
