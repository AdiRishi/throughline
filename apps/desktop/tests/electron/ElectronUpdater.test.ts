import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vitest";

type DownloadUpdateMock = () => Promise<ReadonlyArray<string>>;

const { autoUpdaterMock } = vi.hoisted(() => ({
  autoUpdaterMock: {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    channel: "latest",
    fullChangelog: false,
    checkForUpdates: vi.fn<() => Promise<null>>(() => Promise.resolve(null)),
    downloadUpdate: vi.fn<DownloadUpdateMock>(() => Promise.resolve([])),
    on: vi.fn<(eventName: string, listener: (...args: Array<unknown>) => void) => void>(),
    quitAndInstall: vi.fn<(isSilent: boolean, isForceRunAfter: boolean) => void>(),
    removeListener:
      vi.fn<(eventName: string, listener: (...args: Array<unknown>) => void) => void>(),
    setFeedURL: vi.fn<(options: unknown) => void>(),
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

import * as ElectronUpdater from "../../src/electron/ElectronUpdater.ts";

describe("ElectronUpdater", () => {
  beforeEach(() => {
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = true;
    autoUpdaterMock.autoInstallOnAppQuit = true;
    autoUpdaterMock.channel = "latest";
    autoUpdaterMock.fullChangelog = false;
    autoUpdaterMock.checkForUpdates.mockClear();
    autoUpdaterMock.checkForUpdates.mockImplementation(() => Promise.resolve(null));
    autoUpdaterMock.downloadUpdate.mockClear();
    autoUpdaterMock.downloadUpdate.mockImplementation(() => Promise.resolve([]));
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockClear();
    autoUpdaterMock.removeListener.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
  });

  it.effect("scopes updater event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn<(...args: Array<unknown>) => void>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.on("update-available", listener);
        }),
      );

      assert.deepEqual(autoUpdaterMock.on.mock.calls, [["update-available", listener]]);
      assert.deepEqual(autoUpdaterMock.removeListener.mock.calls, [["update-available", listener]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("wraps rejected update checks without exposing the raw cause", () =>
    Effect.gen(function* () {
      const cause = new Error("https://build-user:secret-token@updates.example.test/feed");
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "nightly";

      const error = yield* updater.checkForUpdates.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterCheckForUpdatesError);
      assert.isTrue(ElectronUpdater.isElectronUpdaterError(error));
      assert.equal(error.channel, "nightly");
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to check for updates on channel nightly.",
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("sets prerelease, downgrade, and full-changelog behavior", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.setAllowPrerelease(true);
      yield* updater.setAllowDowngrade(true);
      yield* updater.setFullChangelog(true);
      assert.isTrue(autoUpdaterMock.allowPrerelease);
      assert.isTrue(yield* updater.allowDowngrade);
      assert.isTrue(autoUpdaterMock.allowDowngrade);
      assert.isTrue(autoUpdaterMock.fullChangelog);

      yield* updater.setAllowPrerelease(false);
      yield* updater.setAllowDowngrade(false);
      yield* updater.setFullChangelog(false);
      assert.isFalse(autoUpdaterMock.allowPrerelease);
      assert.isFalse(yield* updater.allowDowngrade);
      assert.isFalse(autoUpdaterMock.allowDowngrade);
      assert.isFalse(autoUpdaterMock.fullChangelog);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves quit-and-install flags and the execution-time channel", () =>
    Effect.gen(function* () {
      const cause = new Error("quit and install failed");
      autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
        throw cause;
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "nightly";

      const error = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: false })
        .pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
      assert.isTrue(ElectronUpdater.isElectronUpdaterError(error));
      assert.equal(error.channel, "nightly");
      assert.equal(error.isSilent, true);
      assert.equal(error.isForceRunAfter, false);
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, false]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
