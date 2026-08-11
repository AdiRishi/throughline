import { assert, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  decodeJsonResult,
  decodeUnknownJsonResult,
  extractJsonObject,
  formatSchemaError,
  fromJsonStringPretty,
  fromLenientJson,
} from "../src/schemaJson.ts";

const decodeLenientJson = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));

describe("extractJsonObject", () => {
  it("extracts a balanced JSON object from surrounding text", () => {
    expect(
      extractJsonObject(`Sure, here is the JSON:
\`\`\`json
{
  "subject": "Update README",
  "body": ""
}
\`\`\`
Done.`),
    ).toBe(`{
  "subject": "Update README",
  "body": ""
}`);
  });

  it("ignores braces inside strings while finding the object boundary", () => {
    expect(
      extractJsonObject('prefix {"message":"literal } brace","nested":{"ok":true}} suffix'),
    ).toBe('{"message":"literal } brace","nested":{"ok":true}}');
  });

  it("returns trimmed input when no JSON object starts", () => {
    expect(extractJsonObject("  no structured output  ")).toBe("no structured output");
  });
});

// Settings files are hand-editable, so a `//` note or a trailing comma left by
// a human must not reset every setting to its default.
describe("fromLenientJson", () => {
  it("decodes JSON with comments and trailing commas", () => {
    expect(
      decodeLenientJson(`{
        // Comments are valid in settings files.
        "enabled": true,
        "values": [1, 2,],
      }`),
    ).toEqual({
      enabled: true,
      values: [1, 2],
    });
  });

  it("strips block comments", () => {
    expect(decodeLenientJson('{ /* why */ "enabled": true }')).toEqual({ enabled: true });
  });

  it("rejects malformed JSON after lenient preprocessing", () => {
    expect(() => decodeLenientJson('{ "enabled": true,, }')).toThrow(
      /Expected a valid JSON string/,
    );
  });

  it("preserves commas before brackets inside string values", () => {
    // A comma inside a string value that happens to precede `}`/`]` must not
    // be stripped as if it were a trailing comma.
    expect(decodeLenientJson('{"note":"a,]"}')).toEqual({ note: "a,]" });
    expect(decodeLenientJson('{"list":["x,}"]}')).toEqual({ list: ["x,}"] });
    // Genuine trailing commas are still removed.
    expect(decodeLenientJson('{"values":[1, 2,],}')).toEqual({ values: [1, 2] });
  });

  it("preserves comment-like sequences inside string values", () => {
    expect(decodeLenientJson('{"url":"https://example.com"}')).toEqual({
      url: "https://example.com",
    });
  });
});

/** Narrow to the failure cause so assertions stay unconditional. */
const failureCause = <A>(
  result: Result.Result<A, Cause.Cause<Schema.SchemaError>>,
): Cause.Cause<Schema.SchemaError> => {
  assert.isTrue(Result.isFailure(result), "expected a decoding failure");
  if (!Result.isFailure(result)) {
    throw new Error("expected a decoding failure");
  }
  return result.failure;
};

describe("formatSchemaError", () => {
  it("formats schema failures with paths without exposing invalid values", () => {
    const decodeCredential = decodeJsonResult(Schema.Struct({ token: Schema.Finite }));
    const decoded = decodeCredential('{"token":"credential=secret-value"}');

    expect(formatSchemaError(failureCause(decoded))).toBe('Invalid type\n  at ["token"]');
  });

  it("preserves nested paths reported by schema filters", () => {
    const decode = decodeJsonResult(
      Schema.String.check(
        Schema.makeFilter(() => ({
          path: ["session", "token"],
          issue: "credential is invalid",
        })),
      ),
    );
    const diagnostic = formatSchemaError(failureCause(decode('"credential=secret-value"')));

    expect(diagnostic).toBe('Invalid value\n  at ["session"]["token"]');
    expect(diagnostic).not.toContain("credential=secret-value");
  });

  it("does not expose malformed JSON input in diagnostics", () => {
    const decode = decodeUnknownJsonResult(Schema.Unknown);
    const diagnostic = formatSchemaError(
      failureCause(decode('{"token":"credential=secret-value",,}')),
    );

    expect(diagnostic).not.toContain("credential=secret-value");
  });

  it("summarizes unexpected defects without serializing their messages", () => {
    const diagnostic = formatSchemaError(Cause.die(new Error("credential=secret-value")));

    expect(diagnostic).toBe(
      "Schema validation failed (failureCount=0, defectCount=1, interruptionCount=0).",
    );
  });

  it("bounds the number of formatted schema issues", () => {
    const decode = decodeJsonResult(Schema.Struct({ token: Schema.Finite }));
    const failures: Array<Cause.Cause<Schema.SchemaError>> = [];
    for (let index = 0; index < 10; index += 1) {
      const decoded = decode(`{"token":"credential=secret-value-${index}"}`);
      if (Result.isFailure(decoded)) {
        failures.push(decoded.failure);
      }
    }

    const cause = Cause.fromReasons(failures.flatMap((cause) => cause.reasons));
    const diagnostic = formatSchemaError(cause);
    expect(diagnostic.match(/Invalid type/g)).toHaveLength(8);
    expect(diagnostic).toContain("... and 2 more issue(s)");
  });

  it("retains the omitted issue count when bounding long diagnostics", () => {
    const longPath = Array.from({ length: 16 }, (_, index) => `${index}-${"segment".repeat(16)}`);
    const decode = decodeJsonResult(
      Schema.String.check(
        Schema.makeFilter(() => ({ path: longPath, issue: "credential is invalid" })),
      ),
    );
    const failures: Array<Cause.Cause<Schema.SchemaError>> = [];
    for (let index = 0; index < 10; index += 1) {
      const decoded = decode(`"credential=secret-value-${index}"`);
      if (Result.isFailure(decoded)) {
        failures.push(decoded.failure);
      }
    }

    const cause = Cause.fromReasons(failures.flatMap((cause) => cause.reasons));
    const diagnostic = formatSchemaError(cause);
    expect(diagnostic.length).toBeLessThanOrEqual(2_048);
    expect(diagnostic.endsWith("\n... and 2 more issue(s)")).toBe(true);
  });
});

const PrettySchema = fromJsonStringPretty(Schema.Struct({ a: Schema.Finite, b: Schema.String }));
const decodePretty = Schema.decodeUnknownSync(PrettySchema);
const encodePretty = Schema.encodeSync(PrettySchema);

describe("fromJsonStringPretty", () => {
  it("decodes like Schema.fromJsonString", () => {
    assert.deepStrictEqual(decodePretty('{"a":1,"b":"x"}'), { a: 1, b: "x" });
  });

  it("encodes with stable 2-space formatting", () => {
    assert.strictEqual(encodePretty({ a: 1, b: "x" }), '{\n  "a": 1,\n  "b": "x"\n}');
  });
});
