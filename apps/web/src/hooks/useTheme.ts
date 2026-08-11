import { useCallback, useSyncExternalStore } from "react";

import { safeErrorLogAttributes } from "@app/client-runtime/errors";
import type { DesktopTheme } from "@app/contracts";

import {
  clearThemeStorageReadFailure,
  DEFAULT_THEME,
  DesktopThemeSyncError,
  isDesktopThemeSyncError,
  isThemeStorageError,
  readLatchedThemePreference,
  syncDesktopThemePreference,
  THEME_STORAGE_KEY,
  ThemeStorageError,
  writeThemePreference,
} from "../localApi.ts";

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

const listeners = new Set<() => void>();
let lastSnapshot: DesktopTheme | null = null;
let snapshotStale = true;

function emit(): void {
  snapshotStale = true;
  for (const listener of listeners) listener();
}

function getStored(): DesktopTheme {
  return readLatchedThemePreference((error) => {
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
  });
}

function systemDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

function applyTheme(theme: DesktopTheme): void {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark" || (theme === "system" && systemDark());
  document.documentElement.classList.toggle("dark", isDark);
}

function handleSystemAppearanceChange(): void {
  if (getStored() === "system") applyTheme("system");
  emit();
}

function handleStorageChange(event: StorageEvent): void {
  // A `null` key means the whole store was cleared, so the preference went with
  // it. Anything else is another key's business.
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
  clearThemeStorageReadFailure();
  applyTheme(getStored());
  emit();
}

let removeWindowListeners: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.add(listener);

  // The system-preference and cross-window listeners are shared by all
  // subscribers; each event applies the theme once and notifies everyone.
  if (!removeWindowListeners) {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null;
    mq?.addEventListener("change", handleSystemAppearanceChange);
    window.addEventListener("storage", handleStorageChange);
    removeWindowListeners = () => {
      mq?.removeEventListener("change", handleSystemAppearanceChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      removeWindowListeners?.();
      removeWindowListeners = null;
    }
  };
}

function getSnapshot(): DesktopTheme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  // Reading the preference hits localStorage, so only recompute after a
  // change was signalled; useTheme consumers call this on every render.
  if (!snapshotStale && lastSnapshot !== null) return lastSnapshot;
  snapshotStale = false;
  lastSnapshot = getStored();
  return lastSnapshot;
}

function getServerSnapshot(): DesktopTheme {
  return DEFAULT_THEME;
}

/**
 * The stored preference, plus a setter that returns whether the preference was
 * recorded.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setTheme = useCallback((next: DesktopTheme): boolean => {
    if (typeof window === "undefined") return false;
    // Write first and abort on failure: applying a theme the store cannot hold
    // leaves `<html>` on one theme and every reader on the other.
    try {
      writeThemePreference(next);
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({
            operation: "write",
            storageKey: THEME_STORAGE_KEY,
            theme: next,
            cause,
          });
      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        theme: next,
        ...safeErrorLogAttributes(error),
      });
      return false;
    }

    // The shell handoff is cosmetic; a refused IPC call is reported rather than
    // left as an unhandled rejection.
    void syncDesktopThemePreference(next).catch((cause: unknown) => {
      const error = isDesktopThemeSyncError(cause)
        ? cause
        : new DesktopThemeSyncError({ theme: next, cause });
      console.error(error.message, {
        theme: error.theme,
        ...safeErrorLogAttributes(error),
      });
    });

    applyTheme(next);
    emit();
    return true;
  }, []);

  return { theme, setTheme } as const;
}
