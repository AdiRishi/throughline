import { describe, expect, it } from "@effect/vitest";

import { safeErrorLogAttributes } from "../../src/errors/safeLog.ts";

describe("safeErrorLogAttributes", () => {
  it("keeps correlation and stack frames without serializing messages or nested causes", () => {
    const cause = Object.assign(new Error("nested-cause-secret-sentinel"), {
      traceId: "trace-safe-123",
    });
    const error = Object.assign(new Error("outer-error-secret-sentinel", { cause }), {
      _tag: "ConnectionTransientError",
    });
    error.stack = [
      "ConnectionTransientError: outer-error-secret-sentinel",
      "    at connect (https://user:password@example.com/connection.ts?token=secret#fragment)",
    ].join("\n");

    const attributes = safeErrorLogAttributes(error);

    expect(attributes).toMatchObject({
      errorType: "error",
      errorName: "Error",
      errorTag: "ConnectionTransientError",
      traceId: "trace-safe-123",
      stack: "    at connect (https://example.com/connection.ts)",
    });
    const diagnosticText = Object.values(attributes).map(String).join("\n");
    expect(diagnosticText).not.toContain("outer-error-secret-sentinel");
    expect(diagnosticText).not.toContain("nested-cause-secret-sentinel");
    expect(diagnosticText).not.toContain("user:password");
    expect(diagnosticText).not.toContain("token=secret");
  });

  it("caps the number of retained stack frames", () => {
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      ...Array.from({ length: 64 }, (_, index) => `    at frame${index} (file:///app/frame.ts)`),
    ].join("\n");

    const attributes = safeErrorLogAttributes(error);

    expect(attributes.stack?.split("\n")).toHaveLength(32);
  });

  it("does not trust arbitrary object messages or tags", () => {
    const attributes = safeErrorLogAttributes({
      _tag: "payload-secret-sentinel",
      message: "message-secret-sentinel",
      cause: { traceId: "trace id with unsafe whitespace" },
    });

    expect(attributes).toEqual({ errorType: "object" });
  });

  it("skips an unsafe outer trace id when a nested safe trace id is available", () => {
    const attributes = safeErrorLogAttributes({
      traceId: "unsafe trace id",
      cause: { traceId: "trace-safe-inner" },
    });

    expect(attributes).toEqual({
      errorType: "object",
      traceId: "trace-safe-inner",
    });
  });

  it("classifies non-error values without serializing them", () => {
    expect(safeErrorLogAttributes(null)).toEqual({ errorType: "null" });
    expect(safeErrorLogAttributes(["secret-sentinel"])).toEqual({ errorType: "array" });
    expect(safeErrorLogAttributes("secret-sentinel")).toEqual({ errorType: "primitive" });
  });

  it("terminates on cyclic causes", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;

    expect(safeErrorLogAttributes(error)).toEqual({ errorType: "object" });
  });
});
