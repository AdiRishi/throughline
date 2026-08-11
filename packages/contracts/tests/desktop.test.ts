import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ContextMenuItemSchema, DesktopUpdateState } from "../src/desktop.ts";

const decodeMenuItem = Schema.decodeUnknownSync(ContextMenuItemSchema);
const decodeUpdateState = Schema.decodeUnknownSync(DesktopUpdateState);

describe("ContextMenuItemSchema", () => {
  it("decodes nested children recursively", () => {
    const decoded = decodeMenuItem({
      id: "root",
      label: "Root",
      children: [{ id: "child", label: "Child", children: [{ id: "leaf", label: "Leaf" }] }],
    });
    assert.strictEqual(decoded.children?.[0]?.children?.[0]?.id, "leaf");
  });

  it("keeps optional flags absent when not provided", () => {
    const decoded = decodeMenuItem({ id: "solo", label: "Solo" });
    assert.notProperty(decoded, "destructive");
    assert.notProperty(decoded, "disabled");
    assert.notProperty(decoded, "children");
  });

  it("rejects malformed nested items", () => {
    assert.throws(() => decodeMenuItem({ id: "root", label: "Root", children: [{ id: 1 }] }));
  });
});

const updateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("DesktopUpdateState", () => {
  it("rejects an unknown status literal", () => {
    assert.throws(() => decodeUpdateState({ ...updateState, status: "installing" }));
  });

  it("rejects an unknown error context", () => {
    assert.throws(() => decodeUpdateState({ ...updateState, errorContext: "poll" }));
  });

  it("rejects an unknown architecture", () => {
    assert.throws(() => decodeUpdateState({ ...updateState, hostArch: "riscv" }));
  });

  // The updater keys its differential-download guard off these, so an x64 build
  // on an arm64 host has to survive the round trip intact.
  it("carries a Rosetta runtime through decoding", () => {
    const decoded = decodeUpdateState({
      ...updateState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    });
    assert.strictEqual(decoded.hostArch, "arm64");
    assert.strictEqual(decoded.appArch, "x64");
    assert.isTrue(decoded.runningUnderArm64Translation);
  });

  it("accepts a fractional download percent alongside the populated version fields", () => {
    const decoded = decodeUpdateState({
      ...updateState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
      checkedAt: "2026-03-04T00:00:00.000Z",
    });
    assert.strictEqual(decoded.downloadPercent, 42.5);
    assert.strictEqual(decoded.availableVersion, "1.1.0");
  });
});
