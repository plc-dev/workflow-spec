import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

// No testcontainers needed - config parsing has no I/O beyond reading the
// env object it's handed.
describe("config.parseConfig", () => {
  it("defaults LOG_LEVEL to 'info' when unset", () => {
    expect(parseConfig({}).logLevel).toBe("info");
  });

  it("accepts a valid LOG_LEVEL", () => {
    expect(parseConfig({ LOG_LEVEL: "debug" }).logLevel).toBe("debug");
  });

  it("fails closed on an invalid LOG_LEVEL rather than silently defaulting", () => {
    expect(() => parseConfig({ LOG_LEVEL: "not-a-real-level" })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
