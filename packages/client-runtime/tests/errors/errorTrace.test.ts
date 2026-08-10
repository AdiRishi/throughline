import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";

import { findErrorTraceId } from "../../src/errors/errorTrace.ts";

describe("findErrorTraceId", () => {
  it("finds trace metadata through wrapped typed errors", () => {
    expect(
      findErrorTraceId({
        cause: {
          cause: {
            _tag: "ConnectionTransientError",
            traceId: "trace-connection",
          },
        },
      }),
    ).toBe("trace-connection");
  });

  it("terminates for cyclic causes", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;

    expect(findErrorTraceId(error)).toBeNull();
  });

  it("finds trace metadata in Effect cause branches", () => {
    const cause = Cause.fromReasons<unknown>([
      Cause.makeFailReason(new Error("first failure")),
      Cause.makeFailReason({ traceId: "trace-secondary" }),
    ]);

    expect(findErrorTraceId(cause)).toBe("trace-secondary");
  });

  it("finds trace metadata in aggregate error branches", () => {
    const error = new AggregateError(
      [new Error("first failure"), { traceId: "trace-aggregate" }],
      "request failed",
    );

    expect(findErrorTraceId(error)).toBe("trace-aggregate");
  });

  it("returns null when no trace metadata is present", () => {
    expect(findErrorTraceId(new Error("no trace"))).toBeNull();
    expect(findErrorTraceId({ traceId: "   " })).toBeNull();
    expect(findErrorTraceId(undefined)).toBeNull();
  });
});
