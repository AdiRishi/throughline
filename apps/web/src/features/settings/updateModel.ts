import type { DesktopUpdateState } from "@app/contracts";

export type UpdateAction = "check" | "download" | "install" | "none";

export function updateAction(state: DesktopUpdateState): UpdateAction {
  if (!state.enabled) return "none";
  if (state.downloadedVersion !== null) return "install";
  if (state.status === "available") return "download";
  if (state.status === "error" && state.errorContext === "download") return "download";
  if (state.status === "idle" || state.status === "up-to-date" || state.status === "error") {
    return "check";
  }
  return "none";
}

export function updateActionLabel(state: DesktopUpdateState): string {
  const action = updateAction(state);
  if (action === "download") return "Download update";
  if (action === "install") return "Install and restart";
  if (action === "check") return "Check for updates";
  if (state.status === "checking") return "Checking…";
  if (state.status === "downloading") {
    return state.downloadPercent === null
      ? "Downloading…"
      : `Downloading ${Math.floor(state.downloadPercent)}%`;
  }
  return "Updates unavailable";
}

export function updateStatusDescription(state: DesktopUpdateState): string {
  if (!state.enabled) {
    return state.message ?? "Updates are unavailable in this build.";
  }
  if (state.message !== null) return state.message;
  if (state.status === "idle") return "Throughline checks quietly after startup.";
  if (state.status === "checking") return "Looking for a newer release.";
  if (state.status === "up-to-date") return "This is the newest release on the selected channel.";
  if (state.status === "available") {
    return `Version ${state.availableVersion ?? "available"} is ready to download.`;
  }
  if (state.status === "downloading") {
    return state.downloadPercent === null
      ? "Downloading the update."
      : `Downloaded ${Math.floor(state.downloadPercent)}%.`;
  }
  if (state.status === "downloaded") {
    return `Version ${state.downloadedVersion ?? state.availableVersion ?? "available"} is ready to install.`;
  }
  return state.message ?? "The updater stopped unexpectedly. Try again.";
}

export function canChangeUpdateChannel(state: DesktopUpdateState): boolean {
  return (
    state.downloadedVersion === null &&
    state.status !== "checking" &&
    state.status !== "downloading"
  );
}

export function updateInstallConfirmation(state: DesktopUpdateState): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Install update${version === null ? "" : ` ${version}`} and restart Throughline?\n\nAny analysis still running will be interrupted.`;
}
