import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ServerBootstrapEnvelope, ServerLifecycleStreamEvent } from "../src/server.ts";

const decodeEnvelope = Schema.decodeUnknownSync(ServerBootstrapEnvelope);
const encodeEnvelope = Schema.encodeSync(ServerBootstrapEnvelope);
const decodeLifecycle = Schema.decodeUnknownSync(Schema.toCodecJson(ServerLifecycleStreamEvent));

describe("ServerBootstrapEnvelope", () => {
  it("decodes without a port and keeps the key absent through a roundtrip", () => {
    const decoded = decodeEnvelope({ desktopBootstrapToken: "boot-token" });
    assert.notProperty(decoded, "port");
    assert.notProperty(encodeEnvelope(decoded), "port");
  });

  it("accepts a valid forced port", () => {
    const decoded = decodeEnvelope({ desktopBootstrapToken: "boot-token", port: 13773 });
    assert.strictEqual(decoded.port, 13773);
  });

  it("rejects out-of-range ports and blank tokens", () => {
    assert.throws(() => decodeEnvelope({ desktopBootstrapToken: "boot-token", port: 0 }));
    assert.throws(() => decodeEnvelope({ desktopBootstrapToken: "  " }));
  });
});

describe("ServerLifecycleStreamEvent", () => {
  it("decodes an ordered lifecycle event on the JSON wire", () => {
    const event = decodeLifecycle({
      version: 1,
      sequence: 2,
      phase: "ready",
      at: "2026-07-03T00:00:00.000Z",
    });

    assert.strictEqual(event.sequence, 2);
    assert.strictEqual(event.phase, "ready");
  });

  it("rejects invalid sequence, version, and phase values", () => {
    const valid = {
      version: 1,
      sequence: 2,
      phase: "ready",
      at: "2026-07-03T00:00:00.000Z",
    };

    assert.throws(() => decodeLifecycle({ ...valid, sequence: -1 }));
    assert.throws(() => decodeLifecycle({ ...valid, version: 2 }));
    assert.throws(() => decodeLifecycle({ ...valid, phase: "stopped" }));
  });
});
