import type { DesktopUpdateChannel } from "@app/contracts";

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

/**
 * The channel a build belongs to, read off its own version. This is both the
 * default channel for a fresh install (a nightly build must not silently update
 * itself onto `latest`) and the filter applied to `update-available`: the
 * GitHub/generic providers happily offer a release from the other channel, and
 * accepting it would move the user across channels without asking.
 */
export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}
