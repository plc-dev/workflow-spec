import { describe, expect, it } from "vitest";
import { DEFAULT_ERROR_MESSAGES, ERROR_IDS, FatalError, RetryableError } from "../src/errors.js";

describe("PlatformError subclasses", () => {
  it("carries a stable errorId separate from its default message", () => {
    const err = new FatalError(ERROR_IDS.CORE_ENQUEUE_NO_ROW_RETURNED);
    expect(err.errorId).toBe(ERROR_IDS.CORE_ENQUEUE_NO_ROW_RETURNED);
    expect(err.message).toBe(DEFAULT_ERROR_MESSAGES[ERROR_IDS.CORE_ENQUEUE_NO_ROW_RETURNED]);
    expect(err.name).toBe("FatalError");
  });

  it("passes context through for structured logging", () => {
    const err = new RetryableError(ERROR_IDS.CORE_CHECKPOINT_CONFLICT_NOT_FOUND, {
      context: { executionId: 42, stepId: "step-a" },
    });
    expect(err.context).toEqual({ executionId: 42, stepId: "step-a" });
    expect(err.name).toBe("RetryableError");
  });
});
