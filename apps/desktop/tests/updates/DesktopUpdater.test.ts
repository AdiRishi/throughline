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

const fakeElectronWindowLayer = (pushes: Array<Push>) =>
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
      destroyAll: Effect.void,
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

const fakeElectronUpdaterLayer = (
  overrides?: {
    readonly checkForUpdates?: Effect.Effect<void>;
  },
  channelCalls?: Array<ChannelCall>,
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
        downloadUpdate: Effect.void,
        quitAndInstall: () => Effect.void,
        on: () => Effect.void,
      });
    }),
  );

const fakeBackendManagerLayer = Layer.succeed(
  DesktopBackendManager.DesktopBackendManager,
  DesktopBackendManager.DesktopBackendManager.of({
    start: Effect.void,
    stop: Effect.void,
    currentConfig: Effect.succeed(Option.none()),
  }),
);

const environmentLayer = (isPackaged: boolean) =>
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
          isPackaged,
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
        },
        path,
      ),
    ),
  ).pipe(Layer.provide(Path.layer));

const fakeFileSystemLayer = (hasUpdateFeed: boolean) =>
  FileSystem.layerNoop({ exists: () => Effect.succeed(hasUpdateFeed) });

const testLayer = (
  isPackaged: boolean,
  pushes: Array<Push>,
  updaterOverrides?: Parameters<typeof fakeElectronUpdaterLayer>[0],
  hasUpdateFeed = true,
  channelCalls?: Array<ChannelCall>,
) =>
  DesktopUpdater.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        environmentLayer(isPackaged),
        DesktopAppSettings.layerTest(),
        fakeElectronWindowLayer(pushes),
        fakeElectronUpdaterLayer(updaterOverrides, channelCalls),
        fakeBackendManagerLayer,
        fakeFileSystemLayer(hasUpdateFeed),
      ),
    ),
  );

describe("DesktopUpdater", () => {
  it.effect("stays disabled and inert when the app is not packaged", () => {
    const pushes: Array<Push> = [];
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      assert.equal((yield* updater.getState).status, "disabled");

      yield* updater.check;
      yield* updater.download;
      yield* updater.install;
      assert.equal((yield* updater.getState).status, "disabled");
    }).pipe(Effect.provide(testLayer(false, pushes)));
  });

  it.effect("stays disabled when packaged without an app-update.yml feed", () => {
    const pushes: Array<Push> = [];
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      assert.equal((yield* updater.getState).status, "disabled");
      yield* updater.check;
      assert.equal((yield* updater.getState).status, "disabled");
    }).pipe(Effect.provide(testLayer(true, pushes, undefined, false)));
  });

  it.effect("setChannel persists the choice and pushes it to the renderer", () => {
    const pushes: Array<Push> = [];
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;

      const next = yield* updater.setChannel("nightly");
      assert.equal(next.channel, "nightly");

      assert.equal((yield* settings.get).updateChannel, "nightly");
      const last = pushes.at(-1);
      assert.equal(last?.channel, UPDATE_STATE_CHANNEL);
    }).pipe(Effect.provide(testLayer(false, pushes)));
  });

  it.effect("refuses overlapping actions and channel switches while one is in flight", () =>
    Effect.gen(function* () {
      const pushes: Array<Push> = [];
      const release = yield* Deferred.make<void>();
      const checkCalls = yield* Ref.make(0);
      const layer = testLayer(true, pushes, {
        checkForUpdates: Ref.update(checkCalls, (count) => count + 1).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });

      yield* Effect.gen(function* () {
        const updater = yield* DesktopUpdater.DesktopUpdater;

        const checkFiber = yield* Effect.forkChild(updater.check);
        yield* Effect.gen(function* () {
          while ((yield* Ref.get(checkCalls)) < 1) {
            yield* Effect.yieldNow;
          }
        });

        yield* updater.download;
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
    const pushes: Array<Push> = [];
    const channelCalls: Array<ChannelCall> = [];
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      yield* updater.setChannel("nightly");
      assert.deepEqual(channelCalls, [
        {
          channel: "nightly",
          allowPrerelease: true,
          allowDowngrade: true,
          fullChangelog: true,
        },
      ]);

      yield* updater.setChannel("latest");
      assert.deepEqual(channelCalls.at(-1), {
        channel: "latest",
        allowPrerelease: false,
        allowDowngrade: false,
        fullChangelog: false,
      });
    }).pipe(Effect.provide(testLayer(true, pushes, undefined, true, channelCalls)));
  });

  it("broadcasts download progress only on a 10% step change or at completion", () => {
    const downloading = {
      enabled: true,
      status: "downloading",
      channel: "latest",
      currentVersion: "1.0.0",
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
});
