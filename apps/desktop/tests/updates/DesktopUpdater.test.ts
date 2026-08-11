import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopState from "../../src/app/DesktopState.ts";
import * as DesktopBackendManager from "../../src/backend/DesktopBackendManager.ts";
import * as ElectronUpdater from "../../src/electron/ElectronUpdater.ts";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
import { UPDATE_STATE_CHANNEL } from "../../src/ipc/channels.ts";
import * as DesktopAppSettings from "../../src/settings/DesktopAppSettings.ts";
import * as DesktopUpdater from "../../src/updates/DesktopUpdater.ts";

interface Push {
  readonly channel: string;
  readonly args: ReadonlyArray<unknown>;
}

const fakeElectronWindowLayer = (pushes: Array<Push>, destroyed?: Array<true>) =>
  Layer.succeed(
    ElectronWindow.ElectronWindow,
    ElectronWindow.ElectronWindow.of({
      create: () => Effect.die("ElectronWindow.create unused in this test"),
      currentMainOrFirst: Effect.succeed(Option.none()),
      focusedMainOrFirst: Effect.succeed(Option.none()),
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      reveal: () => Effect.void,
      send: () => Effect.void,
      sendAll: (channel, ...args) =>
        Effect.sync(() => {
          pushes.push({ channel, args });
        }),
      destroyAll: Effect.sync(() => {
        destroyed?.push(true);
      }),
      allDisplayBounds: Effect.succeed([]),
      syncAllAppearance: () => Effect.void,
      onReadyToShow: () => Effect.void,
      onClosed: () => Effect.void,
      setWindowOpenHandler: () => Effect.void,
    }),
  );

interface ChannelCall {
  readonly channel: string;
  readonly allowPrerelease: boolean;
  readonly allowDowngrade: boolean;
  readonly fullChangelog: boolean;
}

interface UpdaterOverrides {
  readonly checkForUpdates?: Effect.Effect<void>;
  readonly downloadUpdate?: Effect.Effect<void>;
  readonly quitAndInstall?: Effect.Effect<void>;
}

const fakeElectronUpdaterLayer = (
  overrides?: UpdaterOverrides,
  channelCalls?: Array<ChannelCall>,
  quitCalls?: Array<true>,
) =>
  Layer.effect(
    ElectronUpdater.ElectronUpdater,
    Effect.gen(function* () {
      const pending = yield* Ref.make<Partial<ChannelCall>>({});
      const record = (patch: Partial<ChannelCall>) =>
        Ref.update(pending, (current) => {
          const next = { ...current, ...patch };
          if (
            next.channel !== undefined &&
            next.allowPrerelease !== undefined &&
            next.allowDowngrade !== undefined &&
            next.fullChangelog !== undefined
          ) {
            channelCalls?.push(next as ChannelCall);
            return {};
          }
          return next;
        });

      return ElectronUpdater.ElectronUpdater.of({
        setFeedURL: () => Effect.void,
        setAutoDownload: () => Effect.void,
        setAutoInstallOnAppQuit: () => Effect.void,
        setChannel: (channel) => record({ channel }),
        setAllowPrerelease: (allowPrerelease) => record({ allowPrerelease }),
        allowDowngrade: Effect.succeed(false),
        setAllowDowngrade: (allowDowngrade) => record({ allowDowngrade }),
        setFullChangelog: (fullChangelog) => record({ fullChangelog }),
        setDisableDifferentialDownload: () => Effect.void,
        checkForUpdates: overrides?.checkForUpdates ?? Effect.void,
        downloadUpdate: overrides?.downloadUpdate ?? Effect.void,
        quitAndInstall: () =>
          Effect.sync(() => {
            quitCalls?.push(true);
          }).pipe(Effect.andThen(overrides?.quitAndInstall ?? Effect.void)),
        on: () => Effect.void,
      });
    }),
  );

const fakeBackendManagerLayer = (stops?: Array<true>) =>
  Layer.succeed(
    DesktopBackendManager.DesktopBackendManager,
    DesktopBackendManager.DesktopBackendManager.of({
      start: Effect.void,
      stop: () =>
        Effect.sync(() => {
          stops?.push(true);
        }),
      currentConfig: Effect.succeed(Option.none()),
    }),
  );

const environmentLayer = (input: {
  readonly isPackaged: boolean;
  readonly platform?: NodeJS.Platform;
  readonly appVersion?: string;
  readonly appImagePath?: Option.Option<string>;
  readonly disableAutoUpdate?: boolean;
}) =>
  Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.makeWith(
        {
          dirname: "/app/apps/desktop/dist-electron",
          homeDirectory: "/home/user",
          platform: input.platform ?? "darwin",
          appVersion: input.appVersion ?? "0.0.0",
          appPath: "/app",
          isPackaged: input.isPackaged,
          resourcesPath: "/app/resources",
          appDataDirectory: Option.none(),
          xdgConfigHome: Option.none(),
          serverEntryOverride: Option.none(),
          logDirOverride: Option.none(),
          logLevel: Option.none(),
          otlpTracesUrl: Option.none(),
          otlpExportIntervalMs: Option.none(),
          configuredBackendPort: Option.none(),
          devServerUrl: Option.none(),
          processArch: "arm64",
          runningUnderArm64Translation: false,
          appImagePath: input.appImagePath ?? Option.none(),
          disableAutoUpdate: input.disableAutoUpdate ?? false,
        },
        path,
      ),
    ),
  ).pipe(Layer.provide(Path.layer));

// A feed exists only when app-update.yml actually names a provider; an empty or
// truncated file must read as "no feed", not as a configured one.
const fakeFileSystemLayer = (yml: string | null) =>
  yml === null
    ? FileSystem.layerNoop({})
    : FileSystem.layerNoop({ readFileString: () => Effect.succeed(yml) });

const FEED_YML = "provider: github\nowner: example\nrepo: throughline\n";

const testLayer = (options: {
  readonly isPackaged: boolean;
  readonly pushes?: Array<Push>;
  readonly updaterOverrides?: UpdaterOverrides;
  readonly yml?: string | null;
  readonly channelCalls?: Array<ChannelCall>;
  readonly quitCalls?: Array<true>;
  readonly backendStops?: Array<true>;
  readonly destroyedWindows?: Array<true>;
  readonly platform?: NodeJS.Platform;
  readonly appVersion?: string;
  readonly appImagePath?: Option.Option<string>;
  readonly disableAutoUpdate?: boolean;
}) =>
  DesktopUpdater.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        environmentLayer({
          isPackaged: options.isPackaged,
          ...(options.platform === undefined ? {} : { platform: options.platform }),
          ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
          ...(options.appImagePath === undefined ? {} : { appImagePath: options.appImagePath }),
          ...(options.disableAutoUpdate === undefined
            ? {}
            : { disableAutoUpdate: options.disableAutoUpdate }),
        }),
        // Seeded the way `DesktopAppSettings.make` seeds itself in production —
        // from the running build's defaults, not the static constant.
        DesktopAppSettings.layerTest(
          DesktopAppSettings.resolveDefaultDesktopSettings(options.appVersion ?? "0.0.0"),
        ),
        DesktopState.layer,
        fakeElectronWindowLayer(options.pushes ?? [], options.destroyedWindows),
        fakeElectronUpdaterLayer(options.updaterOverrides, options.channelCalls, options.quitCalls),
        fakeBackendManagerLayer(options.backendStops),
        fakeFileSystemLayer(options.yml === undefined ? FEED_YML : options.yml),
      ),
    ),
  );

describe("DesktopUpdater", () => {
  it.effect("stays disabled and inert when the app is not packaged", () =>
    Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      yield* updater.configure;

      assert.equal((yield* updater.getState).status, "disabled");
      assert.isTrue(Option.isSome(yield* updater.disabledReason));

      const check = yield* updater.check("test");
      const download = yield* updater.download;
      const install = yield* updater.install;

      assert.isFalse(check.checked);
      assert.isFalse(download.accepted);
      assert.isFalse(install.accepted);
      assert.equal((yield* updater.getState).status, "disabled");
    }).pipe(Effect.provide(testLayer({ isPackaged: false }))),
  );

  it.effect("stays disabled when packaged without an app-update.yml feed", () =>
    Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      yield* updater.configure;

      assert.equal((yield* updater.getState).status, "disabled");
      assert.deepEqual(
        yield* updater.disabledReason,
        Option.some("Automatic updates are not available because no update feed is configured."),
      );
    }).pipe(Effect.provide(testLayer({ isPackaged: true, yml: null }))),
  );

  it.effect("treats an app-update.yml without a provider as no feed", () =>
    Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      yield* updater.configure;

      assert.isTrue(Option.isSome(yield* updater.disabledReason));
      assert.equal((yield* updater.getState).status, "disabled");
    }).pipe(Effect.provide(testLayer({ isPackaged: true, yml: "owner: example\n" }))),
  );

  it.effect("refuses to update a Linux build that is not an AppImage", () =>
    Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      yield* updater.configure;

      assert.deepEqual(
        yield* updater.disabledReason,
        Option.some("Automatic updates on Linux require running the AppImage build."),
      );
    }).pipe(Effect.provide(testLayer({ isPackaged: true, platform: "linux" }))),
  );

  it.effect("enables updates for a Linux AppImage build", () =>
    Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      yield* updater.configure;

      assert.isTrue(Option.isNone(yield* updater.disabledReason));
      assert.equal((yield* updater.getState).status, "idle");
    }).pipe(
      Effect.provide(
        testLayer({
          isPackaged: true,
          platform: "linux",
          appImagePath: Option.some("/tmp/Throughline.AppImage"),
        }),
      ),
    ),
  );

  it.effect("honours the APP_DISABLE_AUTO_UPDATE kill switch", () =>
    Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      yield* updater.configure;

      assert.deepEqual(
        yield* updater.disabledReason,
        Option.some("Automatic updates are disabled by the APP_DISABLE_AUTO_UPDATE setting."),
      );
    }).pipe(Effect.provide(testLayer({ isPackaged: true, disableAutoUpdate: true }))),
  );

  it.effect("defaults a nightly build to the nightly channel", () =>
    Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      yield* updater.configure;

      assert.equal((yield* updater.getState).channel, "nightly");
    }).pipe(
      Effect.provide(testLayer({ isPackaged: true, appVersion: "1.2.3-nightly.20260811.1" })),
    ),
  );

  // The regression this guards: `install` used to run unconditionally, so a
  // renderer calling it in any state stopped the backend, destroyed every
  // window and quit — with nothing staged to install.
  it.effect("refuses to install when no update has been downloaded", () => {
    const quitCalls: Array<true> = [];
    const backendStops: Array<true> = [];
    const destroyedWindows: Array<true> = [];
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      yield* updater.configure;

      const result = yield* updater.install;

      assert.isFalse(result.accepted);
      assert.isFalse(result.completed);
      assert.deepEqual(quitCalls, []);
      assert.deepEqual(backendStops, []);
      assert.deepEqual(destroyedWindows, []);
    }).pipe(
      Effect.provide(testLayer({ isPackaged: true, quitCalls, backendStops, destroyedWindows })),
    );
  });

  it.effect("refuses to download when no update is available", () =>
    Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      yield* updater.configure;

      const result = yield* updater.download;

      assert.isFalse(result.accepted);
      assert.equal((yield* updater.getState).status, "idle");
    }).pipe(Effect.provide(testLayer({ isPackaged: true }))),
  );

  it.effect("refuses every action before configure has run", () =>
    Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      assert.isFalse((yield* updater.check("test")).checked);
      assert.isFalse((yield* updater.download).accepted);
      assert.isFalse((yield* updater.install).accepted);
    }).pipe(Effect.provide(testLayer({ isPackaged: true }))),
  );

  it.effect("setChannel persists the choice and pushes it to the renderer", () => {
    const pushes: Array<Push> = [];
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      yield* updater.configure;

      const next = yield* updater.setChannel("nightly");
      assert.equal(next.channel, "nightly");

      assert.equal((yield* settings.get).updateChannel, "nightly");
      assert.isTrue((yield* settings.get).updateChannelConfiguredByUser);
      const last = pushes.at(-1);
      assert.equal(last?.channel, UPDATE_STATE_CHANNEL);
    }).pipe(Effect.provide(testLayer({ isPackaged: false, pushes })));
  });

  it.effect("refuses overlapping actions and channel switches while one is in flight", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const checkCalls = yield* Ref.make(0);
      const layer = testLayer({
        isPackaged: true,
        updaterOverrides: {
          checkForUpdates: Ref.update(checkCalls, (count) => count + 1).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        },
      });

      yield* Effect.gen(function* () {
        const updater = yield* DesktopUpdater.DesktopUpdater;
        yield* updater.configure;

        const checkFiber = yield* Effect.forkChild(updater.check("test"));
        yield* Effect.gen(function* () {
          while ((yield* Ref.get(checkCalls)) < 1) {
            yield* Effect.yieldNow;
          }
        });

        assert.isFalse((yield* updater.download).accepted);
        assert.equal((yield* updater.getState).status, "checking");

        const error = yield* Effect.flip(updater.setChannel("nightly"));
        assert.instanceOf(error, DesktopUpdater.DesktopUpdateActionInProgressError);
        assert.equal(error.action, "check");

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(checkFiber);

        const next = yield* updater.setChannel("nightly");
        assert.equal(next.channel, "nightly");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("selecting nightly allows prereleases, downgrades and the full changelog", () => {
    const channelCalls: Array<ChannelCall> = [];
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      yield* updater.configure;
      channelCalls.length = 0;

      yield* updater.setChannel("nightly");
      assert.deepEqual(channelCalls.at(0), {
        channel: "nightly",
        allowPrerelease: true,
        allowDowngrade: true,
        fullChangelog: true,
      });

      yield* updater.setChannel("latest");
      assert.deepEqual(channelCalls.at(-1), {
        channel: "latest",
        allowPrerelease: false,
        allowDowngrade: false,
        fullChangelog: false,
      });
    }).pipe(Effect.provide(testLayer({ isPackaged: true, channelCalls })));
  });

  it.effect("switching channels resets the state discovered on the old one", () =>
    Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      yield* updater.configure;

      const next = yield* updater.setChannel("nightly");

      assert.equal(next.availableVersion, null);
      assert.equal(next.downloadedVersion, null);
      assert.equal(next.message, null);
      assert.equal(next.errorContext, null);
    }).pipe(Effect.provide(testLayer({ isPackaged: true }))),
  );

  it("broadcasts download progress only on a 10% step change or at completion", () => {
    const downloading = {
      enabled: true,
      status: "downloading",
      channel: "latest",
      currentVersion: "1.0.0",
      hostArch: "arm64",
      appArch: "arm64",
      runningUnderArm64Translation: false,
      availableVersion: "1.1.0",
      downloadedVersion: null,
      downloadPercent: 41,
      checkedAt: null,
      message: null,
      errorContext: null,
      canRetry: false,
    } as const;

    assert.isFalse(DesktopUpdater.shouldBroadcastDownloadProgress(downloading, 42));
    assert.isTrue(DesktopUpdater.shouldBroadcastDownloadProgress(downloading, 50));
    assert.isTrue(DesktopUpdater.shouldBroadcastDownloadProgress(downloading, 100));
    assert.isTrue(
      DesktopUpdater.shouldBroadcastDownloadProgress({ ...downloading, downloadPercent: null }, 1),
    );
    assert.isTrue(
      DesktopUpdater.shouldBroadcastDownloadProgress({ ...downloading, status: "available" }, 1),
    );
  });

  it("disables differential downloads for an Intel build on an Apple Silicon host", () => {
    assert.isTrue(
      DesktopUpdater.isArm64HostRunningIntelBuild({
        hostArch: "arm64",
        appArch: "x64",
        runningUnderArm64Translation: true,
      }),
    );
    assert.isFalse(
      DesktopUpdater.isArm64HostRunningIntelBuild({
        hostArch: "arm64",
        appArch: "arm64",
        runningUnderArm64Translation: false,
      }),
    );
  });
});
