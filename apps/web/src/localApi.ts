import type {
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateState,
  LocalApi,
  PickFolderOptions,
} from "@app/contracts";

import { isElectron } from "./env.ts";

export const THEME_STORAGE_KEY = "app:theme";

const BROWSER_UPDATE_STATE: DesktopUpdateState = {
  enabled: false,
  status: "disabled",
  channel: "latest",
  currentVersion: "Browser",
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  downloadPercent: null,
  checkedAt: null,
  message: "Application updates are managed by the installed Throughline desktop app.",
  errorContext: null,
  canRetry: false,
};

function unavailableBrowserUpdateAction(): DesktopUpdateActionResult {
  return {
    accepted: false,
    completed: false,
    state: BROWSER_UPDATE_STATE,
  };
}

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
    getWindowFullscreenState: () => {
      const getWindowFullscreenState = bridge?.getWindowFullscreenState;
      return typeof getWindowFullscreenState === "function" ? getWindowFullscreenState() : false;
    },

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

    openLogsFolder: async () => {
      if (bridge) return bridge.openLogsFolder();
      return false;
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

    getUpdateState: async () => bridge?.getUpdateState() ?? BROWSER_UPDATE_STATE,
    setUpdateChannel: async (channel) => {
      if (bridge) return bridge.setUpdateChannel(channel);
      return { ...BROWSER_UPDATE_STATE, channel };
    },
    checkForUpdate: async () =>
      bridge?.checkForUpdate() ?? {
        checked: false,
        state: BROWSER_UPDATE_STATE,
      },
    downloadUpdate: async () => bridge?.downloadUpdate() ?? unavailableBrowserUpdateAction(),
    installUpdate: async () => bridge?.installUpdate() ?? unavailableBrowserUpdateAction(),
    onUpdateState: (listener) => {
      if (bridge) return bridge.onUpdateState(listener);
      return () => {};
    },

    onMenuAction: (listener) => {
      // Only the shell has a native menu; in a browser this is inert.
      if (bridge) return bridge.onMenuAction(listener);
      return () => {};
    },
    onWindowFullscreenStateChange: (listener) => {
      const onWindowFullscreenStateChange = bridge?.onWindowFullscreenStateChange;
      if (typeof onWindowFullscreenStateChange === "function") {
        return onWindowFullscreenStateChange(listener);
      }
      return () => {};
    },
  };
}

let cached: LocalApi | undefined;

export function localApi(): LocalApi {
  if (!cached) cached = createLocalApi();
  return cached;
}
