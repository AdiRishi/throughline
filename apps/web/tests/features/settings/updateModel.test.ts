import { describe, expect, it } from "vitest";

import type { DesktopUpdateState } from "@app/contracts";

import {
  canChangeUpdateChannel,
  updateAction,
  updateActionLabel,
  updateInstallConfirmation,
  updateStatusDescription,
} from "../../../src/features/settings/updateModel.ts";

const state = (overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  enabled: true,
  status: "idle",
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
  ...overrides,
});

describe("desktop update settings model", () => {
  it("maps each durable updater state to the action a user can take", () => {
    expect(updateAction(state())).toBe("check");
    expect(updateAction(state({ status: "available", availableVersion: "1.1.0" }))).toBe(
      "download",
    );
    expect(
      updateAction(
        state({
          status: "available",
          availableVersion: "1.1.0",
          message: "Download failed.",
          errorContext: "download",
          canRetry: true,
        }),
      ),
    ).toBe("download");
    expect(
      updateAction(
        state({
          status: "downloaded",
          availableVersion: "1.1.0",
          downloadedVersion: "1.1.0",
        }),
      ),
    ).toBe("install");
    expect(updateAction(state({ enabled: false, status: "disabled" }))).toBe("none");
    expect(
      updateAction(
        state({
          status: "error",
          message: "The updater stopped unexpectedly.",
          errorContext: null,
        }),
      ),
    ).toBe("check");
  });

  it("keeps progress and recovery guidance visible", () => {
    const downloading = state({
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.8,
    });
    expect(updateActionLabel(downloading)).toBe("Downloading 42%");
    expect(updateStatusDescription(downloading)).toBe("Downloaded 42%.");
    expect(canChangeUpdateChannel(downloading)).toBe(false);

    const failedDownload = state({
      status: "available",
      availableVersion: "1.1.0",
      message: "Throughline could not download the update. Try again.",
      errorContext: "download",
      canRetry: true,
    });
    expect(updateActionLabel(failedDownload)).toBe("Download update");
    expect(updateStatusDescription(failedDownload)).toBe(
      "Throughline could not download the update. Try again.",
    );
  });

  it("names the downloaded version in the destructive restart confirmation", () => {
    const downloaded = state({
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    });
    expect(canChangeUpdateChannel(downloaded)).toBe(false);
    expect(updateInstallConfirmation(downloaded)).toContain("update 1.1.0");
    expect(updateInstallConfirmation(downloaded)).toContain("analysis still running");
  });
});
