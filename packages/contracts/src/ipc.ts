import type {
  ContextMenuItem,
  ContextMenuPosition,
  DesktopAppInfo,
  DesktopServerBootstrap,
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateChannel,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
  PickFolderOptions,
} from "./desktop.ts";

/** Unsubscribe handle returned by every `on*` event subscription. */
export type Unsubscribe = () => void;

/**
 * The typed contract for `window.desktopBridge`. `preload.ts` implements this
 * with `... satisfies DesktopBridge` (context isolation on), and the renderer
 * consumes the SAME type — so main, preload, and renderer share one contract.
 *
 * Sync methods (`ipcRenderer.sendSync`) return values directly; everything
 * else is `ipcRenderer.invoke` and returns a Promise.
 */
export interface DesktopBridge {
  /** Synchronous: static identity read at boot for branding. */
  readonly getAppInfo: () => DesktopAppInfo | null;
  /** Synchronous: persisted shell theme, available before the first paint. */
  readonly getTheme: () => DesktopTheme;
  readonly getWindowFullscreenState: () => boolean;
  /** Synchronous: where the local server lives (null before it's ready). */
  readonly getServerBootstrap: () => DesktopServerBootstrap | null;

  /** Exchange the bootstrap token for a `/ws` bearer session (async). */
  readonly getBearerToken: () => Promise<string>;

  readonly setTheme: (theme: DesktopTheme) => Promise<void>;
  readonly openExternal: (url: string) => Promise<boolean>;
  /** Opens Throughline's app-owned diagnostics directory in the file manager. */
  readonly openLogsFolder: () => Promise<boolean>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  /** Resolves with the id of the picked item — narrowed to the ids passed in. */
  readonly showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: ContextMenuPosition,
  ) => Promise<T | null>;

  readonly getUpdateState: () => Promise<DesktopUpdateState>;
  readonly setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  readonly checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  readonly downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  readonly installUpdate: () => Promise<DesktopUpdateActionResult>;
  readonly onUpdateState: (listener: (state: DesktopUpdateState) => void) => Unsubscribe;

  readonly onMenuAction: (listener: (action: string) => void) => Unsubscribe;
  readonly onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) => Unsubscribe;
}

/**
 * The capability surface the renderer actually programs against. It degrades:
 * in the shell it delegates to `window.desktopBridge`; in a plain browser it
 * uses web fallbacks (`window.open`, `window.confirm`, `localStorage`). This is
 * why the SAME web build runs in both places.
 */
export interface LocalApi {
  readonly isDesktop: boolean;
  readonly getAppInfo: () => DesktopAppInfo | null;
  readonly getTheme: () => DesktopTheme;
  readonly getWindowFullscreenState: () => boolean;
  readonly setTheme: (theme: DesktopTheme) => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
  /** Returns false in a plain browser, which has no native file manager. */
  readonly openLogsFolder: () => Promise<boolean>;
  readonly confirm: (message: string) => Promise<boolean>;
  /** Returns null in the browser (no native folder picker). */
  readonly pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  readonly getUpdateState: () => Promise<DesktopUpdateState>;
  readonly setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  readonly checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  readonly downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  readonly installUpdate: () => Promise<DesktopUpdateActionResult>;
  readonly onUpdateState: (listener: (state: DesktopUpdateState) => void) => Unsubscribe;
  /** Native menu actions. In a plain browser this never fires (no menu). */
  readonly onMenuAction: (listener: (action: string) => void) => Unsubscribe;
  readonly onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) => Unsubscribe;
}
