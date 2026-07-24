import { useCallback, useSyncExternalStore } from "react";

import type { DesktopTheme } from "@app/contracts";

import { localApi } from "../localApi.ts";

const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME: DesktopTheme = "system";

function systemDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

/** Toggle the `.dark` class on <html> to match the effective theme. */
function applyTheme(theme: DesktopTheme): void {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark" || (theme === "system" && systemDark());
  document.documentElement.classList.toggle("dark", isDark);
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const mq =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(MEDIA_QUERY)
      : null;
  const onSystemChange = () => {
    if (localApi().getTheme() === "system") applyTheme("system");
    onChange();
  };
  mq?.addEventListener("change", onSystemChange);
  return () => {
    listeners.delete(onChange);
    mq?.removeEventListener("change", onSystemChange);
  };
}

function getSnapshot(): DesktopTheme {
  return localApi().getTheme();
}

/**
 * Theme state wired through `LocalApi.setTheme`, so a change persists to
 * localStorage (browser) AND syncs to the shell (bridge). Returns the stored
 * preference and a setter; the effective light/dark is applied to `<html>`.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_THEME);

  const setTheme = useCallback((next: DesktopTheme) => {
    void localApi().setTheme(next);
    applyTheme(next);
    emit();
  }, []);

  return { theme, setTheme } as const;
}
