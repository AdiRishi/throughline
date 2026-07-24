import type { DesktopTheme, LocalApi, PickFolderOptions } from "@app/contracts";

import { isElectron } from "./env.ts";

export const THEME_STORAGE_KEY = "app:theme";

function readStoredTheme(): DesktopTheme {
  if (typeof window === "undefined") return "system";
  try {
    const theme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (theme === "light" || theme === "dark" || theme === "system") return theme;
  } catch {
    // Storage may be unavailable.
  }
  return "system";
}

function storeTheme(theme: DesktopTheme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage may be unavailable; the shell remains authoritative on desktop.
  }
}

/**
 * The capability surface the renderer programs against. In the shell it
 * delegates to `window.desktopBridge`; in a plain browser it uses web fallbacks
 * (`localStorage`, `window.open`, `window.confirm`). Same web build, both hosts.
 */
function createLocalApi(): LocalApi {
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  let theme = bridge?.getTheme() ?? readStoredTheme();
  if (bridge) storeTheme(theme);

  return {
    isDesktop: isElectron,
    getAppInfo: () => bridge?.getAppInfo() ?? null,
    getTheme: () => (bridge ? theme : readStoredTheme()),

    setTheme: async (nextTheme: DesktopTheme) => {
      storeTheme(nextTheme);
      // Update before awaiting IPC so external-store subscribers can render
      // the selected value immediately.
      theme = nextTheme;
      if (bridge) {
        await bridge.setTheme(nextTheme);
      }
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
      // No native folder picker in a plain browser.
      return null;
    },

    onMenuAction: (listener) => {
      // Only the shell has a native menu; in a browser this is inert.
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
