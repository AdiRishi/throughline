import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopTheme = Schema.Literals(["light", "dark", "system"]);
export type DesktopTheme = typeof DesktopTheme.Type;

export const DesktopUpdateChannel = Schema.Literals(["latest", "nightly"]);
export type DesktopUpdateChannel = typeof DesktopUpdateChannel.Type;

/**
 * Coarse CPU architecture. `other` exists because the shell only ever needs to
 * distinguish the two architectures an update package can target; everything
 * else is a value it must carry without interpreting.
 */
export const DesktopRuntimeArch = Schema.Literals(["arm64", "x64", "other"]);
export type DesktopRuntimeArch = typeof DesktopRuntimeArch.Type;

/**
 * What the app is running *as* versus what the machine *is*. An x64 build on an
 * arm64 host (Rosetta) is a real, common state, and it changes how updates must
 * be fetched — see `setDisableDifferentialDownload` in the updater.
 */
export const DesktopRuntimeInfo = Schema.Struct({
  hostArch: DesktopRuntimeArch,
  appArch: DesktopRuntimeArch,
  runningUnderArm64Translation: Schema.Boolean,
});
export type DesktopRuntimeInfo = typeof DesktopRuntimeInfo.Type;

export const DesktopUpdateStatus = Schema.Literals([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
]);
export type DesktopUpdateStatus = typeof DesktopUpdateStatus.Type;

export const DesktopUpdateState = Schema.Struct({
  enabled: Schema.Boolean,
  status: DesktopUpdateStatus,
  channel: DesktopUpdateChannel,
  currentVersion: Schema.String,
  hostArch: DesktopRuntimeArch,
  appArch: DesktopRuntimeArch,
  runningUnderArm64Translation: Schema.Boolean,
  availableVersion: Schema.NullOr(Schema.String),
  downloadedVersion: Schema.NullOr(Schema.String),
  downloadPercent: Schema.NullOr(Schema.Number),
  checkedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  errorContext: Schema.NullOr(Schema.Literals(["check", "download", "install"])),
  canRetry: Schema.Boolean,
});
export type DesktopUpdateState = typeof DesktopUpdateState.Type;

/**
 * The answer to "did that do anything?". `accepted` is false when the shell
 * refused the request outright (wrong status, already in flight, updater not
 * configured); `completed` is false when it was accepted but did not finish —
 * install in particular never completes in-process, because a successful
 * install quits the app. Without these a caller cannot tell a refusal from a
 * success, and every button becomes a guess.
 */
export const DesktopUpdateActionResult = Schema.Struct({
  accepted: Schema.Boolean,
  completed: Schema.Boolean,
  state: DesktopUpdateState,
});
export type DesktopUpdateActionResult = typeof DesktopUpdateActionResult.Type;

export const DesktopUpdateCheckResult = Schema.Struct({
  checked: Schema.Boolean,
  state: DesktopUpdateState,
});
export type DesktopUpdateCheckResult = typeof DesktopUpdateCheckResult.Type;

export const DesktopAppInfo = Schema.Struct({
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  platform: Schema.Literals(["darwin", "win32", "linux"]),
  isPackaged: Schema.Boolean,
});
export type DesktopAppInfo = typeof DesktopAppInfo.Type;

export const DesktopServerBootstrap = Schema.Struct({
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
});
export type DesktopServerBootstrap = typeof DesktopServerBootstrap.Type;

export const PickFolderOptions = Schema.Struct({
  defaultPath: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
});
export type PickFolderOptions = typeof PickFolderOptions.Type;

export interface ContextMenuItem<T extends string = string> {
  readonly id: T;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly children?: readonly ContextMenuItem<T>[];
}

// `Schema.suspend` breaks inference, so a recursive schema needs the explicit
// annotation.
export const ContextMenuItemSchema: Schema.Codec<ContextMenuItem> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  destructive: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  children: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<ContextMenuItem> => ContextMenuItemSchema)),
  ),
});

export const ContextMenuPosition = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});
export type ContextMenuPosition = typeof ContextMenuPosition.Type;
