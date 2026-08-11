import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";

import { ServerBootstrapEnvelope } from "@app/contracts";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import type { DesktopBackendStartConfig } from "../../src/backend/DesktopBackendConfiguration.ts";
import * as ElectronMenu from "../../src/electron/ElectronMenu.ts";
import * as ElectronShell from "../../src/electron/ElectronShell.ts";
import * as ElectronTheme from "../../src/electron/ElectronTheme.ts";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
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
  const webContentsOnceListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const loadedUrls: string[] = [];
  const reloads: number[] = [];

  const webContents = {
    getURL: () => loadedUrls.at(-1) ?? "",
    isLoadingMainFrame: () => false,
    on: (eventName: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsListeners.set(eventName, listener);
    },
    once: (eventName: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsOnceListeners.set(eventName, listener);
    },
    reload: () => {
      reloads.push(loadedUrls.length);
    },
    send: () => undefined,
    setWindowOpenHandler: () => undefined,
    session: {
      webRequest: {
        onHeadersReceived: () => undefined,
      },
    },
  };

  const window = {
    isDestroyed: () => false,
    loadURL: (url: string) => {
      loadedUrls.push(url);
      return Promise.resolve();
    },
    on: (eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    },
    once: () => undefined,
    setBackgroundColor: () => undefined,
    setTitle: () => undefined,
    webContents,
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    loadedUrls,
    reloads,
    webContentsListeners,
    webContentsOnceListeners,
    windowListeners,
  };
}

const desktopEnvironmentLayer = (devServerUrl: Option.Option<URL> = Option.none()) =>
  Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.makeWith(
        {
          dirname: "/app/apps/desktop/dist-electron",
          homeDirectory: "/home/user",
          platform: "darwin",
          appVersion: "0.0.0",
          appPath: "/app",
          isPackaged: false,
          resourcesPath: "/app/resources",
          appDataDirectory: Option.none(),
          xdgConfigHome: Option.none(),
          serverEntryOverride: Option.none(),
          logDirOverride: Option.none(),
          logLevel: Option.none(),
          otlpTracesUrl: Option.none(),
          otlpExportIntervalMs: Option.none(),
          configuredBackendPort: Option.none(),
          devServerUrl,
          processArch: "arm64",
          runningUnderArm64Translation: false,
          appImagePath: Option.none(),
          disableAutoUpdate: false,
        },
        path,
      ),
    ),
  ).pipe(Layer.provide(Path.layer));

const electronMenuLayer = Layer.succeed(ElectronMenu.ElectronMenu, {
  showContextMenu: () => Effect.succeed(Option.none()),
  setApplicationMenu: () => Effect.void,
  popupTemplate: () => Effect.void,
} satisfies ElectronMenu.ElectronMenu["Service"]);

const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
} satisfies ElectronTheme.ElectronTheme["Service"]);

function makeTestLayer(input: {
  readonly window: Electron.BrowserWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly openedExternalUrls?: unknown[];
  readonly devServerUrl?: URL;
}) {
  const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Ref.update(input.createCount, (count) => count + 1).pipe(Effect.as(input.window)),
    currentMainOrFirst: Ref.get(input.mainWindow),
    focusedMainOrFirst: Ref.get(input.mainWindow),
    setMain: (window) => Ref.set(input.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    reveal: () => Effect.void,
    send: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    allDisplayBounds: Effect.succeed([]),
    syncAllAppearance: (sync) => sync(input.window),
    onReadyToShow: () => Effect.void,
    onClosed: () => Effect.void,
    setWindowOpenHandler: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  return DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        desktopEnvironmentLayer(Option.fromNullishOr(input.devServerUrl ?? null)),
        DesktopAppSettings.layerTest(),
        electronMenuLayer,
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: (url) =>
            Effect.sync(() => {
              input.openedExternalUrls?.push(url);
              return true;
            }),
          copyText: () => Effect.void,
        } satisfies ElectronShell.ElectronShell["Service"]),
        electronThemeLayer,
        electronWindowLayer,
      ),
    ),
  );
}

describe("DesktopWindow", () => {
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

  it.effect("does not open a window until the backend is ready", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({ window: fakeWindow.window, createCount, mainWindow });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.activate;
        assert.equal(yield* Ref.get(createCount), 0);

        yield* desktopWindow.handleBackendReady(backendConfig);
        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(fakeWindow.loadedUrls[0], "http://127.0.0.1:3773/");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("recovers when the development renderer is temporarily unreachable", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        devServerUrl: new URL("http://localhost:5173"),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendConfig);

        const applicationUrl = fakeWindow.loadedUrls[0];
        const didFailLoad = fakeWindow.webContentsListeners.get("did-fail-load");
        const didFinishLoad = fakeWindow.webContentsListeners.get("did-finish-load");
        if (applicationUrl === undefined || !didFailLoad || !didFinishLoad) {
          return yield* Effect.die("renderer load listeners were not registered");
        }

        didFailLoad({}, -9, "ERR_UNEXPECTED", applicationUrl, true);
        assert.equal(fakeWindow.loadedUrls.length, 1);

        yield* TestClock.adjust(100);
        assert.deepEqual(fakeWindow.loadedUrls, [applicationUrl, applicationUrl]);

        didFailLoad({}, -9, "ERR_UNEXPECTED", applicationUrl, true);
        didFinishLoad();
        yield* TestClock.adjust(250);
        assert.equal(fakeWindow.loadedUrls.length, 2);
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
});
