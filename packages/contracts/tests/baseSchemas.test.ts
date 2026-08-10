import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  makeEntityId,
  NonNegativeInt,
  Port,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../src/baseSchemas.ts";

const decodeTrimmed = Schema.decodeUnknownSync(TrimmedNonEmptyString);
const encodeTrimmed = Schema.encodeSync(TrimmedNonEmptyString);
const decodePort = Schema.decodeUnknownSync(Port);
const decodeNonNegativeInt = Schema.decodeUnknownSync(NonNegativeInt);
const decodePositiveInt = Schema.decodeUnknownSync(PositiveInt);

// A stand-in for a wire union that a newer server has extended: this build
// knows two members, the newer one sends three.
const FeatureFlag = Schema.Literals(["clusters", "coverage"]);
const FeatureFlags = ForwardCompatibleArray(FeatureFlag);
const decodeFeatureFlags = Schema.decodeUnknownSync(FeatureFlags);
const encodeFeatureFlags = Schema.encodeSync(FeatureFlags);

const SampleId = makeEntityId("SampleId");
const decodeSampleId = Schema.decodeUnknownSync(SampleId);

describe("TrimmedNonEmptyString", () => {
  it("trims surrounding whitespace on decode", () => {
    assert.strictEqual(decodeTrimmed("  hi  "), "hi");
  });

  it("rejects empty and whitespace-only strings", () => {
    assert.throws(() => decodeTrimmed(""));
    assert.throws(() => decodeTrimmed("   "));
  });

  it("encodes trimmed values unchanged", () => {
    assert.strictEqual(encodeTrimmed("ok"), "ok");
  });

  it("rejects untrimmed values on encode instead of silently trimming", () => {
    // `Schema.Trim`'s Type side is refined to already-trimmed strings, so a
    // program value with stray whitespace is a bug — surfaced, not repaired.
    assert.throws(() => encodeTrimmed("  x  "));
  });
});

describe("NonNegativeInt", () => {
  it("accepts zero", () => {
    assert.strictEqual(decodeNonNegativeInt(0), 0);
  });

  it("rejects negatives and non-integers", () => {
    assert.throws(() => decodeNonNegativeInt(-1));
    assert.throws(() => decodeNonNegativeInt(1.5));
  });
});

describe("Port", () => {
  it("accepts the full valid range", () => {
    assert.strictEqual(decodePort(1), 1);
    assert.strictEqual(decodePort(65535), 65535);
  });

  it("rejects out-of-range and fractional ports", () => {
    assert.throws(() => decodePort(0));
    assert.throws(() => decodePort(65536));
    assert.throws(() => decodePort(8080.5));
  });
});

describe("PositiveInt", () => {
  it("accepts one and above", () => {
    assert.strictEqual(decodePositiveInt(1), 1);
    assert.strictEqual(decodePositiveInt(9000), 9000);
  });

  it("rejects zero, negatives, and non-integers", () => {
    assert.throws(() => decodePositiveInt(0));
    assert.throws(() => decodePositiveInt(-1));
    assert.throws(() => decodePositiveInt(1.5));
  });
});

describe("ForwardCompatibleArray", () => {
  it("decodes a newer-server payload by dropping members this build cannot decode", () => {
    // The whole point: an unknown member must not take down the payload (and
    // with it the connection) over data this client could not act on anyway.
    assert.deepStrictEqual(decodeFeatureFlags(["clusters", "journeys", "coverage"]), [
      "clusters",
      "coverage",
    ]);
  });

  it("decodes a fully-known payload unchanged", () => {
    assert.deepStrictEqual(decodeFeatureFlags(["clusters", "coverage"]), ["clusters", "coverage"]);
  });

  it("decodes to an empty array when no member is decodable", () => {
    assert.deepStrictEqual(decodeFeatureFlags(["journeys", 7, null]), []);
  });

  it("still rejects a payload that is not an array", () => {
    assert.throws(() => decodeFeatureFlags("clusters"));
  });

  it("encodes as the plain array encoding", () => {
    assert.deepStrictEqual(encodeFeatureFlags(["clusters", "coverage"]), ["clusters", "coverage"]);
  });
});

describe("makeEntityId", () => {
  it("produces a branded, trimmed, non-empty id", () => {
    assert.strictEqual(decodeSampleId("  abc  "), "abc");
    assert.throws(() => decodeSampleId("   "));
    assert.throws(() => decodeSampleId(42));
  });
});
