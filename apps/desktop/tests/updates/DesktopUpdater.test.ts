import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type { DesktopUpdateState } from "@app/contracts";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopState from "../../src/app/DesktopState.ts";
import * as DesktopBackendManager from "../../src/backend/DesktopBackendManager.ts";
import * as ElectronUpdater from "../../src/electron/ElectronUpdater.ts";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
import { UPDATE_STATE_CHANNEL } from "../../src/ipc/channels.ts";
import * as DesktopAppSettings from "../../src/settings/DesktopAppSettings.ts";
import * as DesktopUpdater from "../../src/updates/DesktopUpdater.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";

interface Push {
  readonly channel: string;
  readonly args: ReadonlyArray<unknown>;
}

interface ElectronUpdaterOverrides {
  readonly checkForUpdates?: ElectronUpdater.ElectronUpdater["Service"]["checkForUpdates"];
  readonly downloadUpdate?: ElectronUpdater.ElectronUpdater["Service"]["downloadUpdate"];
  readonly quitAndInstall?: ElectronUpdater.ElectronUpdater["Service"]["quitAndInstall"];
}

interface ElectronUpdaterHarness {
  readonly layer: Layer.Layer<ElectronUpdater.ElectronUpdater>;
  readonly emit: (eventName: string, ...args: ReadonlyArray<unknown>) => void;
  readonly calls: {
    check: number;
    download: number;
    install: number;
  };
  readonly checks: ReadonlyArray<{
    readonly channel: string | null;
    readonly allowDowngrade: boolean | null;
  }>;
  readonly channelConfiguration: () => {
    readonly channel: string | null;
    readonly allowPrerelease: boolean | null;
    readonly allowDowngrade: boolean | null;
    readonly fullChangelog: boolean | null;
  };
}

function makeElectronUpdaterHarness(
  overrides: ElectronUpdaterOverrides = {},
  installOrder?: Array<string>,
): ElectronUpdaterHarness {
  const listeners = new Map<string, Array<(...args: ReadonlyArray<unknown>) => void>>();
  const calls = { check: 0, download: 0, install: 0 };
  const checks: Array<{
    readonly channel: string | null;
    readonly allowDowngrade: boolean | null;
  }> = [];
  let channel: string | null = null;
  let allowPrerelease: boolean | null = null;
  let allowDowngrade: boolean | null = null;
  let fullChangelog: boolean | null = null;

  return {
    layer: Layer.succeed(
      ElectronUpdater.ElectronUpdater,
      ElectronUpdater.ElectronUpdater.of({
        setFeedURL: () => Effect.void,
        setAutoDownload: () => Effect.void,
        setAutoInstallOnAppQuit: () => Effect.void,
        setChannel: (value) =>
          Effect.sync(() => {
            channel = value;
          }),
        setAllowPrerelease: (value) =>
          Effect.sync(() => {
            allowPrerelease = value;
          }),
        allowDowngrade: Effect.sync(() => allowDowngrade ?? false),
        setAllowDowngrade: (value) =>
          Effect.sync(() => {
            allowDowngrade = value;
          }),
        setFullChangelog: (value) =>
          Effect.sync(() => {
            fullChangelog = value;
          }),
        checkForUpdates: Effect.sync(() => {
          calls.check += 1;
          checks.push({ channel, allowDowngrade });
        }).pipe(Effect.andThen(overrides.checkForUpdates ?? Effect.void)),
        downloadUpdate: Effect.sync(() => {
          calls.download += 1;
        }).pipe(Effect.andThen(overrides.downloadUpdate ?? Effect.void)),
        quitAndInstall: (options) =>
          Effect.sync(() => {
            calls.install += 1;
            installOrder?.push("quit-and-install");
          }).pipe(Effect.andThen(overrides.quitAndInstall?.(options) ?? Effect.void)),
        on: (eventName, listener) =>
          Effect.sync(() => {
            const registered = listeners.get(eventName) ?? [];
            registered.push(listener as (...args: ReadonlyArray<unknown>) => void);
            listeners.set(eventName, registered);
          }),
      }),
    ),
    emit: (eventName, ...args) => {
      for (const listener of listeners.get(eventName) ?? []) {
        listener(...args);
      }
    },
    calls,
    checks,
    channelConfiguration: () => ({
      channel,
      allowPrerelease,
      allowDowngrade,
      fullChangelog,
    }),
  };
}

const environmentLayer = (
  isPackaged: boolean,
  platform: NodeJS.Platform,
  appImagePath: Option.Option<string>,
) =>
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
          isPackaged,
          resourcesPath: "/app/resources",
          appDataDirectory: Option.none(),
          xdgConfigHome: Option.none(),
          appImagePath,
          serverEntryOverride: Option.none(),
          configuredBackendPort: Option.none(),
          devServerUrl: Option.none(),
        },
        path,
      ),
    ),
  ).pipe(Layer.provide(Path.layer));

interface TestHarness {
  readonly layer: Layer.Layer<
    | DesktopUpdater.DesktopUpdater
    | DesktopState.DesktopState
    | DesktopAppSettings.DesktopAppSettings
  >;
  readonly updater: ElectronUpdaterHarness;
  readonly pushes: Array<Push>;
  readonly installOrder: Array<string>;
}

function makeTestHarness(options?: {
  readonly isPackaged?: boolean;
  readonly hasFeedConfig?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly appImagePath?: Option.Option<string>;
  readonly settingsLayer?: Layer.Layer<DesktopAppSettings.DesktopAppSettings>;
  readonly updaterOverrides?: ElectronUpdaterOverrides;
  readonly sendState?: (state: DesktopUpdateState) => Effect.Effect<void>;
}): TestHarness {
  const pushes: Array<Push> = [];
  const installOrder: Array<string> = [];
  const updater = makeElectronUpdaterHarness(options?.updaterOverrides, installOrder);

  const electronWindowLayer = Layer.succeed(
    ElectronWindow.ElectronWindow,
    ElectronWindow.ElectronWindow.of({
      create: () => Effect.die("ElectronWindow.create unused in this test"),
      loadUrl: () => Effect.void,
      currentMainOrFirst: Effect.succeed(Option.none()),
      focusedMainOrFirst: Effect.succeed(Option.none()),
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      reveal: () => Effect.void,
      send: () => Effect.void,
      sendAll: (channel, ...args) =>
        Effect.sync(() => {
          pushes.push({ channel, args });
        }).pipe(
          Effect.andThen(
            channel === UPDATE_STATE_CHANNEL && args[0] !== undefined
              ? (options?.sendState?.(args[0] as DesktopUpdateState) ?? Effect.void)
              : Effect.void,
          ),
        ),
      destroyAll: Effect.sync(() => {
        installOrder.push("destroy-windows");
      }),
      syncAllAppearance: () => Effect.void,
      onReadyToShow: () => Effect.void,
      onClosed: () => Effect.void,
      setWindowOpenHandler: () => Effect.void,
    }),
  );
  const managerLayer = Layer.succeed(
    DesktopBackendManager.DesktopBackendManager,
    DesktopBackendManager.DesktopBackendManager.of({
      start: Effect.sync(() => {
        installOrder.push("start-backend");
      }),
      stop: Effect.sync(() => {
        installOrder.push("stop-backend");
      }),
      currentConfig: Effect.succeed(Option.none()),
    }),
  );
  const desktopWindowLayer = Layer.succeed(
    DesktopWindow.DesktopWindow,
    DesktopWindow.DesktopWindow.of({
      activate: Effect.void,
      handleBackendReady: () => Effect.void,
      handleBackendNotReady: Effect.void,
      flushMainWindowBounds: Effect.sync(() => {
        installOrder.push("flush-bounds");
      }),
      dispatchMenuAction: () => Effect.void,
      syncAppearance: Effect.void,
    }),
  );
  const fileSystemLayer =
    options?.hasFeedConfig === false
      ? FileSystem.layerNoop({})
      : FileSystem.layerNoop({
          readFileString: () =>
            Effect.succeed("provider: generic\nurl: https://updates.example.test/throughline"),
        });

  const dependencies = Layer.mergeAll(
    environmentLayer(
      options?.isPackaged ?? true,
      options?.platform ?? "darwin",
      options?.appImagePath ?? Option.none(),
    ),
    DesktopState.layer,
    options?.settingsLayer ?? DesktopAppSettings.layerTest(),
    managerLayer,
    desktopWindowLayer,
    electronWindowLayer,
    updater.layer,
    fileSystemLayer,
  );

  return {
    layer: DesktopUpdater.layer.pipe(Layer.provideMerge(dependencies)),
    updater,
    pushes,
    installOrder,
  };
}

const awaitState = (
  updater: DesktopUpdater.DesktopUpdater["Service"],
  predicate: (state: DesktopUpdateState) => boolean,
) =>
  Effect.gen(function* () {
    while (true) {
      const state = yield* updater.getState;
      if (predicate(state)) {
        return state;
      }
      yield* Effect.yieldNow;
    }
  });

const expectedState = (overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.0.0",
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  ...overrides,
});

describe("DesktopUpdater", () => {
  it.effect("stays disabled in a packaged build without a real update feed", () => {
    const harness = makeTestHarness({ hasFeedConfig: false });
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      yield* updater.configure;
      assert.deepEqual(
        yield* updater.getState,
        expectedState({
          enabled: false,
          status: "disabled",
          message: "Automatic updates are unavailable because no update feed is configured.",
        }),
      );

      const check = yield* updater.check("test");
      const download = yield* updater.download;
      const install = yield* updater.install;
      assert.isFalse(check.checked);
      assert.isFalse(download.accepted);
      assert.isFalse(install.accepted);
      assert.equal(check.state.status, "disabled");
      assert.deepEqual(harness.updater.calls, { check: 0, download: 0, install: 0 });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("disables Linux updates outside the AppImage build", () => {
    const harness = makeTestHarness({ platform: "linux" });
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      yield* updater.configure;
      assert.deepEqual(
        yield* updater.getState,
        expectedState({
          enabled: false,
          status: "disabled",
          message: "Automatic updates on Linux require running the AppImage build.",
        }),
      );
      yield* updater.check("test");
      assert.equal(harness.updater.calls.check, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("enables a feed-configured Linux AppImage build", () => {
    const harness = makeTestHarness({
      platform: "linux",
      appImagePath: Option.some("/opt/Throughline.AppImage"),
    });
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      yield* updater.configure;
      assert.equal((yield* updater.getState).status, "idle");
      yield* updater.check("test");
      assert.equal(harness.updater.calls.check, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("checks immediately when switching channels and temporarily allows downgrade", () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;

      yield* updater.configure;
      assert.deepEqual(harness.updater.channelConfiguration(), {
        channel: "latest",
        allowPrerelease: false,
        allowDowngrade: false,
        fullChangelog: false,
      });

      harness.updater.emit("update-available", { version: "1.2.3" });
      yield* awaitState(updater, (state) => state.status === "available");

      const next = yield* updater.setChannel("nightly");
      assert.equal(next.status, "checking");
      assert.equal(next.channel, "nightly");
      assert.isNotNull(next.checkedAt);
      assert.equal((yield* settings.get).updateChannel, "nightly");
      assert.deepEqual(harness.updater.channelConfiguration(), {
        channel: "nightly",
        allowPrerelease: true,
        allowDowngrade: true,
        fullChangelog: true,
      });
      assert.deepEqual(harness.updater.checks, [{ channel: "nightly", allowDowngrade: true }]);

      harness.updater.emit("update-not-available");
      yield* awaitState(updater, (state) => state.status === "up-to-date");
      const stable = yield* updater.setChannel("latest");
      assert.equal(stable.channel, "latest");
      assert.equal((yield* settings.get).updateChannel, "latest");
      assert.deepEqual(harness.updater.checks, [
        { channel: "nightly", allowDowngrade: true },
        { channel: "latest", allowDowngrade: true },
      ]);
      assert.deepEqual(harness.updater.channelConfiguration(), {
        channel: "latest",
        allowPrerelease: false,
        allowDowngrade: false,
        fullChangelog: false,
      });
      assert.equal(harness.pushes.at(-1)?.channel, UPDATE_STATE_CHANNEL);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ignores releases that do not match the selected channel", () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      yield* updater.configure;
      harness.updater.emit("update-available", {
        version: "1.2.3-nightly.20260415.1",
      });
      const stableState = yield* awaitState(updater, (state) => state.status === "up-to-date");
      assert.equal(stableState.channel, "latest");
      assert.isNull(stableState.availableVersion);
      assert.isNull(stableState.message);

      harness.updater.emit("update-available", { version: "1.2.3" });
      yield* awaitState(updater, (state) => state.status === "available");
      yield* updater.setChannel("nightly");

      harness.updater.emit("update-available", { version: "1.2.4" });
      const nightlyState = yield* awaitState(updater, (state) => state.status === "up-to-date");
      assert.equal(nightlyState.channel, "nightly");
      assert.isNull(nightlyState.availableVersion);
      assert.isNull(nightlyState.message);

      harness.updater.emit("update-available", {
        version: "1.2.4-nightly.20260416.1",
      });
      assert.equal(
        (yield* awaitState(updater, (state) => state.status === "available")).availableVersion,
        "1.2.4-nightly.20260416.1",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("retains updater state when the selected channel cannot be persisted", () => {
    const cause = new DesktopAppSettings.DesktopSettingsWriteError({
      path: "/read-only/desktop-settings.json",
      cause: new Error("read-only filesystem"),
    });
    const initialSettings = DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS;
    const settingsLayer = Layer.succeed(
      DesktopAppSettings.DesktopAppSettings,
      DesktopAppSettings.DesktopAppSettings.of({
        load: Effect.succeed(initialSettings),
        get: Effect.succeed(initialSettings),
        setMainWindowBounds: () => Effect.succeed({ settings: initialSettings, changed: false }),
        setTheme: () => Effect.succeed({ settings: initialSettings, changed: false }),
        setUpdateChannel: () => Effect.fail(cause),
      }),
    );
    const harness = makeTestHarness({ settingsLayer });

    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      yield* updater.configure;
      const before = yield* updater.getState;
      const channelConfiguration = harness.updater.channelConfiguration();
      const error = yield* Effect.flip(updater.setChannel("nightly"));

      assert.instanceOf(error, DesktopUpdater.DesktopUpdateChannelPersistenceError);
      assert.strictEqual(error.cause, cause);
      assert.deepEqual(yield* updater.getState, before);
      assert.deepEqual(harness.updater.channelConfiguration(), channelConfiguration);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a downloaded update install-ready when a channel switch is requested", () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;

      yield* updater.configure;
      harness.updater.emit("update-downloaded", { version: "1.2.3" });
      const downloaded = yield* awaitState(updater, (state) => state.status === "downloaded");

      assert.deepEqual(yield* updater.setChannel("nightly"), downloaded);
      assert.deepEqual(yield* updater.getState, downloaded);
      assert.equal((yield* settings.get).updateChannel, "latest");
      assert.equal(harness.updater.calls.check, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("configures the channel loaded by settings startup", () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;

      yield* settings.setUpdateChannel("nightly");
      yield* updater.configure;

      assert.equal((yield* updater.getState).channel, "nightly");
      assert.deepEqual(harness.updater.channelConfiguration(), {
        channel: "nightly",
        allowPrerelease: true,
        allowDowngrade: true,
        fullChangelog: true,
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("checks after startup and on the periodic cadence while updates are idle", () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      const desktopState = yield* DesktopState.DesktopState;

      yield* updater.configure;
      yield* TestClock.adjust("14 seconds");
      assert.equal(harness.updater.calls.check, 0);

      yield* TestClock.adjust("1 second");
      assert.equal(harness.updater.calls.check, 1);
      harness.updater.emit("update-not-available");
      yield* awaitState(updater, (state) => state.status === "up-to-date");

      yield* TestClock.adjust("4 minutes");
      assert.equal(harness.updater.calls.check, 2);
      harness.updater.emit("update-not-available");
      yield* awaitState(updater, (state) => state.status === "up-to-date");

      yield* Ref.set(desktopState.quitting, true);
      yield* TestClock.adjust("4 minutes");
      assert.equal(harness.updater.calls.check, 2);
      yield* Ref.set(desktopState.quitting, false);
      harness.updater.emit("update-downloaded", { version: "1.2.3" });
      yield* awaitState(updater, (state) => state.status === "downloaded");
      yield* TestClock.adjust("4 minutes");
      assert.equal(harness.updater.calls.check, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("continues periodic checks after a one-time startup poller defect", () => {
    let failedCheckingPush = false;
    const harness = makeTestHarness({
      sendState: (state) => {
        if (state.status !== "checking" || failedCheckingPush) {
          return Effect.void;
        }
        failedCheckingPush = true;
        return Effect.die("one-time update state push defect");
      },
    });
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      yield* updater.configure;
      yield* TestClock.adjust("15 seconds");
      assert.equal(harness.updater.calls.check, 0);

      yield* TestClock.adjust("225 seconds");
      assert.equal(harness.updater.calls.check, 1);
      assert.deepEqual(harness.updater.checks, [{ channel: "latest", allowDowngrade: false }]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("accepts download and install only from their valid states", () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      const desktopState = yield* DesktopState.DesktopState;

      yield* updater.configure;
      const rejectedDownload = yield* updater.download;
      yield* updater.install;
      assert.isFalse(rejectedDownload.accepted);
      assert.deepEqual(harness.updater.calls, { check: 0, download: 0, install: 0 });

      harness.updater.emit("update-available", { version: "1.2.3" });
      yield* awaitState(updater, (state) => state.status === "available");
      const download = yield* updater.download;
      assert.isTrue(download.accepted);
      assert.isTrue(download.completed);
      assert.equal(harness.updater.calls.download, 1);
      assert.equal((yield* updater.getState).status, "downloading");

      const rejectedInstall = yield* updater.install;
      assert.isFalse(rejectedInstall.accepted);
      assert.equal(harness.updater.calls.install, 0);

      harness.updater.emit("update-downloaded", { version: "1.2.3" });
      yield* awaitState(updater, (state) => state.status === "downloaded");
      const install = yield* updater.install;

      assert.deepEqual(harness.installOrder, [
        "flush-bounds",
        "stop-backend",
        "destroy-windows",
        "quit-and-install",
      ]);
      assert.equal(harness.updater.calls.install, 1);
      assert.isTrue(install.accepted);
      assert.isFalse(install.completed);
      assert.isTrue(yield* Ref.get(desktopState.quitting));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("restores the available update when a download is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const neverCompletes = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      const harness = makeTestHarness({
        updaterOverrides: { downloadUpdate: neverCompletes },
      });

      yield* Effect.gen(function* () {
        const updater = yield* DesktopUpdater.DesktopUpdater;

        yield* updater.configure;
        harness.updater.emit("update-available", { version: "1.2.3" });
        const available = yield* awaitState(updater, (state) => state.status === "available");
        const downloadFiber = yield* Effect.forkChild(updater.download);
        yield* Deferred.await(started);
        assert.equal((yield* updater.getState).status, "downloading");

        yield* Fiber.interrupt(downloadFiber);
        assert.deepEqual(yield* updater.getState, available);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps raw updater errors and credential URLs out of renderer state", () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      yield* updater.configure;
      harness.updater.emit(
        "error",
        new Error("request failed for https://build-user:secret-token@updates.example.test/feed"),
      );
      const state = yield* awaitState(updater, (current) => current.status === "error");

      assert.equal(
        state.message,
        "Throughline's updater encountered an unexpected error. Try again.",
      );
      assert.notInclude(JSON.stringify(harness.pushes), "secret-token");
      assert.notInclude(JSON.stringify(state), "updates.example.test");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("preserves install-ready state after an unrelated background updater error", () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      yield* updater.configure;
      harness.updater.emit("update-downloaded", { version: "1.2.3" });
      yield* awaitState(updater, (state) => state.status === "downloaded");
      harness.updater.emit("error", new Error("background update service stopped"));
      const recovered = yield* awaitState(
        updater,
        (state) =>
          state.status === "downloaded" &&
          state.message === "Throughline's updater encountered an unexpected error. Try again.",
      );

      assert.equal(recovered.downloadedVersion, "1.2.3");
      assert.isTrue(recovered.canRetry);
      assert.isTrue((yield* updater.install).accepted);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("restores install state when quit-and-install fails", () => {
    const harness = makeTestHarness({
      updaterOverrides: {
        quitAndInstall: ({ isSilent, isForceRunAfter }) =>
          Effect.fail(
            new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
              channel: "latest",
              isSilent,
              isForceRunAfter,
              cause: new Error("https://build-user:secret-token@updates.example.test/feed"),
            }),
          ),
      },
    });
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      const desktopState = yield* DesktopState.DesktopState;

      yield* updater.configure;
      harness.updater.emit("update-downloaded", { version: "1.2.3" });
      yield* awaitState(updater, (state) => state.status === "downloaded");
      yield* updater.install;

      assert.deepEqual(harness.installOrder, [
        "flush-bounds",
        "stop-backend",
        "destroy-windows",
        "quit-and-install",
        "start-backend",
      ]);
      assert.isFalse(yield* Ref.get(desktopState.quitting));
      assert.deepEqual(
        yield* updater.getState,
        expectedState({
          status: "downloaded",
          availableVersion: "1.2.3",
          downloadedVersion: "1.2.3",
          downloadPercent: 100,
          message: "Throughline could not install the downloaded update. Try again.",
          errorContext: "install",
          canRetry: true,
        }),
      );
      assert.notInclude(JSON.stringify(harness.pushes), "secret-token");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("recovers the host when electron-updater reports an install error", () =>
    Effect.gen(function* () {
      const installStarted = yield* Deferred.make<void>();
      const releaseInstall = yield* Deferred.make<void>();
      const harness = makeTestHarness({
        updaterOverrides: {
          quitAndInstall: () =>
            Deferred.succeed(installStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseInstall)),
            ),
        },
      });

      yield* Effect.gen(function* () {
        const updater = yield* DesktopUpdater.DesktopUpdater;
        const desktopState = yield* DesktopState.DesktopState;

        yield* updater.configure;
        harness.updater.emit("update-downloaded", { version: "1.2.3" });
        yield* awaitState(updater, (state) => state.status === "downloaded");
        const installFiber = yield* Effect.forkChild(updater.install);
        yield* Deferred.await(installStarted);

        harness.updater.emit("error", new Error("installer exited before app shutdown"));
        const recovered = yield* awaitState(
          updater,
          (state) =>
            state.status === "downloaded" &&
            state.message === "Throughline could not install the downloaded update. Try again.",
        );
        assert.equal(recovered.downloadedVersion, "1.2.3");
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installOrder, [
          "flush-bounds",
          "stop-backend",
          "destroy-windows",
          "quit-and-install",
          "start-backend",
        ]);

        yield* Deferred.succeed(releaseInstall, undefined);
        yield* Fiber.join(installFiber);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("recovers the host when the install error arrives after quit-and-install returns", () =>
    Effect.gen(function* () {
      const harness = makeTestHarness();

      yield* Effect.gen(function* () {
        const updater = yield* DesktopUpdater.DesktopUpdater;
        const desktopState = yield* DesktopState.DesktopState;

        yield* updater.configure;
        harness.updater.emit("update-downloaded", { version: "1.2.3" });
        yield* awaitState(updater, (state) => state.status === "downloaded");
        yield* updater.install;

        assert.isTrue(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installOrder, [
          "flush-bounds",
          "stop-backend",
          "destroy-windows",
          "quit-and-install",
        ]);

        harness.updater.emit("error", new Error("installer launch failed after returning"));
        const recovered = yield* awaitState(
          updater,
          (state) =>
            state.status === "downloaded" &&
            state.message === "Throughline could not install the downloaded update. Try again.",
        );

        assert.equal(recovered.downloadedVersion, "1.2.3");
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installOrder, [
          "flush-bounds",
          "stop-backend",
          "destroy-windows",
          "quit-and-install",
          "start-backend",
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("restores install state when installation is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = makeTestHarness({
        updaterOverrides: {
          quitAndInstall: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        },
      });

      yield* Effect.gen(function* () {
        const updater = yield* DesktopUpdater.DesktopUpdater;
        const desktopState = yield* DesktopState.DesktopState;

        yield* updater.configure;
        harness.updater.emit("update-downloaded", { version: "1.2.3" });
        const downloaded = yield* awaitState(updater, (state) => state.status === "downloaded");
        const installFiber = yield* Effect.forkChild(updater.install);
        yield* Deferred.await(started);
        assert.isTrue(yield* Ref.get(desktopState.quitting));

        yield* Fiber.interrupt(installFiber);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(yield* updater.getState, downloaded);
        assert.deepEqual(harness.installOrder, [
          "flush-bounds",
          "stop-backend",
          "destroy-windows",
          "quit-and-install",
          "start-backend",
        ]);
        assert.deepEqual(yield* updater.setChannel("latest"), downloaded);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses overlapping actions and channel switches", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const harness = makeTestHarness({
        updaterOverrides: {
          checkForUpdates: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        },
      });

      yield* Effect.gen(function* () {
        const updater = yield* DesktopUpdater.DesktopUpdater;

        yield* updater.configure;
        const checkFiber = yield* Effect.forkChild(updater.check("test"));
        yield* Deferred.await(started);

        yield* updater.download;
        assert.equal((yield* updater.getState).status, "checking");
        const error = yield* Effect.flip(updater.setChannel("nightly"));
        assert.instanceOf(error, DesktopUpdater.DesktopUpdateActionInProgressError);
        assert.equal(error.action, "check");

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(checkFiber);
        assert.equal((yield* updater.setChannel("nightly")).channel, "nightly");
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
