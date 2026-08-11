import * as Schema from "effect/Schema";

import { DesktopTheme, type LocalApi, type PickFolderOptions } from "@app/contracts";

import { isElectron } from "./env.ts";

export const THEME_STORAGE_KEY = "app:theme";
export const DEFAULT_THEME: DesktopTheme = "system";

const isDesktopTheme = Schema.is(DesktopTheme);

/**
 * A `localStorage` read or write for the theme preference failed — private-mode
 * windows, a full quota, and a disabled-storage policy all land here.
 */
export class ThemeStorageError extends Schema.TaggedError<ThemeStorageError>()(
  "ThemeStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    storageKey: Schema.String,
    theme: Schema.optionalKey(DesktopTheme),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`;
  }
}

export const isThemeStorageError = Schema.is(ThemeStorageError);

export class DesktopThemeSyncError extends Schema.TaggedError<DesktopThemeSyncError>()(
  "DesktopThemeSyncError",
  {
    theme: DesktopTheme,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sync the ${this.theme} theme to the desktop shell.`;
  }
}

export const isDesktopThemeSyncError = Schema.is(DesktopThemeSyncError);

let themeStorageReadFailure: ThemeStorageError | null = null;

/**
 * A read that threw is latched: storage that refuses one read refuses the next
 * one too, and callers re-read on every render. Only the two things that prove
 * storage works again clear it — a successful write, or a storage event.
 *
 * The latch lives beside the write that clears it. Split across modules it
 * would survive a successful `writeThemePreference`, because a same-window
 * write emits no storage event.
 */
export function readLatchedThemePreference(
  onFirstFailure: (error: ThemeStorageError) => void,
): DesktopTheme {
  if (themeStorageReadFailure !== null) return DEFAULT_THEME;
  try {
    return readThemePreference();
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({ operation: "read", storageKey: THEME_STORAGE_KEY, cause });
    themeStorageReadFailure = error;
    onFirstFailure(error);
    return DEFAULT_THEME;
  }
}

export function clearThemeStorageReadFailure(): void {
  themeStorageReadFailure = null;
}

/** Read the persisted preference, or throw `ThemeStorageError` if storage is unreadable. */
export function readThemePreference(): DesktopTheme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: THEME_STORAGE_KEY,
      cause,
    });
  }
  if (raw !== null && isDesktopTheme(raw)) return raw;
  return DEFAULT_THEME;
}

/** Persist the preference, or throw `ThemeStorageError` if the write is refused. */
export function writeThemePreference(theme: DesktopTheme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    themeStorageReadFailure = null;
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: THEME_STORAGE_KEY,
      theme,
      cause,
    });
  }
}

/**
 * Hand the preference to the shell so the native chrome follows the web UI.
 * Inert in a plain browser; a rejected IPC call throws `DesktopThemeSyncError`.
 */
export async function syncDesktopThemePreference(theme: DesktopTheme): Promise<void> {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge || typeof bridge.setTheme !== "function") return;
  try {
    await bridge.setTheme(theme);
  } catch (cause) {
    throw new DesktopThemeSyncError({ theme, cause });
  }
}

/**
 * The capability surface the renderer programs against: the same web build runs
 * in the shell (delegating to `window.desktopBridge`) and in a plain browser
 * (falling back to `localStorage`, `window.open`, `window.confirm`).
 */
function createLocalApi(): LocalApi {
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;

  return {
    isDesktop: isElectron,

    setTheme: async (theme: DesktopTheme) => {
      // Persist in the browser so the pre-mount guard in index.html can read it.
      // Fails closed: a preference the store cannot hold must not reach the
      // shell, or the two disagree until the next reload.
      writeThemePreference(theme);
      await syncDesktopThemePreference(theme);
    },

    openExternal: async (url: string) => {
      if (bridge) {
        const opened = await bridge.openExternal(url);
        if (!opened) throw new Error("Unable to open the link.");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    },

    confirm: async (message: string) => {
      if (bridge) return bridge.confirm(message);
      return window.confirm(message);
    },

    pickFolder: async (options?: PickFolderOptions) => {
      if (bridge) return bridge.pickFolder(options);
      return null;
    },

    onMenuAction: (listener) => {
      if (bridge) return bridge.onMenuAction(listener);
      return () => {};
    },
  };
}

let cached: LocalApi | undefined;

export function localApi(): LocalApi {
  if (!cached) cached = createLocalApi();
  return cached;
}
