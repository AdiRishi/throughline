import { assert, describe, it } from "@effect/vitest";

import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "../../src/updates/updateMachine.ts";

describe("updateMachine", () => {
  it("clears transient errors when a check starts", () => {
    const state = reduceDesktopUpdateStateOnCheckStart(
      {
        ...createInitialDesktopUpdateState("1.0.0", "latest"),
        enabled: true,
        status: "error",
        message: "network",
        errorContext: "check",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    assert.strictEqual(state.status, "checking");
    assert.isNull(state.message);
    assert.isNull(state.errorContext);
    assert.isFalse(state.canRetry);
  });

  it("records a check failure without exposing an action", () => {
    const state = reduceDesktopUpdateStateOnCheckFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", "latest"),
        enabled: true,
        status: "checking",
      },
      "network unavailable",
      "2026-03-04T00:00:00.000Z",
    );

    assert.strictEqual(state.status, "error");
    assert.strictEqual(state.errorContext, "check");
    assert.isTrue(state.canRetry);
  });

  it("preserves available version on download failure for retry", () => {
    const state = reduceDesktopUpdateStateOnDownloadFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 43,
      },
      "checksum mismatch",
    );

    assert.strictEqual(state.status, "available");
    assert.strictEqual(state.availableVersion, "1.1.0");
    assert.strictEqual(state.errorContext, "download");
    assert.isTrue(state.canRetry);
  });

  it("transitions to downloaded and then preserves install retry state", () => {
    const downloaded = reduceDesktopUpdateStateOnDownloadComplete(
      {
        ...createInitialDesktopUpdateState("1.0.0", "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
      },
      "1.1.0",
    );
    const failedInstall = reduceDesktopUpdateStateOnInstallFailure(
      downloaded,
      "backend shutdown timed out",
    );

    assert.strictEqual(downloaded.status, "downloaded");
    assert.strictEqual(downloaded.downloadedVersion, "1.1.0");
    assert.strictEqual(failedInstall.status, "downloaded");
    assert.strictEqual(failedInstall.errorContext, "install");
    assert.isTrue(failedInstall.canRetry);
  });

  it("clears stale download state when no update is available", () => {
    const state = reduceDesktopUpdateStateOnNoUpdate(
      {
        ...createInitialDesktopUpdateState("1.0.0", "latest"),
        enabled: true,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        message: "old failure",
        errorContext: "download",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    assert.strictEqual(state.status, "up-to-date");
    assert.isNull(state.availableVersion);
    assert.isNull(state.downloadedVersion);
    assert.isNull(state.message);
    assert.isNull(state.errorContext);
  });

  it("tracks available, download start, and progress cleanly", () => {
    const available = reduceDesktopUpdateStateOnUpdateAvailable(
      {
        ...createInitialDesktopUpdateState("1.0.0", "latest"),
        enabled: true,
        status: "checking",
      },
      "1.1.0",
      "2026-03-04T00:00:00.000Z",
    );
    const downloading = reduceDesktopUpdateStateOnDownloadStart(available);
    const progress = reduceDesktopUpdateStateOnDownloadProgress(downloading, 55.5);

    assert.strictEqual(available.status, "available");
    assert.strictEqual(available.channel, "latest");
    assert.strictEqual(downloading.status, "downloading");
    assert.strictEqual(downloading.downloadPercent, 0);
    assert.strictEqual(progress.downloadPercent, 55.5);
    assert.isNull(progress.errorContext);
  });
});
