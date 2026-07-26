import { describe, expect, it } from "vitest";
import { REDACT_CONFIG, logger } from "../src/logger.js";

// TC-8: scaffolding smoke test - no testcontainers needed (ADR-0009: pino +
// redact was already decided; this just confirms the shared instance is
// wired up as expected).
describe("logger", () => {
  it("is a pino instance", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("redacts at least one known secret-shaped field", () => {
    expect(REDACT_CONFIG.paths).toContain("*.token");
    expect(REDACT_CONFIG.paths).toContain("*.secret");
  });
});
