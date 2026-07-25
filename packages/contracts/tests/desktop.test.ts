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
    assert.notProperty(decoded, "header");
    assert.notProperty(decoded, "destructive");
    assert.notProperty(decoded, "disabled");
    assert.notProperty(decoded, "children");
  });

  it("preserves renderer-only section headers for host normalization", () => {
    assert.deepEqual(decodeMenuItem({ id: "heading", label: "Review", header: true }), {
      id: "heading",
      label: "Review",
      header: true,
    });
  });

  it("rejects malformed nested items", () => {
    assert.throws(() => decodeMenuItem({ id: "root", label: "Root", children: [{ id: 1 }] }));
  });
});

describe("DesktopUpdateState", () => {
  it("rejects an unknown status literal", () => {
    assert.throws(() =>
      decodeUpdateState({
        enabled: true,
        status: "installing",
        channel: "latest",
        currentVersion: "1.0.0",
        availableVersion: null,
        downloadedVersion: null,
        releaseNotes: [],
        downloadPercent: null,
        checkedAt: null,
        message: null,
        errorContext: null,
        canRetry: false,
      }),
    );
  });

  it("decodes the complete updater state used across IPC", () => {
    assert.deepEqual(
      decodeUpdateState({
        enabled: true,
        status: "downloading",
        channel: "nightly",
        currentVersion: "1.0.0",
        availableVersion: "1.1.0-nightly.20260725.1",
        downloadedVersion: null,
        releaseNotes: [
          {
            version: "1.1.0-nightly.20260725.1",
            items: ["Improves large journey rendering."],
          },
        ],
        downloadPercent: 42.5,
        checkedAt: "2026-07-25T12:00:00.000Z",
        message: null,
        errorContext: null,
        canRetry: false,
      }),
      {
        enabled: true,
        status: "downloading",
        channel: "nightly",
        currentVersion: "1.0.0",
        availableVersion: "1.1.0-nightly.20260725.1",
        downloadedVersion: null,
        releaseNotes: [
          {
            version: "1.1.0-nightly.20260725.1",
            items: ["Improves large journey rendering."],
          },
        ],
        downloadPercent: 42.5,
        checkedAt: "2026-07-25T12:00:00.000Z",
        message: null,
        errorContext: null,
        canRetry: false,
      },
    );
  });
});
