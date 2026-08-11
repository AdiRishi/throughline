import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopTheme = Schema.Literals(["light", "dark", "system"]);
export type DesktopTheme = typeof DesktopTheme.Type;

export const DesktopUpdateChannel = Schema.Literals(["latest", "nightly"]);
export type DesktopUpdateChannel = typeof DesktopUpdateChannel.Type;

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
  availableVersion: Schema.NullOr(Schema.String),
  downloadedVersion: Schema.NullOr(Schema.String),
  downloadPercent: Schema.NullOr(Schema.Number),
  checkedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  errorContext: Schema.NullOr(Schema.Literals(["check", "download", "install"])),
  canRetry: Schema.Boolean,
});
export type DesktopUpdateState = typeof DesktopUpdateState.Type;

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
