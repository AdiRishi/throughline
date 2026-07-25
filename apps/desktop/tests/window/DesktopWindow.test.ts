import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Electron from "electron";
import { vi } from "vitest";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  screen: {
    getAllDisplays: vi.fn<() => Array<{ bounds: Electron.Rectangle }>>(() => [
      {
        bounds: { x: 0, y: 0, width: 2_560, height: 1_440 },
      },
    ]),
  },
}));

import { ServerBootstrapEnvelope } from "@app/contracts";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import type { DesktopBackendStartConfig } from "../../src/backend/DesktopBackendConfiguration.ts";
import * as ElectronShell from "../../src/electron/ElectronShell.ts";
import * as ElectronTheme from "../../src/electron/ElectronTheme.ts";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
import { MENU_ACTION_CHANNEL, WINDOW_FULLSCREEN_STATE_CHANNEL } from "../../src/ipc/channels.ts";
import * as DesktopAppSettings from "../../src/settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";

const decodeBootstrapEnvelope = Schema.decodeUnknownSync(ServerBootstrapEnvelope);

const backendConfig: DesktopBackendStartConfig = {
  executablePath: "/usr/local/bin/node",
  args: ["/app/apps/server/dist/bin.mjs", "start", "--bootstrap-fd", "3"],
  entryPath: "/app/apps/server/dist/bin.mjs",
  cwd: "/app",
  env: {},
  bootstrapEnvelope: decodeBootstrapEnvelope({ desktopBootstrapToken: "test-token" }),
  port: 3773,
  bootstrapToken: "test-token",
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
};

function makeFakeBrowserWindow() {
  const windowListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const loadedUrls: string[] = [];

  const webContents = {
    getURL: vi.fn<() => string>(() => loadedUrls.at(-1) ?? ""),
    isLoadingMainFrame: vi.fn<() => boolean>(() => false),
    on: vi.fn<(eventName: string, listener: (...args: readonly unknown[]) => void) => void>(
      (eventName, listener) => {
        webContentsListeners.set(eventName, listener);
      },
    ),
    once: vi.fn<(eventName: string, listener: (...args: readonly unknown[]) => void) => void>(
      (eventName, listener) => {
        webContentsListeners.set(eventName, listener);
      },
    ),
    send: vi.fn<(channel: string, ...args: readonly unknown[]) => void>(),
    setWindowOpenHandler: vi.fn<(...args: readonly unknown[]) => void>(),
    session: {
      webRequest: {
        onHeadersReceived: vi.fn<(...args: readonly unknown[]) => void>(),
      },
    },
  };

  const window = {
    getBounds: vi.fn<() => Electron.Rectangle>(() => ({
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
    })),
    getNormalBounds: vi.fn<() => Electron.Rectangle>(() => ({
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
    })),
    isDestroyed: vi.fn<() => boolean>(() => false),
    isFullScreen: vi.fn<() => boolean>(() => false),
    isMaximized: vi.fn<() => boolean>(() => false),
    isMinimized: vi.fn<() => boolean>(() => false),
    loadURL: vi.fn<(url: string) => Promise<void>>((url) => {
      loadedUrls.push(url);
      return Promise.resolve();
    }),
    maximize: vi.fn<() => void>(),
    on: vi.fn<(eventName: string, listener: (...args: readonly unknown[]) => void) => void>(
      (eventName, listener) => {
        windowListeners.set(eventName, listener);
      },
    ),
    once: vi.fn<(eventName: string, listener: (...args: readonly unknown[]) => void) => void>(
      (eventName, listener) => {
        windowListeners.set(eventName, listener);
      },
    ),
    setBackgroundColor: vi.fn<(color: string) => void>(),
    setTitle: vi.fn<(title: string) => void>(),
    setTitleBarOverlay: vi.fn<(options: Electron.TitleBarOverlayOptions) => void>(),
    webContents,
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    getBounds: window.getBounds,
    getNormalBounds: window.getNormalBounds,
    isDestroyed: window.isDestroyed,
    isFullScreen: window.isFullScreen,
    isLoadingMainFrame: webContents.isLoadingMainFrame,
    isMaximized: window.isMaximized,
    isMinimized: window.isMinimized,
    loadedUrls,
    maximize: window.maximize,
    send: webContents.send,
    setBackgroundColor: window.setBackgroundColor,
    setTitleBarOverlay: window.setTitleBarOverlay,
    webContentsListeners,
    windowListeners,
  };
}

const desktopEnvironmentLayer = (platform: NodeJS.Platform, devServerUrl: Option.Option<URL>) =>
  Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.makeWith(
        {
          dirname: "/app/apps/desktop/dist-electron",
          homeDirectory: "/home/user",
          platform,
          appVersion: "0.0.0",
          appPath: "/app",
          isPackaged: false,
          resourcesPath: "/app/resources",
          appDataDirectory: Option.none(),
          xdgConfigHome: Option.none(),
          appImagePath: Option.none(),
          serverEntryOverride: Option.none(),
          configuredBackendPort: Option.none(),
          devServerUrl,
        },
        path,
      ),
    ),
  ).pipe(Layer.provide(Path.layer));

const electronThemeLayer = (shouldUseDarkColors: Effect.Effect<boolean> = Effect.succeed(false)) =>
  Layer.succeed(ElectronTheme.ElectronTheme, {
    shouldUseDarkColors,
    setSource: () => Effect.void,
    onUpdated: () => Effect.void,
  } satisfies ElectronTheme.ElectronTheme["Service"]);

function makeTestLayer(input: {
  readonly window: Electron.BrowserWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly createdWindowOptions?: Electron.BrowserWindowConstructorOptions[];
  readonly desktopSettings?: DesktopAppSettings.DesktopSettings;
  readonly openedExternalUrls?: unknown[];
  readonly platform?: NodeJS.Platform;
  readonly revealedWindows?: Electron.BrowserWindow[];
  readonly shouldUseDarkColors?: Effect.Effect<boolean>;
  readonly beforeMainWindowBoundsUpdate?: (
    bounds: DesktopAppSettings.DesktopWindowBounds,
  ) => Effect.Effect<void>;
  readonly devServerUrl?: Option.Option<URL>;
}) {
  const beforeMainWindowBoundsUpdate = input.beforeMainWindowBoundsUpdate;
  const desktopAppSettingsLayer = beforeMainWindowBoundsUpdate
    ? Layer.effect(
        DesktopAppSettings.DesktopAppSettings,
        Effect.gen(function* () {
          const delegate = yield* DesktopAppSettings.DesktopAppSettings;
          return DesktopAppSettings.DesktopAppSettings.of({
            get: delegate.get,
            load: delegate.load,
            setMainWindowBounds: (bounds, isMaximized) =>
              beforeMainWindowBoundsUpdate(bounds).pipe(
                Effect.andThen(delegate.setMainWindowBounds(bounds, isMaximized)),
              ),
            setTheme: delegate.setTheme,
            setUpdateChannel: delegate.setUpdateChannel,
          });
        }),
      ).pipe(Layer.provide(DesktopAppSettings.layerTest(input.desktopSettings)))
    : DesktopAppSettings.layerTest(input.desktopSettings);
  const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: (options) =>
      Ref.update(input.createCount, (count) => count + 1).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            input.createdWindowOptions?.push(options);
          }),
        ),
        Effect.as(input.window),
      ),
    loadUrl: () => Effect.void,
    currentMainOrFirst: Ref.get(input.mainWindow),
    focusedMainOrFirst: Ref.get(input.mainWindow),
    setMain: (window) => Ref.set(input.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    reveal: (window) =>
      Effect.sync(() => {
        input.revealedWindows?.push(window);
      }),
    send: (window, channel, ...args) =>
      Effect.sync(() => {
        window.webContents.send(channel, ...args);
      }),
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: (sync) => sync(input.window),
    onReadyToShow: (window, handler) =>
      Effect.sync(() => {
        window.once("ready-to-show", handler);
      }),
    onClosed: (window, handler) =>
      Effect.sync(() => {
        window.on("closed", handler);
      }),
    setWindowOpenHandler: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  return DesktopWindow.layer.pipe(
    Layer.provideMerge(desktopAppSettingsLayer),
    Layer.provide(
      Layer.mergeAll(
        desktopEnvironmentLayer(input.platform ?? "darwin", input.devServerUrl ?? Option.none()),
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: (url) =>
            Effect.sync(() => {
              input.openedExternalUrls?.push(url);
              return true;
            }),
          openPath: () => Effect.succeed(true),
        } satisfies ElectronShell.ElectronShell["Service"]),
        electronThemeLayer(input.shouldUseDarkColors),
        electronWindowLayer,
      ),
    ),
  );
}

describe("DesktopWindow", () => {
  it("restores bounds only when the window fits within a connected display", () => {
    const persistedBounds = { x: 2040, y: 80, width: 1320, height: 880 };
    const displays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];

    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, displays),
      persistedBounds,
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, [displays[0]!]),
      DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
  });

  it.effect("restores persisted bounds and maximized state on first reveal", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 120, y: 80, width: 1320, height: 880 },
          mainWindowMaximized: true,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendConfig);

        assert.deepEqual(createdWindowOptions[0], {
          x: 120,
          y: 80,
          width: 1320,
          height: 880,
          minWidth: 900,
          minHeight: 640,
          show: false,
          autoHideMenuBar: true,
          backgroundColor: "#f7f8fa",
          title: "Throughline",
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 15 },
          webPreferences: {
            preload: "/app/apps/desktop/dist-electron/preload.cjs",
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        assert.equal(fakeWindow.maximize.mock.calls.length, 0);
        const readyToShow = fakeWindow.windowListeners.get("ready-to-show");
        if (!readyToShow) {
          return yield* Effect.die("ready-to-show listener was not registered");
        }
        readyToShow();
        assert.equal(fakeWindow.maximize.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("debounces move and resize persistence to the final normal bounds", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* desktopWindow.handleBackendReady(backendConfig);

        const move = fakeWindow.windowListeners.get("move");
        const resize = fakeWindow.windowListeners.get("resize");
        if (!move || !resize) {
          return yield* Effect.die("window bounds listeners were not registered");
        }

        fakeWindow.getBounds.mockReturnValue({ x: 120, y: 80, width: 1280, height: 840 });
        move();
        yield* TestClock.adjust(250);

        fakeWindow.getBounds.mockReturnValue({ x: 160, y: 100, width: 1360, height: 900 });
        resize();
        yield* TestClock.adjust(499);
        assert.isNull((yield* settings.get).mainWindowBounds);

        yield* TestClock.adjust(1);
        yield* Effect.yieldNow;
        assert.deepEqual((yield* settings.get).mainWindowBounds, {
          x: 160,
          y: 100,
          width: 1360,
          height: 900,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flushes normal bounds while the window is fullscreen", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
      fakeWindow.getNormalBounds.mockReturnValue({
        x: 200,
        y: 130,
        width: 1400,
        height: 940,
      });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* desktopWindow.handleBackendReady(backendConfig);

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(250);
        fakeWindow.isFullScreen.mockReturnValue(true);
        yield* desktopWindow.flushMainWindowBounds;

        assert.deepEqual((yield* settings.get).mainWindowBounds, {
          x: 200,
          y: 130,
          width: 1400,
          height: 940,
        });
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flushes normal bounds when minimized before the debounce completes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({
        x: -32_000,
        y: -32_000,
        width: 160,
        height: 28,
      });
      fakeWindow.getNormalBounds.mockReturnValue({
        x: 180,
        y: 120,
        width: 1440,
        height: 960,
      });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* desktopWindow.handleBackendReady(backendConfig);

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(250);
        fakeWindow.isMinimized.mockReturnValue(true);

        yield* desktopWindow.flushMainWindowBounds;

        assert.deepEqual((yield* settings.get).mainWindowBounds, {
          x: 180,
          y: 120,
          width: 1440,
          height: 960,
        });
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not persist bounds that fail the domain schema", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({
        x: 100.4,
        y: 80.2,
        width: 899.4,
        height: 639.4,
      });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* desktopWindow.handleBackendReady(backendConfig);

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(500);
        yield* Effect.yieldNow;

        assert.isNull((yield* settings.get).mainWindowBounds);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("preserves unrestorable bounds until the user changes the window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const persistedBounds = { x: 3_000, y: 80, width: 1320, height: 880 };
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: persistedBounds,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* desktopWindow.handleBackendReady(backendConfig);

        yield* desktopWindow.flushMainWindowBounds;
        assert.deepEqual((yield* settings.get).mainWindowBounds, persistedBounds);

        const move = fakeWindow.windowListeners.get("move");
        if (!move) {
          return yield* Effect.die("window move listener was not registered");
        }
        fakeWindow.getBounds.mockReturnValue({ x: 80, y: 60, width: 1280, height: 840 });
        move();
        yield* TestClock.adjust(500);
        yield* Effect.yieldNow;

        assert.deepEqual((yield* settings.get).mainWindowBounds, {
          x: 80,
          y: 60,
          width: 1280,
          height: 840,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("waits for an in-flight close-time bounds write after the window is destroyed", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({
        x: 240,
        y: 160,
        width: 1410,
        height: 930,
      });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const writeStarted = yield* Deferred.make<void>();
      const allowWrite = yield* Deferred.make<void>();
      const flushCompleted = yield* Deferred.make<void>();
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        beforeMainWindowBoundsUpdate: () =>
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowWrite)),
            Effect.asVoid,
          ),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* desktopWindow.handleBackendReady(backendConfig);

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Deferred.await(writeStarted);
        fakeWindow.isDestroyed.mockReturnValue(true);

        const flushFiber = yield* desktopWindow.flushMainWindowBounds.pipe(
          Effect.andThen(Deferred.succeed(flushCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(flushCompleted));

        yield* Deferred.succeed(allowWrite, undefined);
        yield* Fiber.join(flushFiber);
        assert.isTrue(yield* Deferred.isDone(flushCompleted));
        assert.deepEqual((yield* settings.get).mainWindowBounds, {
          x: 240,
          y: 160,
          width: 1410,
          height: 930,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("logs display lookup failures before using the default window size", () =>
    Effect.gen(function* () {
      const displayLookupFailure = new Error("screen API unavailable");
      vi.mocked(Electron.screen.getAllDisplays).mockImplementationOnce(() => {
        throw displayLookupFailure;
      });
      const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const recordingLogger = Logger.make((options) => {
        records.push(Logger.formatStructured.log(options));
      });
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendConfig);
      }).pipe(Effect.provide(layer), Effect.provide(Logger.layer([recordingLogger])));

      const warning = records.find(
        (record) => record.message === "failed to read connected displays; using defaults",
      );
      assert.isDefined(warning);
      assert.strictEqual(warning?.annotations.cause, displayLookupFailure);
      assert.equal(createdWindowOptions[0]?.width, 1440);
      assert.equal(createdWindowOptions[0]?.height, 900);
      assert.isUndefined(createdWindowOptions[0]?.x);
      assert.isUndefined(createdWindowOptions[0]?.y);
    }),
  );

  it.effect("waits for the main frame before dispatching a menu action", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendConfig);
        fakeWindow.isLoadingMainFrame.mockReturnValue(true);

        yield* desktopWindow.dispatchMenuAction("preferences");
        assert.equal(fakeWindow.send.mock.calls.length, 0);

        const didFinishLoad = fakeWindow.webContentsListeners.get("did-finish-load");
        if (!didFinishLoad) {
          return yield* Effect.die("deferred menu listener was not registered");
        }
        didFinishLoad();
        yield* Effect.yieldNow;
        assert.deepEqual(fakeWindow.send.mock.calls, [[MENU_ACTION_CHANNEL, "preferences"]]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("publishes native macOS fullscreen changes to the renderer", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendConfig);

        const enterFullscreen = fakeWindow.windowListeners.get("enter-full-screen");
        const leaveFullscreen = fakeWindow.windowListeners.get("leave-full-screen");
        if (!enterFullscreen || !leaveFullscreen) {
          return yield* Effect.die("fullscreen listeners were not registered");
        }
        enterFullscreen();
        leaveFullscreen();
        assert.deepEqual(fakeWindow.send.mock.calls, [
          [WINDOW_FULLSCREEN_STATE_CHANNEL, true],
          [WINDOW_FULLSCREEN_STATE_CHANNEL, false],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reveals a Linux window after load when ready-to-show does not fire", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const revealedWindows: Electron.BrowserWindow[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        platform: "linux",
        revealedWindows,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendConfig);

        assert.equal(createdWindowOptions[0]?.autoHideMenuBar, true);
        assert.equal(createdWindowOptions[0]?.titleBarStyle, "hidden");
        assert.deepEqual(createdWindowOptions[0]?.titleBarOverlay, {
          color: "#01000000",
          height: 44,
          symbolColor: "#202329",
        });
        assert.equal(createdWindowOptions[0]?.icon, "/app/apps/desktop/resources/icon.png");

        const didFinishLoad = fakeWindow.webContentsListeners.get("did-finish-load");
        if (!didFinishLoad) {
          return yield* Effect.die("Linux reveal fallback was not registered");
        }
        didFinishLoad();
        yield* Effect.yieldNow;
        assert.deepEqual(revealedWindows, [fakeWindow.window]);

        const readyToShow = fakeWindow.windowListeners.get("ready-to-show");
        readyToShow?.();
        yield* Effect.yieldNow;
        assert.deepEqual(revealedWindows, [fakeWindow.window]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps Windows and Linux title bars synchronized with the native theme", () =>
    Effect.forEach(["win32", "linux"] as const, (platform) =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
        const shouldUseDarkColors = yield* Ref.make(false);
        const layer = makeTestLayer({
          window: fakeWindow.window,
          createCount,
          mainWindow,
          createdWindowOptions,
          platform,
          shouldUseDarkColors: Ref.get(shouldUseDarkColors),
        });

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.handleBackendReady(backendConfig);

          assert.equal(createdWindowOptions[0]?.autoHideMenuBar, true);
          assert.equal(createdWindowOptions[0]?.backgroundColor, "#f7f8fa");
          assert.equal(createdWindowOptions[0]?.titleBarStyle, "hidden");
          assert.deepEqual(createdWindowOptions[0]?.titleBarOverlay, {
            color: "#01000000",
            height: 44,
            symbolColor: "#202329",
          });
          assert.equal(
            createdWindowOptions[0]?.icon,
            platform === "win32"
              ? "/app/apps/desktop/resources/icon.ico"
              : "/app/apps/desktop/resources/icon.png",
          );

          yield* desktopWindow.syncAppearance;
          assert.equal(fakeWindow.setBackgroundColor.mock.lastCall?.[0], "#f7f8fa");
          assert.deepEqual(fakeWindow.setTitleBarOverlay.mock.lastCall?.[0], {
            color: "#01000000",
            height: 44,
            symbolColor: "#202329",
          });

          yield* Ref.set(shouldUseDarkColors, true);
          yield* desktopWindow.syncAppearance;
          assert.equal(fakeWindow.setBackgroundColor.mock.lastCall?.[0], "#0f1116");
          assert.deepEqual(fakeWindow.setTitleBarOverlay.mock.lastCall?.[0], {
            color: "#01000000",
            height: 44,
            symbolColor: "#e8ebf0",
          });
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it("recognizes only same-origin renderer navigations", () => {
    assert.isTrue(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "app://app/",
        navigationUrl: "app://app/settings/connections",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "app://app/",
        navigationUrl: "https://accounts.microsoft.com/oauth",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "app://app/",
        navigationUrl: "not a url",
      }),
    );
  });

  it("retries only transient failures for the development renderer", () => {
    assert.isTrue(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "app-dev://app/",
        errorCode: -102,
        isMainFrame: true,
        validatedUrl: "app-dev://app/",
      }),
    );
    assert.isFalse(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "app-dev://app/",
        errorCode: -3,
        isMainFrame: true,
        validatedUrl: "app-dev://app/",
      }),
    );
    assert.isFalse(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "app-dev://app/",
        errorCode: -102,
        isMainFrame: true,
        validatedUrl: "https://example.com/",
      }),
    );
  });

  it.effect("clears a pending development renderer retry after a successful load", () =>
    Effect.gen(function* () {
      const applicationUrl = "http://127.0.0.1:5733/";
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        devServerUrl: Option.some(new URL(applicationUrl)),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendConfig);

        const didFailLoad = fakeWindow.webContentsListeners.get("did-fail-load");
        const didFinishLoad = fakeWindow.webContentsListeners.get("did-finish-load");
        if (!didFailLoad || !didFinishLoad) {
          return yield* Effect.die("renderer load listeners were not registered");
        }

        didFailLoad({}, -102, "ERR_CONNECTION_REFUSED", applicationUrl, true);
        assert.deepEqual(fakeWindow.loadedUrls, [applicationUrl]);

        yield* TestClock.adjust(100);
        assert.deepEqual(fakeWindow.loadedUrls, [applicationUrl, applicationUrl]);

        didFailLoad({}, -102, "ERR_CONNECTION_REFUSED", applicationUrl, true);
        didFinishLoad();
        yield* Effect.yieldNow;
        yield* TestClock.adjust(250);
        assert.deepEqual(fakeWindow.loadedUrls, [applicationUrl, applicationUrl]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("opens safe off-origin renderer navigations in the system browser", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openedExternalUrls: unknown[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        openedExternalUrls,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendConfig);

        const willNavigate = fakeWindow.webContentsListeners.get("will-navigate");
        if (!willNavigate) {
          return yield* Effect.die("will-navigate listener was not registered");
        }
        let prevented = false;
        willNavigate(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          "https://accounts.microsoft.com/oauth",
        );
        yield* Effect.promise(() => Promise.resolve());

        assert.isTrue(prevented);
        assert.deepEqual(openedExternalUrls, ["https://accounts.microsoft.com/oauth"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not copy renderer console output into desktop diagnostics", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendConfig);
        assert.isFalse(fakeWindow.webContentsListeners.has("console-message"));
      }).pipe(Effect.provide(layer));
    }),
  );
});
