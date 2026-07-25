import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Electron from "electron";

import { sanitizeDiagnosticText } from "@app/shared/safeLog";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import type { DesktopBackendStartConfig } from "../backend/DesktopBackendConfiguration.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MENU_ACTION_CHANNEL, WINDOW_FULLSCREEN_STATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const TITLEBAR_HEIGHT = 44;
const TITLEBAR_COLOR = "#01000000";
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#202329";
const TITLEBAR_DARK_SYMBOL_COLOR = "#e8ebf0";
const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
const DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES = new Set([
  -2, // ERR_FAILED
  -7, // ERR_TIMED_OUT
  -9, // ERR_UNEXPECTED (custom protocol handler rejected)
  -102, // ERR_CONNECTION_REFUSED
  -105, // ERR_NAME_NOT_RESOLVED
  -106, // ERR_INTERNET_DISCONNECTED
  -118, // ERR_CONNECTION_TIMED_OUT
]);

// Owns the main BrowserWindow: creates it with the hardened webPreferences,
// loads the server (or dev) URL, and reveals it on `ready-to-show`. A
// readiness latch (`backendReadyRef`) gates window creation until the backend
// reports ready — set/cleared by the backend manager's onReady/onNotReady.

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopAppSettings.DesktopAppSettings
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow;

export type DesktopWindowError = ElectronWindow.ElectronWindowCreateError;

export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    // Reveal the main window, creating it first if the backend is ready
    // (macOS dock-click / second-instance behaviour).
    readonly activate: Effect.Effect<void, DesktopWindowError>;
    // Marks the backend ready and opens the main window. Reports the resolved
    // config for the readiness log; the renderer is served same-origin so the
    // URL is derived from the environment, not this callback.
    readonly handleBackendReady: (
      config: DesktopBackendStartConfig,
    ) => Effect.Effect<void, DesktopWindowError>;
    // Clears the latch so a dock-click while the backend is down can't open a
    // window pointing at nothing.
    readonly handleBackendNotReady: Effect.Effect<void>;
    readonly flushMainWindowBounds: Effect.Effect<void>;
    readonly dispatchMenuAction: (action: string) => Effect.Effect<void, DesktopWindowError>;
    readonly syncAppearance: Effect.Effect<void>;
  }
>()("@app/desktop/window/DesktopWindow") {}

const { logInfo, logWarning, logError } = makeComponentLogger("desktop-window");

function initialBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0f1116" : "#f7f8fa";
}

type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

function getWindowTitleBarOptions(
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): WindowTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 15 },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncWindowAppearance(
  window: Electron.BrowserWindow,
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(initialBackgroundColor(shouldUseDarkColors));
    const { titleBarOverlay } = getWindowTitleBarOptions(shouldUseDarkColors, platform);
    if (typeof titleBarOverlay === "object") {
      window.setTitleBarOverlay(titleBarOverlay);
    }
  });
}

type DisplayBounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

function windowFitsWithinDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): boolean {
  return (
    windowBounds.x >= displayBounds.x &&
    windowBounds.y >= displayBounds.y &&
    windowBounds.x + windowBounds.width <= displayBounds.x + displayBounds.width &&
    windowBounds.y + windowBounds.height <= displayBounds.y + displayBounds.height
  );
}

function windowBoundsEqual(
  left: DesktopAppSettings.DesktopWindowBounds,
  right: DesktopAppSettings.DesktopWindowBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function resolveInitialMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
): DesktopAppSettings.DesktopWindowBounds | typeof DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE {
  if (
    persistedBounds !== null &&
    displays.some((display) => windowFitsWithinDisplay(persistedBounds, display))
  ) {
    return persistedBounds;
  }
  return DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE;
}

// The renderer origin: the dev web server in development, otherwise the local
// backend (which serves the built web app same-origin).
function resolveApplicationUrl(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): string {
  return Option.match(environment.devServerUrl, {
    onNone: () => `http://127.0.0.1:${environment.defaultBackendPort}`,
    onSome: (url) => url.href,
  });
}

export function isSameOriginRendererNavigation(input: {
  readonly applicationUrl: string;
  readonly navigationUrl: string;
}): boolean {
  try {
    return new URL(input.applicationUrl).origin === new URL(input.navigationUrl).origin;
  } catch {
    return false;
  }
}

// The policy injected on documents served from the application origin. The
// renderer talks to the local backend (and, in dev, the Vite dev server) over
// http/ws, so connections are restricted by scheme rather than by host;
// 'unsafe-inline' keeps Vite's injected dev scripts/styles working.
export function makeDesktopContentSecurityPolicy(): string {
  const scriptSources = ["'self'", "'unsafe-inline'"];
  const connectSources = ["'self'", "http:", "https:", "ws:", "wss:"];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    "img-src 'self' blob: data: http: https:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "form-action 'self'",
  ].join("; ");
}

const DESKTOP_CONTENT_SECURITY_POLICY = makeDesktopContentSecurityPolicy();

export function isRetryableDevelopmentRendererLoadFailure(input: {
  readonly applicationUrl: string;
  readonly errorCode: number;
  readonly isMainFrame: boolean;
  readonly validatedUrl: string;
}): boolean {
  return (
    input.isMainFrame &&
    DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES.has(input.errorCode) &&
    isSameOriginRendererNavigation({
      applicationUrl: input.applicationUrl,
      navigationUrl: input.validatedUrl,
    })
  );
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;

  const backendReadyRef = yield* Ref.make(false);
  const applicationUrlRef = yield* Ref.make(resolveApplicationUrl(environment));
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  let flushMainWindowBounds: Effect.Effect<void> = Effect.void;

  const createWindow = Effect.fn("desktop.window.createWindow")(function* () {
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const applicationUrl = yield* Ref.get(applicationUrlRef);
    const persistedSettings = yield* desktopSettings.get;
    const persistedBounds = persistedSettings.mainWindowBounds;
    const displayBoundsResult = yield* Effect.sync(() => {
      try {
        return {
          _tag: "Success" as const,
          bounds: Electron.screen.getAllDisplays().map((display) => display.bounds),
        };
      } catch (cause) {
        return { _tag: "Failure" as const, cause };
      }
    });
    const displayBounds =
      displayBoundsResult._tag === "Success"
        ? displayBoundsResult.bounds
        : yield* logWarning("failed to read connected displays; using defaults", {
            cause: displayBoundsResult.cause,
          }).pipe(Effect.as<readonly Electron.Rectangle[]>([]));
    const initialBounds = resolveInitialMainWindowBounds(persistedBounds, displayBounds);
    const restoredPersistedBounds = persistedBounds !== null && initialBounds === persistedBounds;
    if (persistedBounds !== null && initialBounds === DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE) {
      yield* logWarning("saved main window bounds could not be restored; using defaults");
    }
    const callbackAnnotations = yield* References.CurrentLogAnnotations;
    const runWindowFork = <A, E>(effect: Effect.Effect<A, E, DesktopWindowRuntimeServices>) =>
      runFork(effect.pipe(Effect.annotateLogs(callbackAnnotations)));
    const runWindowPromise = <A, E>(effect: Effect.Effect<A, E, DesktopWindowRuntimeServices>) =>
      runPromise(effect.pipe(Effect.annotateLogs(callbackAnnotations)));
    const window = yield* electronWindow.create({
      ...initialBounds,
      minWidth: 900,
      minHeight: 640,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: initialBackgroundColor(shouldUseDarkColors),
      title: environment.displayName,
      ...getWindowTitleBarOptions(shouldUseDarkColors, environment.platform),
      ...(environment.platform === "darwin" ? {} : { icon: environment.windowIconPath }),
      webPreferences: {
        preload: environment.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let boundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let pendingBoundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let boundsPersistenceEnabled = persistedBounds === null || restoredPersistedBounds;
    const readPersistableBounds = (): DesktopAppSettings.DesktopWindowBounds | null => {
      if (window.isDestroyed()) {
        return null;
      }
      const bounds =
        window.isFullScreen() || window.isMaximized() || window.isMinimized()
          ? window.getNormalBounds()
          : window.getBounds();
      return DesktopAppSettings.normalizeMainWindowBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };
    const fallbackWindowBounds = boundsPersistenceEnabled ? null : readPersistableBounds();
    const fallbackWindowMaximized = persistedSettings.mainWindowMaximized;
    const persistCurrentBounds = (): Fiber.Fiber<void, never> | undefined => {
      if (!boundsPersistenceEnabled) {
        return pendingBoundsPersistFiber;
      }
      const bounds = readPersistableBounds();
      if (bounds === null) {
        return pendingBoundsPersistFiber;
      }
      pendingBoundsPersistFiber = runWindowFork(
        desktopSettings.setMainWindowBounds(bounds, window.isMaximized()).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            logWarning("failed to persist main window bounds", {
              message: error.message,
            }),
          ),
        ),
      );
      return pendingBoundsPersistFiber;
    };
    const scheduleBoundsPersist = () => {
      if (!boundsPersistenceEnabled) {
        const currentBounds = readPersistableBounds();
        if (
          currentBounds === null ||
          (fallbackWindowBounds !== null &&
            windowBoundsEqual(currentBounds, fallbackWindowBounds) &&
            window.isMaximized() === fallbackWindowMaximized)
        ) {
          return;
        }
      }
      boundsPersistenceEnabled = true;
      if (boundsPersistFiber !== undefined) {
        const fiber = boundsPersistFiber;
        boundsPersistFiber = undefined;
        runWindowFork(Fiber.interrupt(fiber));
      }
      boundsPersistFiber = runWindowFork(
        Effect.sleep(MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              boundsPersistFiber = undefined;
              void persistCurrentBounds();
            }),
          ),
        ),
      );
    };
    const clearBoundsPersist = () => {
      if (boundsPersistFiber === undefined) {
        return;
      }
      const fiber = boundsPersistFiber;
      boundsPersistFiber = undefined;
      runWindowFork(Fiber.interrupt(fiber));
    };
    const flushBoundsPersist = Effect.sync(() => {
      clearBoundsPersist();
      return persistCurrentBounds();
    }).pipe(
      Effect.flatMap((fiber) =>
        fiber === undefined ? Effect.void : Fiber.join(fiber).pipe(Effect.asVoid),
      ),
    );
    flushMainWindowBounds = flushBoundsPersist;

    // The backend serves no Content-Security-Policy of its own, so the shell
    // pins one on every response from the application origin. Other origins
    // (e.g. dev-mode API calls to the backend) are left untouched.
    window.webContents.session.webRequest.onHeadersReceived(
      { urls: [`${new URL(applicationUrl).origin}/*`] },
      (details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            "Content-Security-Policy": [DESKTOP_CONTENT_SECURITY_POLICY],
          },
        });
      },
    );

    // Open http/https links externally instead of navigating the shell.
    yield* electronWindow.setWindowOpenHandler(window, ({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runWindowPromise(electronShell.openExternal(url));
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (
        isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: url,
        })
      ) {
        return;
      }

      event.preventDefault();
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runWindowPromise(electronShell.openExternal(url));
      }
    });

    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(environment.displayName);
    });
    window.on("resize", scheduleBoundsPersist);
    window.on("move", scheduleBoundsPersist);
    window.on("maximize", scheduleBoundsPersist);
    window.on("unmaximize", scheduleBoundsPersist);
    window.on("close", () => {
      runWindowFork(flushBoundsPersist);
    });

    if (environment.platform === "darwin") {
      window.on("enter-full-screen", () => {
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, true);
      });
      window.on("leave-full-screen", () => {
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, false);
      });
    }

    let developmentLoadRetryIndex = 0;
    let developmentLoadRetryFiber: Fiber.Fiber<void, never> | undefined;
    const clearDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber === undefined) {
        return;
      }
      const retryFiber = developmentLoadRetryFiber;
      developmentLoadRetryFiber = undefined;
      runWindowFork(Fiber.interrupt(retryFiber));
    };
    const loadApplication = () => {
      if (window.isDestroyed()) {
        return;
      }
      void window.loadURL(applicationUrl).catch(() => undefined);
    };
    const scheduleDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber !== undefined || window.isDestroyed()) {
        return undefined;
      }

      const retryIndex = Math.min(
        developmentLoadRetryIndex,
        DEVELOPMENT_LOAD_RETRY_DELAYS_MS.length - 1,
      );
      const retryInMs = DEVELOPMENT_LOAD_RETRY_DELAYS_MS[retryIndex] ?? 2_000;
      developmentLoadRetryIndex += 1;
      developmentLoadRetryFiber = runWindowFork(
        Effect.sleep(retryInMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              developmentLoadRetryFiber = undefined;
              if (!window.isDestroyed()) {
                loadApplication();
              }
            }),
          ),
        ),
      );
      return retryInMs;
    };

    window.webContents.on("did-finish-load", () => {
      if (
        environment.isDevelopment &&
        !isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: window.webContents.getURL(),
        })
      ) {
        return;
      }
      clearDevelopmentLoadRetry();
      developmentLoadRetryIndex = 0;
      window.setTitle(environment.displayName);
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        const retryInMs =
          environment.isDevelopment &&
          isRetryableDevelopmentRendererLoadFailure({
            applicationUrl,
            errorCode,
            isMainFrame,
            validatedUrl: validatedURL,
          })
            ? scheduleDevelopmentLoadRetry()
            : undefined;
        void runWindowPromise(
          logWarning("main window failed to load", {
            errorCode,
            errorDescription,
            url: validatedURL,
            ...(retryInMs === undefined ? {} : { retryInMs }),
          }),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      void runWindowPromise(
        logWarning("main window render process gone", {
          reason: details.reason,
          exitCode: details.exitCode,
        }),
      );
    });
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
      void runWindowPromise(
        logError("renderer preload failed", {
          preloadPath,
          message: sanitizeDiagnosticText(error.message, 4_096),
        }),
      );
    });
    window.webContents.on("unresponsive", () => {
      void runWindowPromise(logWarning("main window became unresponsive"));
    });

    let revealed = false;
    const reveal = () => {
      if (revealed) {
        return;
      }
      revealed = true;
      if (persistedSettings.mainWindowMaximized) {
        window.maximize();
      }
      void runWindowPromise(electronWindow.reveal(window));
    };
    yield* electronWindow.onReadyToShow(window, reveal);
    if (environment.platform === "linux") {
      window.webContents.once("did-finish-load", reveal);
    }
    yield* electronWindow.onClosed(window, () => {
      clearDevelopmentLoadRetry();
      clearBoundsPersist();
      void runWindowPromise(electronWindow.clearMain(Option.some(window)));
    });

    loadApplication();
    return window;
  });

  const createMain = Effect.gen(function* () {
    const window = yield* createWindow();
    yield* electronWindow.setMain(window);
    yield* logInfo("main window created");
    return window;
  }).pipe(Effect.withSpan("desktop.window.createMain"));

  const createMainIfBackendReady = Effect.gen(function* () {
    if (!(yield* Ref.get(backendReadyRef))) return;
    const existing = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existing)) return;
    yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.createMainIfBackendReady"));

  const dispatchMenuAction = Effect.fn("desktop.window.dispatchMenuAction")(function* (
    action: string,
  ) {
    yield* Effect.annotateCurrentSpan({ action });
    const existingWindow = yield* electronWindow.focusedMainOrFirst;
    if (Option.isNone(existingWindow) && !(yield* Ref.get(backendReadyRef))) {
      return;
    }
    const targetWindow = Option.isSome(existingWindow) ? existingWindow.value : yield* createMain;
    const callbackAnnotations = yield* References.CurrentLogAnnotations;

    const send = () => {
      if (targetWindow.isDestroyed()) {
        return;
      }
      void runPromise(
        electronWindow
          .send(targetWindow, MENU_ACTION_CHANNEL, action)
          .pipe(
            Effect.andThen(electronWindow.reveal(targetWindow)),
            Effect.annotateLogs(callbackAnnotations),
            Effect.ignore({ log: true }),
          ),
      );
    };

    if (targetWindow.webContents.isLoadingMainFrame()) {
      targetWindow.webContents.once("did-finish-load", send);
      return;
    }

    yield* electronWindow.send(targetWindow, MENU_ACTION_CHANNEL, action);
    yield* electronWindow.reveal(targetWindow);
  });

  return DesktopWindow.of({
    activate: Effect.gen(function* () {
      const existing = yield* electronWindow.currentMainOrFirst;
      if (Option.isSome(existing)) {
        yield* electronWindow.reveal(existing.value);
        return;
      }
      yield* createMainIfBackendReady;
    }).pipe(Effect.withSpan("desktop.window.activate")),
    handleBackendReady: Effect.fn("desktop.window.handleBackendReady")(function* (config) {
      // In production the window loads the backend's own origin; in dev it stays
      // on the web dev server. Update the URL BEFORE opening the ready latch so
      // a concurrent `activate` (dock click) can't create a window against the
      // stale default-port URL.
      if (!environment.isDevelopment) {
        yield* Ref.set(applicationUrlRef, config.httpBaseUrl.href);
      }
      yield* Ref.set(backendReadyRef, true);
      yield* logInfo("backend ready", { url: config.httpBaseUrl.href });
      yield* createMainIfBackendReady;
    }),
    handleBackendNotReady: Ref.set(backendReadyRef, false).pipe(
      Effect.withSpan("desktop.window.handleBackendNotReady"),
    ),
    flushMainWindowBounds: Effect.suspend(() => flushMainWindowBounds).pipe(
      Effect.withSpan("desktop.window.flushMainWindowBounds"),
    ),
    dispatchMenuAction,
    syncAppearance: Effect.gen(function* () {
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window) =>
        syncWindowAppearance(window, shouldUseDarkColors, environment.platform),
      );
    }).pipe(Effect.withSpan("desktop.window.syncAppearance")),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
