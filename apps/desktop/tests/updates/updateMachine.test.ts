import { assert, describe, it } from "@effect/vitest";

import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "../../src/updates/updateMachine.ts";

describe("desktop update state machine", () => {
  it("preserves the available release across a failed download so it can be retried", () => {
    const initial = {
      ...createInitialDesktopUpdateState("1.0.0", "latest"),
      enabled: true,
      status: "idle" as const,
    };
    const available = reduceDesktopUpdateStateOnUpdateAvailable(
      initial,
      "1.1.0",
      "2026-07-25T12:00:00.000Z",
    );
    const downloading = reduceDesktopUpdateStateOnDownloadStart(available);
    const failed = reduceDesktopUpdateStateOnDownloadFailure(
      downloading,
      "Throughline could not download the update. Try again.",
    );

    assert.equal(failed.status, "available");
    assert.equal(failed.availableVersion, "1.1.0");
    assert.equal(failed.errorContext, "download");
    assert.isTrue(failed.canRetry);
  });

  it("keeps a downloaded update installable after an install failure", () => {
    const initial = {
      ...createInitialDesktopUpdateState("1.0.0", "latest"),
      enabled: true,
      status: "downloading" as const,
      availableVersion: "1.1.0",
    };
    const downloaded = reduceDesktopUpdateStateOnDownloadComplete(initial, "1.1.0");
    const failed = reduceDesktopUpdateStateOnInstallFailure(
      downloaded,
      "Throughline could not install the downloaded update. Try again.",
    );

    assert.equal(failed.status, "downloaded");
    assert.equal(failed.downloadedVersion, "1.1.0");
    assert.equal(failed.downloadPercent, 100);
    assert.equal(failed.errorContext, "install");
    assert.isTrue(failed.canRetry);
  });
});
