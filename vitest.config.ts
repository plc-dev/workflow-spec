import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // testcontainers pulls/starts a real Postgres per suite (ADR-0009) -
    // image pull + container start is slower than a typical unit test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
  },
});
