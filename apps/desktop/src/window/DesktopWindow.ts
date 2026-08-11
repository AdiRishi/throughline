import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import type { DesktopBackendStartConfig } from "../backend/DesktopBackendConfiguration.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MENU_ACTION_CHANNEL } from "../ipc/channels.ts";

const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
// Renderer crash (usually V8 OOM on long sessions) recovery: reload after a
// short delay, at most MAX_ATTEMPTS times per rolling WINDOW so a renderer
// that dies on boot cannot reload-loop forever.
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;
const DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES = new Set([
  -2, // ERR_FAILED
  -7, // ERR_TIMED_OUT
  -9, // ERR_UNEXPECTED (custom protocol handler rejected)
  -102, // ERR_CONNECTION_REFUSED
  -105, // ERR_NAME_NOT_RESOLVED
  -106, // ERR_INTERNET_DISCONNECTED
  -118, // ERR_CONNECTION_TIMED_OUT
]);

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow;

export type DesktopWindowError = ElectronWindow.ElectronWindowCreateError;

export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    readonly activate: Effect.Effect<void, DesktopWindowError>;
    readonly handleBackendReady: (
      config: DesktopBackendStartConfig,
    ) => Effect.Effect<void, DesktopWindowError>;
    // Clears the latch so a dock click while the backend is down can't open a
    // window pointing at nothing.
    readonly handleBackendNotReady: Effect.Effect<void>;
    readonly dispatchMenuAction: (action: string) => Effect.Effect<void, DesktopWindowError>;
    readonly syncAppearance: Effect.Effect<void>;
  }
>()("@app/desktop/window/DesktopWindow") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-window");

function initialBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

function syncWindowAppearance(
  window: Electron.BrowserWindow,
  shouldUseDarkColors: boolean,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(initialBackgroundColor(shouldUseDarkColors));
  });
}

// The window is created with `show: false`, so a reveal trigger is the only
// thing that ever makes it visible. Several triggers are bound on Linux, where
// `ready-to-show` is unreliable, so the latch keeps the first one to fire the
// only one that reveals.
function makeFirstRevealTrigger(reveal: () => void): () => void {
  let revealed = false;
  return () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };
}

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
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;

  const backendReadyRef = yield* Ref.make(false);
  const applicationUrlRef = yield* Ref.make(resolveApplicationUrl(environment));
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);

  const createWindow = Effect.fn("desktop.window.createWindow")(function* () {
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const applicationUrl = yield* Ref.get(applicationUrlRef);
    const window = yield* electronWindow.create({
      width: 1100,
      height: 780,
      minWidth: 840,
      minHeight: 620,
      show: false,
      backgroundColor: initialBackgroundColor(shouldUseDarkColors),
      title: environment.displayName,
      webPreferences: {
        preload: environment.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

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

    yield* electronWindow.setWindowOpenHandler(window, ({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
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
        void runPromise(electronShell.openExternal(url));
      }
    });

    window.webContents.on("context-menu", (event, params) => {
      event.preventDefault();

      const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
          menuTemplate.push({
            label: suggestion,
            click: () => window.webContents.replaceMisspelling(suggestion),
          });
        }
        if (params.dictionarySuggestions.length === 0) {
          menuTemplate.push({ label: "No suggestions", enabled: false });
        }
        menuTemplate.push({ type: "separator" });
      }

      if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
        menuTemplate.push(
          {
            label: "Copy Link",
            click: () => {
              void runPromise(electronShell.copyText(params.linkURL));
            },
          },
          { type: "separator" },
        );
      }

      if (params.mediaType === "image") {
        menuTemplate.push({
          label: "Copy Image",
          click: () => window.webContents.copyImageAt(params.x, params.y),
        });
        menuTemplate.push({ type: "separator" });
      }

      menuTemplate.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );

      void runPromise(electronMenu.popupTemplate({ window, template: menuTemplate }));
    });

    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(environment.displayName);
    });

    const fireReveal = makeFirstRevealTrigger(() => {
      void runPromise(electronWindow.reveal(window));
    });
    yield* electronWindow.onReadyToShow(window, fireReveal);
    if (environment.platform === "linux") {
      window.webContents.once("did-finish-load", fireReveal);
    }

    let developmentLoadRetryIndex = 0;
    let developmentLoadRetryFiber: Fiber.Fiber<void, never> | undefined;
    let rendererRecoveryTimestamps: number[] = [];
    const clearDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber === undefined) {
        return;
      }
      const retryFiber = developmentLoadRetryFiber;
      developmentLoadRetryFiber = undefined;
      runFork(Fiber.interrupt(retryFiber));
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
      developmentLoadRetryFiber = runFork(
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
        void runPromise(
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
      const recoverable =
        details.reason === "crashed" ||
        details.reason === "oom" ||
        details.reason === "abnormal-exit";
      // Long sessions can OOM the renderer (V8 heap exhaustion). Without a
      // reload the user is left staring at a dead window, so recover by
      // reloading — the renderer rehydrates from the backend, which is
      // unaffected. Recovery attempts are bounded so a renderer that dies
      // immediately on boot cannot reload-loop forever.
      runFork(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          rendererRecoveryTimestamps = rendererRecoveryTimestamps.filter(
            (timestamp) => now - timestamp < RENDERER_RECOVERY_WINDOW_MS,
          );
          const shouldRecover =
            recoverable &&
            !window.isDestroyed() &&
            rendererRecoveryTimestamps.length < RENDERER_RECOVERY_MAX_ATTEMPTS;
          yield* logWarning("main window render process gone", {
            reason: details.reason,
            exitCode: details.exitCode,
            recovering: shouldRecover,
          });
          if (!shouldRecover) {
            return;
          }
          rendererRecoveryTimestamps.push(now);
          yield* Effect.sleep(RENDERER_RECOVERY_RELOAD_DELAY_MS);
          if (!window.isDestroyed()) {
            loadApplication();
          }
        }),
      );
    });

    loadApplication();

    yield* electronWindow.onClosed(window, () => {
      clearDevelopmentLoadRetry();
      void runPromise(electronWindow.clearMain(Option.some(window)));
    });

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
    yield* createMainIfBackendReady;
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window)) return;
    const targetWindow = window.value;

    const send = () => {
      if (targetWindow.isDestroyed()) return;
      targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
      void runPromise(electronWindow.reveal(targetWindow));
    };

    // The window may have just been created, so the preload/renderer has not
    // attached its menu-action listener yet; sending now would drop the action.
    if (targetWindow.webContents.isLoadingMainFrame()) {
      targetWindow.webContents.once("did-finish-load", send);
      return;
    }

    send();
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
    dispatchMenuAction,
    syncAppearance: Effect.gen(function* () {
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window) =>
        syncWindowAppearance(window, shouldUseDarkColors),
      );
    }).pipe(Effect.withSpan("desktop.window.syncAppearance")),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
