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

// Read from the resolved palette rather than hardcoded, so the browser chrome
// can never drift from `index.css`.
function resolvedBackgroundColor(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-background")
    .trim();
  return value.length > 0 ? value : "#ffffff";
}

/**
 * Point the UA's own surfaces at the app's background. `theme-color` drives the
 * mobile browser toolbar and the PWA status bar; the inline background on
 * `<html>` covers overscroll rubber-banding, which paints outside `body`.
 */
function syncBrowserChromeTheme(): void {
  const color = resolvedBackgroundColor();
  document.documentElement.style.backgroundColor = color;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.setAttribute("content", color);
    // A media-scoped meta only applies under that query; once we are setting
    // the colour ourselves the scoping would keep the stale value winning.
    meta.removeAttribute("media");
  }
}

function applyTheme(theme: DesktopTheme): void {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark" || (theme === "system" && systemDark());
  const root = document.documentElement;
  const changed = root.classList.contains("dark") !== isDark;

  if (changed) {
    root.classList.add("no-transitions");
  }
  root.classList.toggle("dark", isDark);
  syncBrowserChromeTheme();
  if (changed) {
    // Force a style flush so the new palette is committed with transitions
    // still suppressed, then drop the suppression on the next frame.
    void root.offsetHeight;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        root.classList.remove("no-transitions");
      });
    } else {
      root.classList.remove("no-transitions");
    }
  }
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
